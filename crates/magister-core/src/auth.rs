use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngExt;
use sha2::{Digest, Sha256};

/// Generate a random alphanumeric string of the given length.
fn generate_random_string(length: usize) -> String {
    let chars: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut rng = rand::rng();
    (0..length)
        .map(|_| chars[rng.random_range(0..chars.len())] as char)
        .collect()
}

/// Generate a random hex string of the given length.
fn generate_random_hex(length: usize) -> String {
    let chars: &[u8] = b"abcdef0123456789";
    let mut rng = rand::rng();
    (0..length)
        .map(|_| chars[rng.random_range(0..chars.len())] as char)
        .collect()
}

pub struct AuthFlow {
    pub code_verifier: String,
    pub state: String,
    pub nonce: String,
}

impl AuthFlow {
    pub fn new() -> Self {
        Self {
            code_verifier: generate_random_string(50),
            state: generate_random_string(50),
            nonce: generate_random_hex(32),
        }
    }

    /// Generate Magister OAuth2 login URL with PKCE S256 challenge.
    pub fn generate_login_url(&self, tenant: Option<&str>, username: Option<&str>) -> String {
        let state = &self.state;
        let nonce = &self.nonce;

        // SHA256 hash of code_verifier, base64url encoded
        let hash = Sha256::digest(self.code_verifier.as_bytes());
        let code_challenge = URL_SAFE_NO_PAD.encode(hash);

        let scopes = "openid%20profile%20offline_access%20magister.mobile%20magister.ecs";

        let mut url = format!(
            "https://accounts.magister.net/connect/authorize?\
             client_id=M6LOAPP\
             &redirect_uri=m6loapp%3A%2F%2Foauth2redirect%2F\
             &scope={scopes}\
             &response_type=code%20id_token\
             &state={state}\
             &nonce={nonce}\
             &code_challenge={code_challenge}\
             &code_challenge_method=S256"
        );

        if let Some(tenant) = tenant {
            url.push_str(&format!(
                "&acr_values=tenant:{tenant}&prompt=select_account"
            ));
            if let Some(username) = username {
                url.push_str(&format!("&login_hint={username}"));
            }
        }

        url
    }

    /// Exchange the authorization code from the redirect URL for a TokenSet.
    pub async fn exchange_code(&self, redirect_url: &str) -> Result<TokenResponse, AuthError> {
        // Parse the code from the redirect URL (fragment comes as #code=...&id_token=...)
        let url_with_query = redirect_url.replace('#', "?");
        let parsed = url::Url::parse(&url_with_query).map_err(|_| AuthError::InvalidRedirectUrl)?;
        let code = parsed
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.to_string())
            .ok_or(AuthError::MissingCode)?;

        let client = crate::tls::new_client();
        let body = format!(
            "code={code}\
             &redirect_uri=m6loapp://oauth2redirect/\
             &client_id=M6LOAPP\
             &grant_type=authorization_code\
             &code_verifier={}",
            self.code_verifier
        );

        let resp = client
            .post("https://accounts.magister.net/connect/token")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| AuthError::RequestFailed(e.to_string()))?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AuthError::TokenExchangeFailed(text));
        }

        let token: TokenResponse = resp
            .json()
            .await
            .map_err(|e| AuthError::ParseFailed(e.to_string()))?;

        Ok(token)
    }

    /// Verify that the `state` query parameter in the callback URL matches the
    /// one generated for this auth flow (CSRF protection). Must be checked
    /// before exchanging the authorization code.
    pub fn verify_state(&self, redirect_url: &str) -> Result<(), AuthError> {
        let url_with_query = redirect_url.replace('#', "?");
        let parsed = url::Url::parse(&url_with_query).map_err(|_| AuthError::InvalidRedirectUrl)?;
        let state = parsed
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.to_string())
            .ok_or(AuthError::MissingState)?;
        if state != self.state {
            return Err(AuthError::StateMismatch);
        }
        Ok(())
    }

    /// Decode the `id_token` payload (base64url middle segment) and verify its
    /// `nonce` claim ties the token to this specific login attempt.
    pub fn verify_id_token_nonce(&self, id_token: &str) -> Result<(), AuthError> {
        let payload = id_token
            .split('.')
            .nth(1)
            .ok_or(AuthError::InvalidIdToken)?;
        let decoded = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| AuthError::InvalidIdToken)?;
        let claims: serde_json::Value =
            serde_json::from_slice(&decoded).map_err(|_| AuthError::InvalidIdToken)?;
        let nonce = claims
            .get("nonce")
            .and_then(|v| v.as_str())
            .ok_or(AuthError::InvalidIdToken)?;
        if nonce != self.nonce {
            return Err(AuthError::NonceMismatch);
        }
        Ok(())
    }

    /// Discover the API endpoint for the authenticated user.
    pub async fn discover_api_endpoint(access_token: &str) -> Result<String, AuthError> {
        let client = crate::tls::new_client();
        let resp = client
            .get("https://magister.net/.well-known/host-meta.json?rel=magister-api")
            .header("Authorization", format!("Bearer {access_token}"))
            .send()
            .await
            .map_err(|e| AuthError::RequestFailed(e.to_string()))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AuthError::ParseFailed(e.to_string()))?;

        body["links"][0]["href"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or(AuthError::EndpointNotFound)
    }

    /// Refresh an expired token using the refresh_token grant.
    /// Distinguishes a genuine server rejection (4xx — the refresh token is
    /// dead, `invalid_grant`) from a transient failure (transport error,
    /// timeout, 5xx, parse failure) so callers can avoid wiping a still-valid
    /// local session on a temporary network blip.
    pub async fn refresh_token(refresh_token: &str) -> Result<TokenResponse, AuthError> {
        let client = crate::tls::new_client();
        let body = format!(
            "refresh_token={refresh_token}\
              &client_id=M6LOAPP\
              &grant_type=refresh_token"
        );

        let resp = client
            .post("https://accounts.magister.net/connect/token")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| AuthError::RequestFailed(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            // 4xx (except 408/429) = server explicitly rejected the grant
            // (usually 400 invalid_grant). 408/429/5xx/parse errors are transient.
            let is_rejected = (status >= 400 && status < 500) && status != 408 && status != 429;
            if is_rejected {
                return Err(AuthError::TokenRefreshRejected { status, body: text });
            } else {
                return Err(AuthError::TokenRefreshFailed(text));
            }
        }

        resp.json()
            .await
            .map_err(|e| AuthError::ParseFailed(e.to_string()))
    }
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
pub struct TokenResponse {
    pub access_token: String,
    pub id_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub token_type: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("Invalid redirect URL")]
    InvalidRedirectUrl,
    #[error("Missing authorization code in redirect URL")]
    MissingCode,
    #[error("Missing state parameter in callback URL")]
    MissingState,
    #[error("State parameter mismatch (CSRF protection)")]
    StateMismatch,
    #[error("Invalid id_token")]
    InvalidIdToken,
    #[error("id_token nonce mismatch")]
    NonceMismatch,
    #[error("HTTP request failed: {0}")]
    RequestFailed(String),
    #[error("Token exchange failed: {0}")]
    TokenExchangeFailed(String),
    #[error("Token refresh failed: {0}")]
    TokenRefreshFailed(String),
    #[error("Token refresh rejected (status {status}): {body}")]
    TokenRefreshRejected { status: u16, body: String },
    #[error("Failed to parse response: {0}")]
    ParseFailed(String),
    #[error("API endpoint not found in host-meta")]
    EndpointNotFound,
}

impl serde::Serialize for AuthError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flow_with(state: &str, nonce: &str) -> AuthFlow {
        AuthFlow {
            code_verifier: "verifier".to_string(),
            state: state.to_string(),
            nonce: nonce.to_string(),
        }
    }

    fn id_token_with_nonce(nonce: &str) -> String {
        let payload = serde_json::json!({ "nonce": nonce, "sub": "123" }).to_string();
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload.as_bytes());
        format!("header.{payload_b64}.signature")
    }

    #[test]
    fn verify_state_accepts_matching_state() {
        let flow = flow_with("abc123", "nonce");
        let url = "m6loapp://oauth2redirect/?code=xyz&state=abc123&id_token=tok";
        assert!(flow.verify_state(url).is_ok());
    }

    #[test]
    fn verify_state_rejects_mismatched_state() {
        let flow = flow_with("abc123", "nonce");
        let url = "m6loapp://oauth2redirect/?code=xyz&state=attacker&id_token=tok";
        let err = flow.verify_state(url).unwrap_err().to_string();
        assert!(err.contains("mismatch"), "unexpected error: {err}");
    }

    #[test]
    fn verify_state_rejects_missing_state() {
        let flow = flow_with("abc123", "nonce");
        let url = "m6loapp://oauth2redirect/?code=xyz&id_token=tok";
        let err = flow.verify_state(url).unwrap_err().to_string();
        assert!(err.contains("Missing state"), "unexpected error: {err}");
    }

    #[test]
    fn verify_state_handles_fragment_redirect() {
        let flow = flow_with("abc123", "nonce");
        let url = "m6loapp://oauth2redirect/#code=xyz&state=abc123&id_token=tok";
        assert!(flow.verify_state(url).is_ok());
    }

    #[test]
    fn verify_nonce_accepts_matching_nonce() {
        let flow = flow_with("state", "nonce-123");
        assert!(flow.verify_id_token_nonce(&id_token_with_nonce("nonce-123")).is_ok());
    }

    #[test]
    fn verify_nonce_rejects_mismatched_nonce() {
        let flow = flow_with("state", "nonce-123");
        let err = flow
            .verify_id_token_nonce(&id_token_with_nonce("nonce-attacker"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("nonce mismatch"), "unexpected error: {err}");
    }

    #[test]
    fn verify_nonce_rejects_invalid_token() {
        let flow = flow_with("state", "nonce-123");
        assert!(flow.verify_id_token_nonce("not-a-jwt").is_err());
        assert!(flow.verify_id_token_nonce("a.b.c").is_err());
    }
}
