//! Phase-0 spike harness: MagisterPy password-challenge login + Spike-0
//! cookie-authenticated PKCE code exchange (plan v2, §0).
//!
//! Reads credentials from env only (`MAGISTER_SCHOOL`, `MAGISTER_USERNAME`,
//! `MAGISTER_PASSWORD`). Secrets (password, tokens, codes, cookies) are NEVER
//! printed — only lengths / true-false presence / cookie names.
//!
//! Exit codes: 0 = spike answered (login + authorize attempts completed with
//! a definitive outcome), 2 = password login itself failed, 3 = unexpected
//! (network/parse) error.

use magister_core::cookies::Jar;
use magister_core::jsparser;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngExt;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const ACCOUNTS: &str = "https://accounts.magister.net";
const REDIRECT_URI: &str = "m6loapp://oauth2redirect/";
const CLIENT_ID: &str = "M6LOAPP";

/// First 4 chars + length. Used for non-secret identifiers only
/// (hosts, usernames); never for tokens/codes/passwords.
fn short(s: &str) -> String {
    format!("{}…(len={})", s.chars().take(4).collect::<String>(), s.len())
}

fn secret_len(label: &str, v: &str) -> String {
    format!("{label}: present, len={}", v.len())
}

macro_rules! step {
    ($name:expr, $t0:expr) => {
        eprintln!("[{:>6.1}s] {}", $t0.elapsed().as_secs_f32(), $name);
    };
}

#[derive(Debug, thiserror::Error)]
enum SpikeError {
    #[error("login failed at stage '{0}': {1}")]
    LoginFailed(&'static str, String),
    #[error("unexpected error: {0}")]
    Unexpected(String),
}

impl From<reqwest::Error> for SpikeError {
    fn from(e: reqwest::Error) -> Self {
        // Debug format carries the source chain (Display hides it behind
        // "builder error" etc.). URLs here can hold sessionId / PKCE
        // state / nonce query params, so those values are redacted —
        // passwords and tokens never appear in URLs at all.
        SpikeError::Unexpected(sanitize(&format!("{e:?}")))
    }
}

/// Load `KEY=VALUE` lines from a dotenv file into the process environment.
/// Real environment variables always win: existing vars are never overwritten.
/// Supports blank lines, `#` comments, and single/double-quoted values.
fn load_dotenv_from(path: &std::path::Path) -> usize {
    let Ok(text) = std::fs::read_to_string(path) else { return 0 };
    let mut loaded = 0;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let key = line[..eq].trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        if std::env::var_os(key).is_some() {
            continue; // real env wins
        }
        let mut value = line[eq + 1..].trim().to_string();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = value[1..value.len() - 1].to_string();
        }
        std::env::set_var(key, &value);
        loaded += 1;
    }
    loaded
}

/// Load `./.env` (current dir) then the crate dir's `.env`, so
/// `cargo run` works no matter where it's invoked from.
fn load_dotenv() {
    let cwd = std::path::PathBuf::from(".env");
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env");
    let mut files = vec![cwd];
    if manifest.exists() {
        files.push(manifest);
    }
    for path in &files {
        let n = load_dotenv_from(path);
        if n > 0 {
            eprintln!("  loaded {n} var(s) from {}", path.display());
        }
    }
}

/// Redact sensitive query-param values from a diagnostic string.
fn sanitize(msg: &str) -> String {
    let mut out = msg.to_string();
    for param in ["sessionId", "returnUrl", "code", "code_verifier", "state", "nonce", "XSRF-TOKEN"] {
        let mut search_from = 0;
        loop {
            let needle = format!("{param}=");
            let Some(rel) = out[search_from..].find(&needle) else { break };
            let val_start = search_from + rel + needle.len();
            let val_end = out[val_start..]
                .find(|c: char| c == '&' || c == '"' || c == '\'' || c == ' ' || c == ')')
                .map(|i| val_start + i)
                .unwrap_or(out.len());
            out.replace_range(val_start..val_end, "…");
            search_from = val_start + "…".len();
        }
    }
    out
}

impl From<url::ParseError> for SpikeError {
    fn from(e: url::ParseError) -> Self {
        SpikeError::Unexpected(e.to_string())
    }
}

struct Session {
    client: reqwest::Client,
    jar: Jar,
}

/// Bundled Mozilla roots, mirroring `src-tauri/src/tls.rs` (see Cargo.toml).
fn tls_config() -> rustls::ClientConfig {
    let root_store = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth()
}

impl Session {
    fn new() -> Result<Self, SpikeError> {
        let client = reqwest::Client::builder()
            .tls_backend_preconfigured(tls_config())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| SpikeError::Unexpected(format!("http client build failed: {e:?}")))?;
        Ok(Self { client, jar: Jar::default() })
    }

    fn apply_cookies(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.jar.names().is_empty() {
            req
        } else {
            req.header("Cookie", self.jar.header_value())
        }
    }

    async fn get(&mut self, url: &str) -> Result<reqwest::Response, SpikeError> {
        let resp = self.apply_cookies(self.client.get(url)).send().await?;
        self.jar.store_from_response(&resp);
        Ok(resp)
    }

    async fn get_with(&mut self, url: &str, params: &[(&str, &str)], bearer: Option<&str>) -> Result<reqwest::Response, SpikeError> {
        let mut ser = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in params {
            ser.append_pair(k, v);
        }
        let full = format!("{url}?{}", ser.finish());
        let mut req = self.apply_cookies(self.client.get(full));
        if let Some(token) = bearer {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        let resp = req.send().await?;
        self.jar.store_from_response(&resp);
        Ok(resp)
    }

    async fn post_json(&mut self, url: &str, body: &serde_json::Value) -> Result<reqwest::Response, SpikeError> {
        let mut req = self
            .apply_cookies(self.client.post(url))
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .header("origin", ACCOUNTS)
            .json(body);
        if let Some(xsrf) = self.jar.get("XSRF-TOKEN") {
            req = req.header("x-xsrf-token", xsrf.to_string());
        }
        let resp = req.send().await?;
        self.jar.store_from_response(&resp);
        Ok(resp)
    }

    async fn post_form(&mut self, url: &str, body: &str) -> Result<reqwest::Response, SpikeError> {
        let resp = self
            .apply_cookies(self.client.post(url.to_string()))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body.to_string())
            .send()
            .await?;
        self.jar.store_from_response(&resp);
        Ok(resp)
    }
}

/// Extract `access_token` from a `Location` header pointing at a
/// `...#access_token=...` fragment URL.
fn fragment_access_token(location: &str) -> Option<String> {
    let parsed = url::Url::parse(&location.replace('#', "?")).ok()?;
    parsed.query_pairs().find(|(k, _)| k == "access_token").map(|(_, v)| v.to_string())
}

/// Subdomain of an api host (`x.magister.net` → `x`), mirroring MagisterPy.
fn subdomain_of(host: &str) -> Option<String> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 2 {
        Some(parts[..parts.len() - 2].join("."))
    } else {
        None
    }
}

fn random_alnum(len: usize) -> String {
    const C: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut rng = rand::rng();
    (0..len).map(|_| C[rng.random_range(0..C.len())] as char).collect()
}

fn random_hex(len: usize) -> String {
    const C: &[u8] = b"abcdef0123456789";
    let mut rng = rand::rng();
    (0..len).map(|_| C[rng.random_range(0..C.len())] as char).collect()
}

#[derive(Debug, serde::Serialize)]
struct AttemptReport {
    status: u16,
    location_scheme: String,
    has_code: bool,
    state_matches: bool,
    note: String,
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(summary) => {
            println!("{}", serde_json::to_string_pretty(&summary).unwrap());
            std::process::exit(0);
        }
        Err(SpikeError::LoginFailed(stage, msg)) => {
            eprintln!("LOGIN FAILED at {stage}: {msg}");
            std::process::exit(2);
        }
        Err(SpikeError::Unexpected(msg)) => {
            eprintln!("UNEXPECTED ERROR: {msg}");
            std::process::exit(3);
        }
    }
}

async fn run() -> Result<serde_json::Value, SpikeError> {
    if std::env::args().any(|a| a == "--help" || a == "-h") {
        eprintln!("Usage: MAGISTER_SCHOOL=<school> MAGISTER_USERNAME=<user> MAGISTER_PASSWORD=<pw> spike-password-login");
        eprintln!("   or: copy .env.example to .env next to this binary's crate and fill it in (real env vars win over .env).");
        std::process::exit(0);
    }
    load_dotenv();
    let school = std::env::var("MAGISTER_SCHOOL").unwrap_or_default();
    let username = std::env::var("MAGISTER_USERNAME").unwrap_or_default();
    let password = std::env::var("MAGISTER_PASSWORD").unwrap_or_default();
    if school.is_empty() || username.is_empty() || password.is_empty() {
        return Err(SpikeError::Unexpected(
            "set MAGISTER_SCHOOL, MAGISTER_USERNAME and MAGISTER_PASSWORD env vars".to_string(),
        ));
    }

    let t0 = Instant::now();
    let mut sess = Session::new()?;

    // ── 1. Enter the login flow via the M6LOAPP authorize endpoint ──
    // (MagisterPy's old `/` → iam-profile bootstrap is dead: `/` now serves
    // the profile SPA. Starting at authorize is what the desktop app does too;
    // unauthenticated, Magister 302s into `/account/login?sessionId&returnUrl`.)
    step!("authorize entry (bootstrap)", t0);
    let entry_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(b"spike-entry-verifier"));
    let r = sess
        .get_with(
            &format!("{ACCOUNTS}/connect/authorize"),
            &[
                ("client_id", CLIENT_ID),
                ("redirect_uri", REDIRECT_URI),
                ("scope", "openid profile offline_access magister.mobile magister.ecs"),
                ("response_type", "code id_token"),
                ("state", "spike-entry"),
                ("nonce", "spike-entry"),
                ("code_challenge", entry_challenge.as_str()),
                ("code_challenge_method", "S256"),
            ],
            None,
        )
        .await?;
    let mut hops = 0;
    let mut r = r;
    // Follow 302s until a non-redirect (max 5). Cookies accumulate in the jar.
    loop {
        if !r.status().is_redirection() || hops >= 5 {
            break;
        }
        let loc = header_location(&r)?;
        r = sess.get(&loc).await?;
        hops += 1;
    }
    let final_url = r.url().to_string();
    eprintln!("  landed: {} ({} hops, HTTP {})", short(&final_url), hops, r.status());
    let query: HashMap<String, String> = url::Url::parse(&final_url)?.query_pairs().into_owned().collect();
    let session_id = query.get("sessionId").cloned().ok_or_else(|| SpikeError::Unexpected(format!("no sessionId in login URL {}", short(&final_url))))?;
    let return_url = query.get("returnUrl").cloned().ok_or_else(|| SpikeError::Unexpected("no returnUrl in login URL".into()))?;
    eprintln!("  cookies: {:?}", sess.jar.names());

    // Authcode: prefer `POST /challenges/current` (new API the SPA uses);
    // fall back to scraping the defer JS bundle (MagisterPy method).
    step!("authcode (challenges/current, fallback JS scrape)", t0);
    let authcode = match sess.post_json(&format!("{ACCOUNTS}/challenges/current"), &serde_json::json!({})).await {
        Ok(resp) => {
            let body: serde_json::Value = resp.json().await?;
            let keys: Vec<&str> = body.as_object().map(|o| o.keys().map(|k| k.as_str()).collect()).unwrap_or_default();
            eprintln!("  challenges/current keys: {keys:?}");
            body.get("authCode").and_then(|v| v.as_str()).map(|s| s.to_string())
        }
        Err(e) => {
            eprintln!("  challenges/current failed ({e}), falling back to JS scrape");
            None
        }
    };
    let authcode = match authcode {
        Some(a) if !a.is_empty() => a,
        _ => {
            let html = sess.get(&final_url).await?.text().await?;
            let script_src = jsparser::extract_defer_script_src(&html)
                .ok_or_else(|| SpikeError::Unexpected("defer script tag not found in login HTML".into()))?;
            step!(format!("GET login JS bundle ({})", short(&script_src)), t0);
            let js_url = if script_src.starts_with("http") { script_src } else { format!("{ACCOUNTS}/{script_src}") };
            let js = sess.get(&js_url).await?.text().await?;
            jsparser::extract_authcode(&js).map_err(|e| SpikeError::Unexpected(format!("authcode: {e}")))?
        }
    };
    eprintln!("  {}", secret_len("authcode", &authcode));

    // ── 2. Challenges: tenant → username → password ──
    let mut payload = serde_json::json!({
        "authCode": authcode,
        "returnUrl": return_url,
        "sessionId": session_id,
    });
    step!("tenant search + challenge", t0);
    let search_resp = sess
        .get_with(
            &format!("{ACCOUNTS}/challenges/tenant/search"),
            &[("sessionId", session_id.as_str()), ("key", school.as_str())],
            None,
        )
        .await?;
    if !search_resp.status().is_success() {
        return Err(SpikeError::LoginFailed("tenant-search", format!("HTTP {}", search_resp.status())));
    }
    let search_text = search_resp.text().await?;
    let search: serde_json::Value = serde_json::from_str(&search_text).map_err(|_| {
        SpikeError::LoginFailed("tenant-search", format!("no tenant for school {}", short(&school)))
    })?;
    let tenant_id = search.get(0).and_then(|t| t.get("id")).and_then(|v| v.as_str()).ok_or_else(|| {
        SpikeError::LoginFailed("tenant-search", format!("no tenant for school {}", short(&school)))
    })?;
    eprintln!("  tenant: {}", short(tenant_id));
    payload["tenant"] = serde_json::Value::String(tenant_id.to_string());
    let r = sess.post_json(&format!("{ACCOUNTS}/challenges/tenant"), &payload).await?;
    if !r.status().is_success() {
        return Err(SpikeError::LoginFailed("tenant", format!("HTTP {}", r.status())));
    }
    payload["username"] = serde_json::Value::String(username.clone());
    let r = sess.post_json(&format!("{ACCOUNTS}/challenges/username"), &payload).await?;
    if !r.status().is_success() {
        return Err(SpikeError::LoginFailed("username", format!("HTTP {}", r.status())));
    }
    step!("password challenge", t0);
    payload["password"] = serde_json::Value::String(password);
    payload["userWantsToPairSoftToken"] = serde_json::Value::Bool(false);
    let r = sess.post_json(&format!("{ACCOUNTS}/challenges/password"), &payload).await?;
    if !r.status().is_success() {
        return Err(SpikeError::LoginFailed("password", format!("HTTP {} (wrong password or cooldown)", r.status())));
    }
    eprintln!("  password challenge accepted");

    // ── 3. Profile token → api_url → app token → account/person ──
    step!("profile token + api discovery", t0);
    let profile_url = format!("{ACCOUNTS}/connect/authorize?client_id=iam-profile&redirect_uri=https%3A%2F%2Faccounts.magister.net%2Fprofile%2Foidc%2Fredirect_callback.html&response_type=id_token%20token&scope=openid%20profile%20email%20magister.iam.profile&state=spike&nonce=spike");
    let r = sess.get(&profile_url).await?;
    let profile_token = fragment_access_token(&header_location(&r)?)
        .ok_or_else(|| SpikeError::LoginFailed("profile-token", "no access_token in redirect fragment".into()))?;
    eprintln!("  {}", secret_len("profile_token", &profile_token));

    let meta: serde_json::Value = sess
        .get_with("https://magister.net/.well-known/host-meta.json", &[], Some(&profile_token))
        .await?
        .json()
        .await?;
    let api_url = meta["links"][0]["href"].as_str().ok_or_else(|| SpikeError::Unexpected("no api href in host-meta".into()))?.to_string();
    let api_host = url::Url::parse(&api_url)?.host_str().unwrap_or("?").to_string();
    eprintln!("  api host: {api_host}");

    step!("app token (implicit, MagisterPy parity)", t0);
    let sub = subdomain_of(&api_host).unwrap_or_else(|| "unknown".to_string());
    let app_token = {
        let r = sess
            .get_with(
                &format!("{ACCOUNTS}/connect/authorize"),
                &[
                    ("client_id", format!("M6-{sub}.magister.net").as_str()),
                    ("redirect_uri", format!("https://{sub}.magister.net/oidc/redirect_callback.html").as_str()),
                    ("response_type", "id_token token"),
                    ("scope", "openid profile"),
                    ("state", "spike"),
                    ("nonce", "spike"),
                    ("acr_values", format!("tenant:{sub}.magister.net").as_str()),
                ],
                None,
            )
            .await?;
        fragment_access_token(&header_location(&r)?)
            .ok_or_else(|| SpikeError::LoginFailed("app-token", "no access_token in redirect fragment".into()))?
    };
    eprintln!("  {}", secret_len("app_token", &app_token));

    let bearer = app_token.clone();
    let current: serde_json::Value = sess
        .get_with(&format!("{api_url}/sessions/current"), &[], Some(&bearer))
        .await?
        .json()
        .await?;
    let account_href = current["links"]["account"]["href"].as_str().unwrap_or("").to_string();
    let account_id = account_href.rsplit('/').next().unwrap_or("?").to_string();
    let acc: serde_json::Value = sess
        .get_with(&format!("{api_url}/accounts/{account_id}"), &[], Some(&bearer))
        .await?
        .json()
        .await?;
    let person_id = if let Some(h) = acc["links"]["leerling"]["href"].as_str() {
        h.rsplit('/').next().unwrap_or("?").to_string()
    } else if let Some(h) = acc["links"]["ouder"]["href"].as_str() {
        let parent_id = h.rsplit('/').next().unwrap_or("?");
        let kids: serde_json::Value = sess
            .get_with(&format!("{api_url}/personen/{parent_id}/kinderen"), &[], Some(&bearer))
            .await?
            .json()
            .await?;
        kids["Items"][0]["Id"].to_string()
    } else {
        return Err(SpikeError::LoginFailed("person", "neither leerling nor ouder link".into()));
    };
    eprintln!("  account {account_id}, person {person_id}");

    // ── 4. SPIKE 0: cookie-authenticated PKCE authorize (M6LOAPP) ──
    step!("SPIKE 0: PKCE authorize with warm session cookies", t0);
    let verifier = random_alnum(50);
    let state = random_alnum(50);
    let nonce = random_hex(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let scopes = "openid profile offline_access magister.mobile magister.ecs";

    let mut attempts = Vec::new();
    let mut redirects: Vec<Option<String>> = Vec::new();
    let mut code: Option<String> = None;

    // Attempt 1: desktop-identical, no acr/prompt/login_hint.
    let (rep1, redir1) =
        authorize_attempt(&mut sess, &challenge, &state, &nonce, scopes, &[], &state).await;
    attempts.push(rep1);
    redirects.push(redir1);
    // Attempt 2: with tenant acr + account selection + login hint.
    if !attempts[0].has_code {
        let (rep2, redir2) = authorize_attempt(
            &mut sess,
            &challenge,
            &state,
            &nonce,
            scopes,
            &[
                ("acr_values".to_string(), format!("tenant:{sub}.magister.net")),
                ("prompt".to_string(), "select_account".to_string()),
                ("login_hint".to_string(), username.clone()),
            ],
            &state,
        )
        .await;
        attempts.push(rep2);
        redirects.push(redir2);
    }
    for redir in redirects.iter().flatten() {
        let parsed = url::Url::parse(&redir.replace('#', "?"))?;
        if let Some(c) = parsed.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.to_string()) {
            code = Some(c);
            break;
        }
    }

    let mut exchange: serde_json::Value = serde_json::json!({"attempted": false});
    if let Some(code) = code {
        step!("SPIKE 0: exchanging code for tokens", t0);
        eprintln!("  {}", secret_len("auth code", &code));
        let mut ser = url::form_urlencoded::Serializer::new(String::new());
        ser.append_pair("code", &code)
            .append_pair("redirect_uri", REDIRECT_URI)
            .append_pair("client_id", CLIENT_ID)
            .append_pair("grant_type", "authorization_code")
            .append_pair("code_verifier", &verifier);
        let resp = sess.post_form(&format!("{ACCOUNTS}/connect/token"), &ser.finish()).await?;
        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            exchange = serde_json::json!({"attempted": true, "http_status": status, "error_body_prefix": &body[..body.len().min(200)]});
        } else {
            let tok: serde_json::Value = resp.json().await?;
            let refresh = tok.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("");
            let nonce_ok = tok.get("id_token").and_then(|v| v.as_str()).map(|id| id_token_nonce(id) == Some(nonce.clone())).unwrap_or(false);
            eprintln!("  refresh_token present: {}", !refresh.is_empty());
            eprintln!("  id_token nonce matches: {nonce_ok}");
            exchange = serde_json::json!({
                "attempted": true,
                "http_status": status,
                "refresh_token_present": !refresh.is_empty(),
                "refresh_token_len": refresh.len(),
                "access_token_len": tok.get("access_token").and_then(|v| v.as_str()).map(|s| s.len()).unwrap_or(0),
                "expires_in": tok.get("expires_in"),
                "id_token_nonce_ok": nonce_ok,
            });
        }
    }

    Ok(serde_json::json!({
        "login_ok": true,
        "api_host": api_host,
        "account_id": account_id,
        "person_id": person_id,
        "elapsed_s": t0.elapsed().as_secs_f32(),
        "spike0": {
            "attempts": attempts,
            "supported": exchange.get("refresh_token_present").and_then(|v| v.as_bool()).unwrap_or(false),
            "exchange": exchange,
        }
    }))
}

fn header_location(resp: &reqwest::Response) -> Result<String, SpikeError> {
    let raw = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| SpikeError::Unexpected(format!("no Location header (HTTP {})", resp.status())))?;
    // Locations are often root-relative (e.g. `/connect/authorize?...`);
    // resolve against the request URL like a browser would.
    Ok(url::Url::parse(resp.url().as_str())?.join(&raw)?.to_string())
}

/// One authorize attempt. Returns the serializable report plus, on an
/// `m6loapp://` redirect, the full redirect URL *separately* — it holds the
/// single-use code and must never be logged or printed.
async fn authorize_attempt(
    sess: &mut Session,
    challenge: &str,
    state: &str,
    nonce: &str,
    scopes: &str,
    extra: &[(String, String)],
    expected_state: &str,
) -> (AttemptReport, Option<String>) {
    let scope_owned = scopes.to_string();
    let mut params: Vec<(&str, &str)> = vec![
        ("client_id", CLIENT_ID),
        ("redirect_uri", REDIRECT_URI),
        ("scope", scope_owned.as_str()),
        ("response_type", "code id_token"),
        ("state", state),
        ("nonce", nonce),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
    ];
    let extra_refs: Vec<(&str, &str)> = extra.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    params.extend(extra_refs);

    let resp = match sess.get_with(&format!("{ACCOUNTS}/connect/authorize"), &params, None).await {
        Ok(r) => r,
        Err(e) => {
            return (
                AttemptReport {
                    status: 0,
                    location_scheme: "-".into(),
                    has_code: false,
                    state_matches: false,
                    note: format!("request failed: {e}"),
                },
                None,
            )
        }
    };
    let status = resp.status().as_u16();
    let location = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let scheme = location.split("://").next().unwrap_or("").to_string();
    if scheme != "m6loapp" {
        // Only a short prefix of non-m6loapp locations (https URLs carry no secrets here).
        return (
            AttemptReport {
                status,
                location_scheme: scheme,
                has_code: false,
                state_matches: false,
                note: format!("no m6loapp redirect; location prefix: {}", &location[..location.len().min(120)]),
            },
            None,
        );
    }
    let parsed = match url::Url::parse(&location.replace('#', "?")) {
        Ok(u) => u,
        Err(e) => {
            return (
                AttemptReport {
                    status,
                    location_scheme: scheme,
                    has_code: false,
                    state_matches: false,
                    note: format!("unparseable m6loapp redirect: {e}"),
                },
                None,
            )
        }
    };
    let pairs: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
    let has_code = pairs.contains_key("code");
    let state_ok = pairs.get("state").map(|s| s == expected_state).unwrap_or(false);
    (
        AttemptReport {
            status,
            location_scheme: scheme,
            has_code,
            state_matches: state_ok,
            note: format!("m6loapp redirect received (code present: {has_code}, state matches: {state_ok})"),
        },
        Some(location),
    )
}

/// Decode an `id_token` payload and return its `nonce` claim, if any.
fn id_token_nonce(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    claims.get("nonce")?.as_str().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragment_token_extraction() {
        let loc = "https://x/redirect_callback.html#access_token=tok123&token_type=Bearer";
        assert_eq!(fragment_access_token(loc).as_deref(), Some("tok123"));
        assert_eq!(fragment_access_token("https://x/other"), None);
    }

    #[test]
    fn subdomain_extraction_mirrors_magisterpy() {
        assert_eq!(subdomain_of("school.magister.net").as_deref(), Some("school"));
        assert_eq!(subdomain_of("a.b.magister.net").as_deref(), Some("a.b"));
        assert_eq!(subdomain_of("magister.net"), None);
    }

    #[test]
    fn id_token_nonce_roundtrip() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"nonce":"n-1","sub":"123"}"#);
        let tok = format!("h.{payload}.s");
        assert_eq!(id_token_nonce(&tok).as_deref(), Some("n-1"));
        assert_eq!(id_token_nonce("not-a-jwt"), None);
    }
    #[test]
    fn sanitize_redacts_sensitive_params() {
        let msg = "url: \"https://x/search?sessionId=abc123&key=school\" state=zzz";
        let out = sanitize(msg);
        assert!(!out.contains("abc123"), "{out}");
        assert!(!out.contains("state=zzz"), "{out}");
        assert!(out.contains("key=school"), "{out}");
    }

    #[test]
    fn dotenv_parses_and_env_wins() {
        let dir = std::env::temp_dir().join("spike-dotenv-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("test.env");
        std::fs::write(
            &path,
            "# comment\n\nSPIKE_TEST_A=hello\nSPIKE_TEST_B=\"quoted value\"\nSPIKE_TEST_C='single'\nBAD-LINE\n=novalue\n",
        )
        .unwrap();
        // Pre-set var must survive (env wins over file).
        std::env::set_var("SPIKE_TEST_A", "from-env");
        std::env::remove_var("SPIKE_TEST_B");
        std::env::remove_var("SPIKE_TEST_C");
        assert_eq!(load_dotenv_from(&path), 2);
        assert_eq!(std::env::var("SPIKE_TEST_A").unwrap(), "from-env");
        assert_eq!(std::env::var("SPIKE_TEST_B").unwrap(), "quoted value");
        assert_eq!(std::env::var("SPIKE_TEST_C").unwrap(), "single");
        std::env::remove_var("SPIKE_TEST_A");
        std::env::remove_var("SPIKE_TEST_B");
        std::env::remove_var("SPIKE_TEST_C");
        let _ = std::fs::remove_file(&path);
        // Missing file loads zero vars, no panic.
        assert_eq!(load_dotenv_from(&path), 0);
    }

    #[test]
    fn pkce_challenge_is_stable_sha256() {
        // RFC 7636 Appendix B vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
