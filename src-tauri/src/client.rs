use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::auth::{AuthFlow, TokenResponse};

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
}

impl MagisterClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
            token_set: None,
            auth_flow: None,
        }
    }

    #[allow(dead_code)]
    pub fn set_app_handle(&mut self, _handle: tauri::AppHandle) {
        // self.app_handle = Some(handle);
    }

    /// Load tokens from disk if available.
    #[allow(dead_code)]
    pub fn load_tokens(&mut self, app_handle: &tauri::AppHandle) {
        if let Ok(path) = app_handle.path_resolver_data_dir() {
            let token_path = path.join("tokens.json");
            if token_path.exists() {
                if let Ok(data) = std::fs::read_to_string(&token_path) {
                    if let Ok(token_set) = serde_json::from_str::<TokenSet>(&data) {
                        self.token_set = Some(token_set);
                    }
                }
            }
        }
    }

    /// Save tokens to disk.
    #[allow(dead_code)]
    pub fn save_tokens(&self, app_handle: &tauri::AppHandle) {
        if let Some(ref token_set) = self.token_set {
            if let Ok(path) = app_handle.path_resolver_data_dir() {
                std::fs::create_dir_all(&path).ok();
                let token_path = path.join("tokens.json");
                if let Ok(data) = serde_json::to_string_pretty(token_set) {
                    std::fs::write(token_path, data).ok();
                }
            }
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
        }

        Ok(())
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
            // Try refresh and retry once
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
            return Err(ClientError::RateLimited);
        }

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            eprintln!("API Error (GET): URL={}, Status={}, Body={}", url, status, text);
            return Err(ClientError::ApiError(status, text));
        }

        resp.json()
            .await
            .map_err(|e| ClientError::ParseFailed(e.to_string()))
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

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            eprintln!("API Error (POST): URL={}, Status={}, Body={}", url, status, text);
            return Err(ClientError::ApiError(status, text));
        }

        // Some POST endpoints return empty body
        let text = resp.text().await.unwrap_or_default();
        if text.is_empty() {
            Ok(serde_json::Value::Null)
        } else {
            serde_json::from_str(&text).map_err(|e| ClientError::ParseFailed(e.to_string()))
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
