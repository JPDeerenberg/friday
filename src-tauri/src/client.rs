//! Magister API client.
//! (Behoud alle bestaande code, voeg de nieuwe methode toe.)

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::auth::{AuthFlow, TokenResponse};
use crate::secure_store;
use std::path::Path;

/// Persistent token state saved to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub id_token: String,
    pub refresh_token: String,
    pub expires_at: DateTime<Utc>,
    pub api_endpoint: String,
    pub person_id: Option<i64>,
    pub account_uuid: Option<String>,
}

impl TokenSet {
    pub fn from_response(resp: &TokenResponse, api_endpoint: &str) -> Self {
        let expires_in = resp.expires_in.unwrap_or(3600);
        Self {
            access_token: resp.access_token.clone(),
            id_token: resp.id_token.clone(),
            refresh_token: resp.refresh_token.clone().unwrap_or_default(),
            expires_at: Utc::now() + chrono::Duration::seconds(expires_in),
            api_endpoint: api_endpoint.to_string(),
            person_id: None,
            account_uuid: None,
        }
    }

    pub fn is_expired(&self) -> bool {
        Utc::now() >= self.expires_at
    }
}

/// The Magister API client — manages auth tokens and makes requests.
pub struct MagisterClient {
    pub http: reqwest::Client,
    pub token_set: Option<TokenSet>,
    pub auth_flow: Option<AuthFlow>,
    /// Set once at app startup via set_app_handle(). Needed so ensure_valid_token()
    /// can persist a mid-session refresh to disk (bug: refreshed tokens were only
    /// kept in memory, tokens.json was only written at login/logout/restore).
    app_handle: Option<tauri::AppHandle>,
}

/// Non-secret token metadata persisted to `tokens.json`. The actual token
/// values (access/id/refresh) live in the OS keyring, see [`TokenSetPersistence`].
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenMetadata {
    expires_at: DateTime<Utc>,
    api_endpoint: String,
    person_id: Option<i64>,
    account_uuid: Option<String>,
}

impl From<&TokenSet> for TokenMetadata {
    fn from(ts: &TokenSet) -> Self {
        Self {
            expires_at: ts.expires_at,
            api_endpoint: ts.api_endpoint.clone(),
            person_id: ts.person_id,
            account_uuid: ts.account_uuid.clone(),
        }
    }
}

/// Split persistence of a [`TokenSet`]: secrets go to the OS keyring
/// ([`crate::secure_store`]), the non-secret metadata goes to `tokens.json`.
///
/// This keeps long-lived secrets (refresh token) out of plaintext JSON files.
pub struct TokenSetPersistence;

impl TokenSetPersistence {
    /// Persist both halves. Errors are best-effort logged, never fatal.
    pub fn save(data_dir: &Path, ts: &TokenSet) {
        let _ = std::fs::create_dir_all(data_dir);
        let meta = TokenMetadata::from(ts);
        if let Ok(data) = serde_json::to_string_pretty(&meta) {
            let path = data_dir.join("tokens.json");
            if let Err(e) = std::fs::write(&path, data) {
                eprintln!("Failed to write token metadata: {}", e);
            }
        }
        for (username, value) in [
            (secure_store::USER_ACCESS_TOKEN, &ts.access_token),
            (secure_store::USER_ID_TOKEN, &ts.id_token),
            (secure_store::USER_REFRESH_TOKEN, &ts.refresh_token),
        ] {
            if let Err(e) = secure_store::set_secret(username, value) {
                eprintln!("Failed to store {} in keyring: {}", username, e);
            }
        }
    }

    /// Load both halves. Returns `None` if no usable session exists.
    pub fn load(data_dir: &Path) -> Option<TokenSet> {
        let meta: TokenMetadata = serde_json::from_str(&std::fs::read_to_string(data_dir.join("tokens.json")).ok()?).ok()?;
        let access_token = secure_store::get_secret(secure_store::USER_ACCESS_TOKEN).ok().flatten()?;
        let id_token = secure_store::get_secret(secure_store::USER_ID_TOKEN).ok().flatten()?;
        let refresh_token = secure_store::get_secret(secure_store::USER_REFRESH_TOKEN).ok().flatten()?;
        Some(TokenSet {
            access_token,
            id_token,
            refresh_token,
            expires_at: meta.expires_at,
            api_endpoint: meta.api_endpoint,
            person_id: meta.person_id,
            account_uuid: meta.account_uuid,
        })
    }

    /// Remove the metadata file and every keyring entry.
    fn clear(data_dir: &Path) {
        let _ = std::fs::remove_file(data_dir.join("tokens.json"));
        for username in [
            secure_store::USER_ACCESS_TOKEN,
            secure_store::USER_ID_TOKEN,
            secure_store::USER_REFRESH_TOKEN,
        ] {
            let _ = secure_store::delete_secret(username);
        }
    }
}

/// Legacy on-disk format (pre-secure-storage): the full `TokenSet`, tokens
/// included, was serialized directly to `tokens.json`. Used only for migration.
#[derive(Debug, Deserialize)]
struct LegacyTokenSet {
    access_token: String,
    id_token: String,
    refresh_token: String,
    expires_at: DateTime<Utc>,
    api_endpoint: String,
    person_id: Option<i64>,
    account_uuid: Option<String>,
}

impl From<LegacyTokenSet> for TokenSet {
    fn from(l: LegacyTokenSet) -> Self {
        Self {
            access_token: l.access_token,
            id_token: l.id_token,
            refresh_token: l.refresh_token,
            expires_at: l.expires_at,
            api_endpoint: l.api_endpoint,
            person_id: l.person_id,
            account_uuid: l.account_uuid,
        }
    }
}

/// Migrate a pre-secure-storage `tokens.json` (full `TokenSet` inline) into the
/// split layout: move the secrets into the keyring, leave only metadata behind.
///
/// Detection is explicit (presence of a token field) because serde ignores
/// unknown fields, so a legacy file would otherwise also parse as metadata.
pub fn migrate_legacy_tokens(data_dir: &Path) -> Option<TokenSet> {
    let path = data_dir.join("tokens.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let has_legacy_token = value
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
        || value
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
    if !has_legacy_token {
        return None;
    }
    let legacy: LegacyTokenSet = serde_json::from_value(value).ok()?;
    let ts: TokenSet = legacy.into();
    TokenSetPersistence::save(data_dir, &ts);
    Some(ts)
}

/// A lightweight, cheaply-cloneable snapshot of what's needed to make an
/// authenticated request. Obtained via `MagisterClient::request_context()`,
/// which is the ONLY part that needs `&mut self` (and therefore the client
/// lock) — once you have a `RequestContext`, the actual HTTP request can
/// happen without holding the lock at all.
///
/// Why this exists: every command currently does `client.lock().await` then
/// keeps that lock for its ENTIRE request, including the network
/// round-trip. Since `SharedClient` is one mutex shared by the whole app,
/// this means any two commands invoked concurrently (e.g. the dashboard's
/// five parallel fetches) serialize on the network I/O itself, not just on
/// the cheap "is my token still valid" check — defeating the point of
/// firing them in parallel from the frontend.
///
/// `reqwest::Client` is cheap to clone (it's an `Arc` internally around the
/// connection pool — this is documented, intended usage, not a workaround),
/// so cloning it plus the current token/endpoint costs nothing meaningful
/// and lets the request happen fully unlocked.
///
/// This exact pattern (clone http+token, drop the lock, then fan out
/// requests) already exists and works in `get_bulk_grade_extra_info` (see
/// commands/grades.rs) — this just formalizes it as a reusable primitive
/// instead of a one-off.
///
/// Deliberately scoped to GET only, and deliberately NOT used for every
/// command in the app — see `get_with_context()` below for what's traded
/// away by not holding the lock, and why that trade is fine for read-only
/// fetches but not for the OAuth login flow or any write (POST/PUT/PATCH/
/// DELETE), which all still use the original, fully-serialized `&mut self`
/// methods unchanged.
#[derive(Clone)]
pub struct RequestContext {
    http: reqwest::Client,
    access_token: String,
    api_endpoint: String,
}

impl RequestContext {
    fn build_url(&self, path: &str) -> String {
        if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}/{}", self.api_endpoint.trim_end_matches('/'), path.trim_start_matches('/'))
        }
    }
}

/// Make an authenticated GET request using a pre-fetched `RequestContext`,
/// without holding the client lock. This is the parallel-safe counterpart
/// to `MagisterClient::get()` — same URL-building, 429-retry, and
/// error-handling logic, just operating on cloned values instead of
/// `&mut self`.
///
/// One deliberate behavioral difference from `MagisterClient::get()`: this
/// does NOT handle the "401 mid-request, token expired right as we sent
/// the request" case by refreshing and retrying — it can't, since it has
/// no way to write a refreshed token back (no lock, no `&mut self`). It
/// just returns `ClientError::Unauthorized`, the same as every non-GET
/// method (`put`, `patch`, `delete_with_body`) already does today for this
/// exact race. Callers using this path are the app's read-only,
/// best-effort parallel fetches (dashboard-style), which already treat
/// each fetch independently with its own error handling — a stale-token
/// failure here surfaces as a normal error, same as any other, and a
/// retry (or just reopening the page) gets a fresh context with a valid
/// token.
pub async fn get_with_context(ctx: &RequestContext, path: &str) -> Result<serde_json::Value, ClientError> {
    let url = ctx.build_url(path);

    const MAX_RATE_LIMIT_RETRIES: u32 = 3;
    let mut attempt = 0;
    loop {
        let resp = ctx
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", ctx.access_token))
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

        if resp.status().as_u16() == 401 {
            let text = resp.text().await.unwrap_or_default();
            return Err(ClientError::Unauthorized(text));
        }

        if resp.status().as_u16() == 429 {
            if attempt < MAX_RATE_LIMIT_RETRIES {
                attempt += 1;
                let backoff = std::time::Duration::from_secs(1u64 << attempt);
                eprintln!("API rate limited (GET {}), retrying in {:?} (attempt {}/{})", url, backoff, attempt, MAX_RATE_LIMIT_RETRIES);
                tokio::time::sleep(backoff).await;
                continue;
            }
            return Err(ClientError::RateLimited);
        }

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            eprintln!("API Error (GET, unlocked): URL={}, Status={}, Body={}", url, status, text);
            return Err(ClientError::ApiError(status, text));
        }

        return resp.json().await.map_err(|e| ClientError::ParseFailed(e.to_string()));
    }
}

/// Byte-returning counterpart to `get_with_context()` — same rationale and
/// same 401 behavior difference from `MagisterClient::get_bytes()`. Used
/// for e.g. the profile picture fetch.
pub async fn get_bytes_with_context(ctx: &RequestContext, path: &str) -> Result<Option<Vec<u8>>, ClientError> {
    let url = ctx.build_url(path);

    let resp = ctx
        .http
        .get(&url)
        .header("Authorization", format!("Bearer {}", ctx.access_token))
        .send()
        .await
        .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        eprintln!("API Error (BYTES, unlocked): URL={}, Status={}, Body={}", url, status, text);
        return Err(ClientError::ApiError(status, text));
    }

    Ok(Some(
        resp.bytes()
            .await
            .map_err(|e| ClientError::ParseFailed(e.to_string()))?
            .to_vec(),
    ))
}

impl MagisterClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            token_set: None,
            auth_flow: None,
            app_handle: None,
        }
    }

    pub fn set_app_handle(&mut self, handle: tauri::AppHandle) {
        self.app_handle = Some(handle);
    }

    /// Load tokens from secure storage if available.
    #[allow(dead_code)]
    pub fn load_tokens(&mut self, app_handle: &tauri::AppHandle) {
        if let Ok(path) = app_handle.path_resolver_data_dir() {
            if let Some(token_set) = TokenSetPersistence::load(&path) {
                self.token_set = Some(token_set);
            } else if let Some(token_set) = migrate_legacy_tokens(&path) {
                self.token_set = Some(token_set);
            }
        }
    }

    /// Save tokens to secure storage.
    pub fn save_tokens(&self, app_handle: &tauri::AppHandle) {
        if let Some(ref token_set) = self.token_set {
            if let Ok(path) = app_handle.path_resolver_data_dir() {
                TokenSetPersistence::save(&path, token_set);
            }
        }
    }

    /// Remove all persisted token data (metadata file + keyring entries).
    pub fn clear_persisted_tokens(&self, app_handle: &tauri::AppHandle) {
        if let Ok(path) = app_handle.path_resolver_data_dir() {
            TokenSetPersistence::clear(&path);
        }
    }

    /// Ensure the access token is valid, refreshing if needed.
    pub async fn ensure_valid_token(&mut self) -> Result<(), ClientError> {
        let token_set = self
            .token_set
            .as_ref()
            .ok_or(ClientError::NotAuthenticated)?;

        if token_set.is_expired() {
            let resp = AuthFlow::refresh_token(&token_set.refresh_token)
                .await
                .map_err(|e| ClientError::TokenRefreshFailed(e.to_string()))?;

            let api_endpoint = token_set.api_endpoint.clone();
            let person_id = token_set.person_id;
            let account_uuid = token_set.account_uuid.clone();

            let mut new_token = TokenSet::from_response(&resp, &api_endpoint);
            new_token.person_id = person_id;
            new_token.account_uuid = account_uuid;

            // Keep the old refresh token if new one is not provided
            if new_token.refresh_token.is_empty() {
                new_token.refresh_token = token_set.refresh_token.clone();
            }

            self.token_set = Some(new_token);

            // Bug #11 fix: persist immediately, don't leave the refreshed token
            // in memory only. Without this, a killed/restarted process falls back
            // to the stale on-disk token, which is also the likely cause of bug #12
            // (token stops working after backgrounding).
            if let Some(handle) = self.app_handle.clone() {
                self.save_tokens(&handle);
            }
        }

        Ok(())
    }

    /// Ensure the token is valid (refreshing + persisting if needed — same
    /// call as always, still fully serialized under the client lock since
    /// it may mutate `token_set`), then return a cheap snapshot that can be
    /// used to make the actual HTTP request AFTER the caller drops the
    /// lock. See `RequestContext` (defined above this impl block) for the
    /// full rationale.
    pub async fn request_context(&mut self) -> Result<RequestContext, ClientError> {
        self.ensure_valid_token().await?;
        let token_set = self.token_set.as_ref().unwrap();
        Ok(RequestContext {
            http: self.http.clone(),
            access_token: token_set.access_token.clone(),
            api_endpoint: token_set.api_endpoint.clone(),
        })
    }

    /// Make an authenticated GET request to the Magister API.
    pub async fn get(&mut self, path: &str) -> Result<serde_json::Value, ClientError> {
        self.ensure_valid_token().await?;
        let token_set = self.token_set.as_ref().unwrap();

        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}/{}", token_set.api_endpoint.trim_end_matches('/'), path.trim_start_matches('/'))
        };

        // Part B 5A: retry on 429 (rate limited) with exponential backoff. Every
        // other branch below is unchanged from before — it still returns
        // immediately. Only the 429 case loops (via `continue`), up to
        // MAX_RATE_LIMIT_RETRIES times, before finally giving up.
        const MAX_RATE_LIMIT_RETRIES: u32 = 3;
        let mut attempt = 0;
        loop {
            let token_set = self.token_set.as_ref().unwrap();
            let resp = self
                .http
                .get(&url)
                .header(
                    "Authorization",
                    format!("Bearer {}", token_set.access_token),
                )
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

            // Handle token expired mid-request
            if resp.status().as_u16() == 401 {
                let text = resp.text().await.unwrap_or_default();
                if text.contains("SecurityToken Expired") || text.contains("invalid_token") {
                    self.token_set.as_mut().unwrap().expires_at = Utc::now(); // Force refresh
                    self.ensure_valid_token().await?;
                    let token_set = self.token_set.as_ref().unwrap();
                    let resp = self
                        .http
                        .get(&url)
                        .header(
                            "Authorization",
                            format!("Bearer {}", token_set.access_token),
                        )
                        .header("Content-Type", "application/json")
                        .header("Accept", "application/json")
                        .send()
                        .await
                        .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

                    return resp
                        .json()
                        .await
                        .map_err(|e| ClientError::ParseFailed(e.to_string()));
                }
                return Err(ClientError::Unauthorized(text));
            }

            if resp.status().as_u16() == 429 {
                if attempt < MAX_RATE_LIMIT_RETRIES {
                    attempt += 1;
                    let backoff = std::time::Duration::from_secs(1u64 << attempt); // 2s, 4s, 8s
                    eprintln!("API rate limited (GET {}), retrying in {:?} (attempt {}/{})", url, backoff, attempt, MAX_RATE_LIMIT_RETRIES);
                    tokio::time::sleep(backoff).await;
                    continue;
                }
                return Err(ClientError::RateLimited);
            }

            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                eprintln!("API Error (GET): URL={}, Status={}, Body={}", url, status, text);
                return Err(ClientError::ApiError(status, text));
            }

            return resp
                .json()
                .await
                .map_err(|e| ClientError::ParseFailed(e.to_string()));
        }
    }

    /// Make an authenticated GET request that returns raw bytes (for images).
    pub async fn get_bytes(&mut self, path: &str) -> Result<Option<Vec<u8>>, ClientError> {
        self.ensure_valid_token().await?;
        let token_set = self.token_set.as_ref().unwrap();

        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}/{}", token_set.api_endpoint.trim_end_matches('/'), path.trim_start_matches('/'))
        };

        let resp = self
            .http
            .get(&url)
            .header(
                "Authorization",
                format!("Bearer {}", token_set.access_token),
            )
            .send()
            .await
            .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

        if resp.status().as_u16() == 404 {
            return Ok(None);
        }

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            eprintln!("API Error (BYTES): URL={}, Status={}, Body={}", url, status, text);
            return Err(ClientError::ApiError(status, text));
        }

        Ok(Some(
            resp.bytes()
                .await
                .map_err(|e| ClientError::ParseFailed(e.to_string()))?
                .to_vec(),
        ))
    }

    /// Make an authenticated GET request and return both bytes and content type.
    pub async fn get_bytes_with_content_type(
        &mut self,
        path: &str,
    ) -> Result<(Vec<u8>, String), ClientError> {
        self.ensure_valid_token().await?;
        let token_set = self.token_set.as_ref().unwrap();

        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}/{}", token_set.api_endpoint.trim_end_matches('/'), path.trim_start_matches('/'))
        };

        let resp = self
            .http
            .get(&url)
            .header(
                "Authorization",
                format!("Bearer {}", token_set.access_token),
            )
            .send()
            .await
            .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();

        if resp.status().as_u16() == 404 {
            return Err(ClientError::ApiError(404, "Not Found".to_string()));
        }

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            eprintln!("API Error (BYTES): URL={}, Status={}, Body={}", url, status, text);
            return Err(ClientError::ApiError(status, text));
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ClientError::ParseFailed(e.to_string()))?
            .to_vec();

        Ok((bytes, content_type))
    }

    /// Make an authenticated POST request.
    pub async fn post(
        &mut self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        self.ensure_valid_token().await?;
        let token_set = self.token_set.as_ref().unwrap();

        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}/{}", token_set.api_endpoint.trim_end_matches('/'), path.trim_start_matches('/'))
        };

        // Part B 5A: same 429 retry treatment as get(). Also fixes a small
        // inconsistency found while doing this: post() previously didn't
        // distinguish 429 from other errors at all — it fell into the generic
        // ApiError branch below instead of ClientError::RateLimited.
        const MAX_RATE_LIMIT_RETRIES: u32 = 3;
        let mut attempt = 0;
        loop {
            let token_set = self.token_set.as_ref().unwrap();
            let resp = self
                .http
                .post(&url)
                .header(
                    "Authorization",
                    format!("Bearer {}", token_set.access_token),
                )
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .json(body)
                .send()
                .await
                .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

            if resp.status().as_u16() == 429 {
                if attempt < MAX_RATE_LIMIT_RETRIES {
                    attempt += 1;
                    let backoff = std::time::Duration::from_secs(1u64 << attempt);
                    eprintln!("API rate limited (POST {}), retrying in {:?} (attempt {}/{})", url, backoff, attempt, MAX_RATE_LIMIT_RETRIES);
                    tokio::time::sleep(backoff).await;
                    continue;
                }
                return Err(ClientError::RateLimited);
            }

            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                eprintln!("API Error (POST): URL={}, Status={}, Body={}", url, status, text);
                return Err(ClientError::ApiError(status, text));
            }

            let text = resp.text().await.unwrap_or_default();
            return if text.is_empty() {
                Ok(serde_json::Value::Null)
            } else {
                serde_json::from_str(&text).map_err(|e| ClientError::ParseFailed(e.to_string()))
            };
        }
    }

    /// Make an authenticated PUT request.
    pub async fn put(&mut self, path: &str, body: &serde_json::Value) -> Result<(), ClientError> {
        self.ensure_valid_token().await?;
        let token_set = self.token_set.as_ref().unwrap();

        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}/{}", token_set.api_endpoint.trim_end_matches('/'), path.trim_start_matches('/'))
        };

        let resp = self
            .http
            .put(&url)
            .header(
                "Authorization",
                format!("Bearer {}", token_set.access_token),
            )
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            eprintln!("API Error (PUT): URL={}, Status={}, Body={}", url, status, text);
            return Err(ClientError::ApiError(status, text));
        }
        Ok(())
    }

    /// Make an authenticated DELETE request.
    pub async fn delete(&mut self, path: &str) -> Result<(), ClientError> {
        self.delete_with_body(path, &serde_json::Value::Null).await
    }

    /// Make an authenticated DELETE request with a body.
    pub async fn delete_with_body(
        &mut self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<(), ClientError> {
        self.ensure_valid_token().await?;
        let token_set = self.token_set.as_ref().unwrap();

        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}/{}", token_set.api_endpoint.trim_end_matches('/'), path.trim_start_matches('/'))
        };

        let mut rb = self.http.delete(&url).header(
            "Authorization",
            format!("Bearer {}", token_set.access_token),
        );

        if !body.is_null() {
            rb = rb.header("Content-Type", "application/json").json(body);
        }

        let resp = rb
            .send()
            .await
            .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            eprintln!("API Error (DELETE): URL={}, Status={}, Body={}", url, status, text);
            return Err(ClientError::ApiError(status, text));
        }
        Ok(())
    }

    /// Make an authenticated PATCH request.
    pub async fn patch(&mut self, path: &str, body: &serde_json::Value) -> Result<(), ClientError> {
        self.ensure_valid_token().await?;
        let token_set = self.token_set.as_ref().unwrap();

        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}/{}", token_set.api_endpoint.trim_end_matches('/'), path.trim_start_matches('/'))
        };

        let resp = self
            .http
            .patch(&url)
            .header(
                "Authorization",
                format!("Bearer {}", token_set.access_token),
            )
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            eprintln!("API Error (PATCH): URL={}, Status={}, Body={}", url, status, text);
            return Err(ClientError::ApiError(status, text));
        }
        Ok(())
    }

    /// Make an authenticated GET request, do NOT follow redirects, and return the Location header.
    pub async fn get_redirect_location(&mut self, path: &str) -> Result<String, ClientError> {
        self.ensure_valid_token().await?;
        let token_set = self.token_set.as_ref().unwrap();

        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}/{}", token_set.api_endpoint.trim_end_matches('/'), path.trim_start_matches('/'))
        };

        let no_redirect_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

        let resp = no_redirect_client
            .get(&url)
            .header(
                "Authorization",
                format!("Bearer {}", token_set.access_token),
            )
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| ClientError::RequestFailed(e.to_string()))?;

        let status = resp.status().as_u16();
        
        if resp.status().is_redirection() {
            if let Some(loc) = resp.headers().get(reqwest::header::LOCATION) {
                return Ok(loc.to_str().unwrap_or_default().to_string());
            }
        }

        let text = resp.text().await.unwrap_or_default();

        if status >= 200 && status < 300 {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(loc) = json.get("location").and_then(|l| l.as_str()) {
                    return Ok(loc.to_string());
                }
            }
        }

        Err(ClientError::ApiError(status, text))
    }
}

/// Thread-safe wrapper for the MagisterClient.
pub type SharedClient = Arc<Mutex<MagisterClient>>;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("Not authenticated — please log in first")]
    NotAuthenticated,
    #[error("Token refresh failed: {0}")]
    TokenRefreshFailed(String),
    #[error("HTTP request failed: {0}")]
    RequestFailed(String),
    #[error("Failed to parse response: {0}")]
    ParseFailed(String),
    #[error("Unauthorized: {0}")]
    Unauthorized(String),
    #[error("Rate limited — please wait")]
    RateLimited,
    #[error("API error ({0}): {1}")]
    ApiError(u16, String),
}

impl serde::Serialize for ClientError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Helper trait to get app data dir path.
#[allow(dead_code)]
trait AppHandlePathResolver {
    fn path_resolver_data_dir(&self) -> Result<std::path::PathBuf, String>;
}

impl AppHandlePathResolver for tauri::AppHandle {
    fn path_resolver_data_dir(&self) -> Result<std::path::PathBuf, String> {
        use tauri::Manager;
        self.path().app_data_dir().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use crate::client::{ClientError, MagisterClient, TokenSet};
    use chrono::{Duration, Utc};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn create_mock_token_set(endpoint: &str) -> TokenSet {
        TokenSet {
            access_token: "mock_access_token".to_string(),
            id_token: "mock_id_token".to_string(),
            refresh_token: "mock_refresh_token".to_string(),
            expires_at: Utc::now() + Duration::seconds(3600),
            api_endpoint: endpoint.to_string(),
            person_id: Some(123),
            account_uuid: None,
        }
    }

    #[tokio::test]
    async fn test_get_success() {
        let mock_server = MockServer::start().await;

        let expected_body = serde_json::json!({"data": "success"});

        Mock::given(method("GET"))
            .and(path("/api/test"))
            .and(header("Authorization", "Bearer mock_access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&expected_body))
            .mount(&mock_server)
            .await;

        let mut client = MagisterClient::new();
        client.token_set = Some(create_mock_token_set(&mock_server.uri()));

        let result = client.get("/api/test").await.expect("Expected successful get");
        assert_eq!(result, expected_body);
    }

    #[tokio::test]
    async fn test_get_unauthorized() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/test"))
            .respond_with(ResponseTemplate::new(401).set_body_string("Unauthorized"))
            .mount(&mock_server)
            .await;

        let mut client = MagisterClient::new();
        client.token_set = Some(create_mock_token_set(&mock_server.uri()));

        let result = client.get("/api/test").await;
        match result {
            Err(ClientError::Unauthorized(text)) => {
                assert_eq!(text, "Unauthorized");
            }
            _ => panic!("Expected Unauthorized, got {:?}", result),
        }
    }

    #[tokio::test]
    async fn test_get_not_found() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/test"))
            .respond_with(ResponseTemplate::new(404).set_body_string("Not Found"))
            .mount(&mock_server)
            .await;

        let mut client = MagisterClient::new();
        client.token_set = Some(create_mock_token_set(&mock_server.uri()));

        let result = client.get("/api/test").await;
        match result {
            Err(ClientError::ApiError(status, text)) => {
                assert_eq!(status, 404);
                assert_eq!(text, "Not Found");
            }
            _ => panic!("Expected ApiError(404, 'Not Found'), got {:?}", result),
        }
    }

    #[tokio::test]
    async fn test_get_rate_limited() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/test"))
            .respond_with(ResponseTemplate::new(429).set_body_string("Rate Limited"))
            .mount(&mock_server)
            .await;

        let mut client = MagisterClient::new();
        client.token_set = Some(create_mock_token_set(&mock_server.uri()));

        let result = client.get("/api/test").await;
        match result {
            Err(ClientError::RateLimited) => {}
            Err(ClientError::ApiError(status, text)) => {
                assert_eq!(status, 429);
                assert_eq!(text, "Rate Limited");
            }
            _ => panic!("Expected RateLimited or ApiError(429), got {:?}", result),
        }
    }

    #[tokio::test]
    async fn test_get_invalid_json() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/test"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not valid json"))
            .mount(&mock_server)
            .await;

        let mut client = MagisterClient::new();
        client.token_set = Some(create_mock_token_set(&mock_server.uri()));

        let result = client.get("/api/test").await;
        match result {
            Err(ClientError::ParseFailed(_)) => {}
            _ => panic!("Expected ParseFailed, got {:?}", result),
        }
    }

    #[tokio::test]
    async fn test_get_not_authenticated() {
        let mut client = MagisterClient::new();

        let result = client.get("/api/test").await;
        match result {
            Err(ClientError::NotAuthenticated) => {}
            _ => panic!("Expected NotAuthenticated, got {:?}", result),
        }
    }
}
