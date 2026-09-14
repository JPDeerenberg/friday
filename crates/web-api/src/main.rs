//! Stateless Friday web API.
//!
//! Core mode: no sessions, no database. Every request carries the browser's
//! own Magister tokens; the server only forwards (Tier A), exchanges codes,
//! or proxies auth grants. See plan v2.
//!
//! Routes (same-origin `/api` prefix; set `VITE_API_URL` for split hosting):
//! - `GET  /health`
//! - `POST /api/auth/login`    password-form login → token set (rate-limited)
//! - `POST /api/auth/refresh`  refresh_token grant → fresh token set
//! - `POST /api/auth/logout`   no-op acknowledgement (stateless)
//! - `ANY  /api/magister/*`    Tier-A generic proxy

mod ai;
mod auth;
mod proxy;
mod ratelimit;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, RawQuery, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
struct AppState {
    /// Redirect-disabled client for the login/authorize dance.
    no_redirect: reqwest::Client,
    /// Default client for token grants + proxying (30s timeout).
    http: reqwest::Client,
    login_limiter: Arc<Mutex<ratelimit::RateLimiter>>,
}

use std::sync::atomic::{AtomicU64, Ordering};

static REQ_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Short correlation ID matching a client-visible error to server logs.
/// Nanos + atomic counter, base32 (no confusables). Contains no secrets —
/// safe to show users and store in Render logs.
fn new_ref() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let mut x = nanos.wrapping_add(REQ_COUNTER.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E3779B97F4A7C15));
    const CHARS: &[u8] = b"0123456789abcdefghijkmnopqrstuvwxyz"; // no l
    let mut s = String::with_capacity(8);
    for _ in 0..8 {
        s.push(CHARS[(x & 31) as usize] as char);
        x >>= 5;
    }
    s
}

fn error_json(status: StatusCode, message: &str, ref_: &str) -> axum::response::Response {
    (
        status,
        Json(serde_json::json!({ "error": message, "ref": ref_ })),
    )
        .into_response()
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

#[derive(Debug, serde::Deserialize)]
struct LoginBody {
    school: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

#[axum::debug_handler]
async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<LoginBody>,
) -> impl IntoResponse {
    let username = body.username.unwrap_or_default();
    // Generous per-pair limit (school NATs share one IP at period change),
    // strict enough to blunt credential stuffing. Usernames are hashed into
    // the key — never logged.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    username.hash(&mut hasher);
    let key = format!("login:{}:{:x}", addr.ip(), hasher.finish());
    if !state.login_limiter.lock().await.check(&key) {
        let cref = new_ref();
        eprintln!("[{cref}] login rate-limited for {}", addr.ip());
        return error_json(StatusCode::TOO_MANY_REQUESTS, "Te vaak geprobeerd, wacht een minuut.", &cref);
    }
    match auth::password_login(
        &state.no_redirect,
        &body.school.unwrap_or_default(),
        &username,
        &body.password.unwrap_or_default(),
    )
    .await
    {
        Ok(ok) => (StatusCode::OK, Json(serde_json::to_value(&ok).unwrap())).into_response(),
        Err(e) => {
            let cref = new_ref();
            // LoginError details are pre-redacted at construction (sessionId,
            // PKCE values) or static Dutch strings — safe for Render logs.
            // Passwords, tokens and cookies never flow through here.
            eprintln!("[{cref}] login failed ({}): {}", e.status().as_u16(), e.log_detail());
            error_json(e.status(), e.message(), &cref)
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshBody {
    refresh_token: Option<String>,
    api_endpoint: Option<String>,
}

async fn refresh(State(_state): State<AppState>, Json(body): Json<RefreshBody>) -> impl IntoResponse {
    let rt = body.refresh_token.unwrap_or_default();
    if rt.is_empty() {
        let cref = new_ref();
        return error_json(StatusCode::BAD_REQUEST, "Geen refresh-token meegegeven.", &cref);
    }
    match magister_core::auth::AuthFlow::refresh_token(&rt).await {
        Ok(tok) => {
            let ts = magister_core::tokens::TokenSet::from_response(
                &tok,
                &body.api_endpoint.unwrap_or_default(),
            );
            let out = auth::SessionTokensOut {
                access_token: ts.access_token,
                refresh_token: if ts.refresh_token.is_empty() { rt } else { ts.refresh_token },
                expires_at: ts.expires_at.to_rfc3339(),
                api_endpoint: ts.api_endpoint,
                // Server never learns personId on refresh; browser keeps its own.
                person_id: None,
            };
            (StatusCode::OK, Json(serde_json::to_value(&out).unwrap())).into_response()
        }
        Err(magister_core::auth::AuthError::TokenRefreshRejected { status, body }) => {
            let cref = new_ref();
            // Rejected grant: expected lifecycle event (logged-out elsewhere),
            // not a fault. Log the ref + upstream status only, never the body
            // (it can echo token-adjacent values).
            eprintln!("[{cref}] refresh rejected by Magister (HTTP {status})");
            let _ = body;
            error_json(StatusCode::UNAUTHORIZED, "Sessie verlopen, log opnieuw in.", &cref)
        }
        Err(e) => {
            let cref = new_ref();
            eprintln!("[{cref}] refresh transient failure: {e}");
            error_json(
                StatusCode::BAD_GATEWAY,
                "Verversen mislukt, controleer je verbinding.",
                &cref,
            )
        }
    }
}

async fn logout() -> impl IntoResponse {
    // Stateless: nothing server-side to invalidate. The browser wipes its own
    // IndexedDB tokens. Acknowledged so WebBackend.logout() never fails online.
    Json(serde_json::json!({ "ok": true }))
}

/// BYO-key AI chat forward. The key travels per-request in memory only —
/// never logged (not even the request body), never stored.
async fn ai_chat(State(state): State<AppState>, Json(body): Json<ai::ChatRequest>) -> impl IntoResponse {
    match ai::chat(&state.http, body).await {
        Ok(out) => (StatusCode::OK, Json(serde_json::to_value(&out).unwrap())).into_response(),
        Err((status, msg)) => {
            let cref = new_ref();
            // Provider + status only: the message is user-safe Dutch, the key
            // and request body stay out of logs entirely.
            eprintln!("[{cref}] ai chat failed (HTTP {status}): {msg}");
            error_json(
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                &msg,
                &cref,
            )
        }
    }
}

async fn ai_validate(State(state): State<AppState>, Json(body): Json<ai::ValidateRequest>) -> impl IntoResponse {
    match ai::validate(&state.http, body).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err((status, msg)) => {
            let cref = new_ref();
            eprintln!("[{cref}] ai validate failed (HTTP {status}): {msg}");
            error_json(
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                &msg,
                &cref,
            )
        }
    }
}

async fn ai_models(State(state): State<AppState>, Json(body): Json<ai::ValidateRequest>) -> impl IntoResponse {
    match ai::list_models(&state.http, body).await {
        Ok(models) => (StatusCode::OK, Json(serde_json::json!({ "models": models }))).into_response(),
        Err((status, msg)) => {
            let cref = new_ref();
            eprintln!("[{cref}] ai models failed (HTTP {status}): {msg}");
            error_json(
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                &msg,
                &cref,
            )
        }
    }
}

/// Resolve a Magister indirection link to its real target URL (see the
/// `__resolve` branch of `magister_proxy`). Mirrors desktop
/// `get_redirect_location`: 302 Location header first, JSON `location`
/// wrapper second. The target is returned, never fetched, so multi-MB
/// payloads never transit the proxy.
async fn resolve_link(http: &reqwest::Client, url: String, bearer: String) -> axum::response::Response {
    // Strip any query noise from the log line (defense in depth; resolve
    // targets shouldn't carry secrets, but never assume).
    let logged_url = url.split('?').next().unwrap_or(&url);
    let resp = match http
        .get(&url)
        .header("Authorization", format!("Bearer {bearer}"))
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            let cref = new_ref();
            eprintln!("[{cref}] resolve transport failure for {logged_url}");
            return error_json(StatusCode::BAD_GATEWAY, "Magister is niet bereikbaar, probeer het later opnieuw.", &cref);
        }
    };
    if resp.status().is_redirection() {
        if let Some(loc) = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()) {
            return (StatusCode::OK, Json(serde_json::json!({ "location": loc }))).into_response();
        }
    }
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(loc) = json.get("location").and_then(|l| l.as_str()) {
            return (StatusCode::OK, Json(serde_json::json!({ "location": loc }))).into_response();
        }
    }
    let cref = new_ref();
    eprintln!("[{cref}] resolve: no target for {logged_url} (upstream HTTP {status})");
    error_json(
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
        "Kon de link niet resolven.",
        &cref,
    )
}

async fn magister_proxy(
    State(state): State<AppState>,
    method: Method,
    Path(path): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    let endpoint = headers.get("x-magister-endpoint").and_then(|v| v.to_str().ok()).unwrap_or_default();
    if bearer.is_empty() || endpoint.is_empty() {
        let cref = new_ref();
        return error_json(StatusCode::BAD_REQUEST, "Ontbrekende sessiegegevens, log opnieuw in.", &cref);
    }
    // Resolve mode (?__resolve=1): Magister indirection links (launch URLs,
    // download/Self links) answer with a 302 or a {"location": ...} wrapper,
    // never bytes. Browsers follow the 302 silently into HTML, so resolve
    // server-side with the no-redirect client and return the target URL.
    // The `__resolve` marker itself is stripped before forwarding.
    let is_resolve = query
        .as_deref()
        .map(|q| q.split('&').any(|p| p == "__resolve" || p.starts_with("__resolve=")))
        .unwrap_or(false);
    let forward_q = if is_resolve {
        let clean: Vec<&str> = query
            .as_deref()
            .map(|q| q.split('&').filter(|p| *p != "__resolve" && !p.starts_with("__resolve=")).collect())
            .unwrap_or_default();
        if clean.is_empty() { None } else { Some(clean.join("&")) }
    } else {
        query.clone()
    };
    let url = match proxy::upstream_url(endpoint, &path, forward_q.as_deref()) {
        Ok(u) => u,
        Err(m) => {
            let cref = new_ref();
            return error_json(StatusCode::BAD_REQUEST, m, &cref);
        }
    };
    if is_resolve {
        return resolve_link(&state.no_redirect, url, bearer.to_string()).await;
    }
    let content_type = headers.get("content-type").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    match proxy::forward(&state.http, method.clone(), url, bearer.to_string(), content_type, body).await {
        Ok((status, ct, bytes)) => {
            let mut resp_headers = HeaderMap::new();
            if let Some(ct) = ct {
                if let Ok(value) = axum::http::HeaderValue::from_str(&ct) {
                    resp_headers.insert("content-type", value);
                }
            }
            // Expired-token signal: frontend refreshes and retries once.
            if status == 401 && proxy::is_expired_token_body(&String::from_utf8_lossy(&bytes)) {
                resp_headers.insert("x-token-expired", axum::http::HeaderValue::from_static("1"));
            }
            (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), resp_headers, bytes).into_response()
        }
        Err(_) => {
            // Transport failure only (statuses pass through above): log the
            // method + path shape, never headers/body (Bearer lives there).
            let cref = new_ref();
            eprintln!("[{cref}] proxy transport failure: {} /magister/{path}", method.as_str());
            error_json(StatusCode::BAD_GATEWAY, "Magister is niet bereikbaar, probeer het later opnieuw.", &cref)
        }
    }
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);

    // Permissive CORS is safe here: authentication is a per-request Bearer
    // header, never cookies — there is no ambient authority to steal
    // cross-origin. Restrict via ALLOWED_ORIGINS anyway when set.
    let cors = match std::env::var("ALLOWED_ORIGINS") {
        Ok(list) => {
            let origins: Vec<_> = list
                .split(',')
                .filter_map(|o| o.trim().parse::<axum::http::HeaderValue>().ok())
                .collect();
            tower_http::cors::CorsLayer::new()
                .allow_origin(tower_http::cors::AllowOrigin::list(origins))
                .allow_methods(tower_http::cors::AllowMethods::mirror_request())
                .allow_headers(tower_http::cors::AllowHeaders::mirror_request())
        }
        Err(_) => CorsLayer::very_permissive(),
    };

    let state = AppState {
        no_redirect: magister_core::tls::client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .expect("proxy client build"),
        http: magister_core::tls::client_builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("proxy client build"),
        // 5 login attempts/min per IP+user-hash (see handler).
        login_limiter: Arc::new(Mutex::new(ratelimit::RateLimiter::new(5, Duration::from_secs(60)))),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/auth/login", post(login))
        .route("/api/auth/refresh", post(refresh))
        .route("/api/auth/logout", post(logout))
        .route("/api/ai/chat", post(ai_chat))
        .route("/api/ai/validate", post(ai_validate))
        .route("/api/ai/models", post(ai_models))
        .route("/api/magister/{*path}", get(magister_proxy).post(magister_proxy).put(magister_proxy).patch(magister_proxy).delete(magister_proxy))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    eprintln!("web-api listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .expect("serve");
}

#[cfg(test)]
mod ref_tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn refs_are_short_alphanumeric_and_unique() {
        let refs: HashSet<String> = (0..1000).map(|_| new_ref()).collect();
        assert_eq!(refs.len(), 1000);
        for r in &refs {
            assert_eq!(r.len(), 8);
            assert!(r.chars().all(|c| c.is_ascii_alphanumeric() && c != 'l' && c != 'L'));
        }
    }
}
