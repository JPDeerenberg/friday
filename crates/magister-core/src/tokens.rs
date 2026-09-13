//! Token state shared by the desktop app and the web API.
//!
//! Only the *shape* and *expiry math* live here. Persistence is per-app:
//! `TokenSetPersistence` (OS keyring + `tokens.json`) stays in src-tauri,
//! the web API keeps tokens in the browser and (optionally, push module)
//! encrypted refresh tokens server-side.

use chrono::{DateTime, Utc};

use crate::auth::TokenResponse;

/// Persistent token state.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
        log::debug!("Token response: expires_in={}s", expires_in);
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

    /// True once within the buffer window of actual expiry, not just past
    /// it — refreshes a little early so a request that starts right at the
    /// edge doesn't get a token that's already (or about to be) rejected
    /// by the server. The buffer is deliberately generous (2 min): Magister
    /// access tokens are short-lived and on Android a sync alarm can fire
    /// right at the edge after Doze. A stale-token 401 that still slips
    /// through (server-side revoke before local expiry) is recovered via
    /// forced refresh on `SecurityToken Expired`, not by widening this
    /// further.
    pub fn is_expired(&self) -> bool {
        const EXPIRY_BUFFER_SECS: i64 = 120;
        Utc::now() + chrono::Duration::seconds(EXPIRY_BUFFER_SECS) >= self.expires_at
    }
}
