use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use sha2::{Digest, Sha256};

/// Generate a random alphanumeric string of the given length.
fn generate_random_string(length: usize) -> String {
    let chars: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut rng = rand::thread_rng();
    (0..length)
        .map(|_| chars[rng.gen_range(0..chars.len())] as char)
        .collect()
}

/// Generate a random hex string of the given length.
fn generate_random_hex(length: usize) -> String {
    let chars: &[u8] = b"abcdef0123456789";
    let mut rng = rand::thread_rng();
    (0..length)
        .map(|_| chars[rng.gen_range(0..chars.len())] as char)
        .collect()
}

pub struct AuthFlow {
    pub code_verifier: String,
}

impl AuthFlow {
    pub fn new() -> Self {
        Self {
            code_verifier: generate_random_string(50),
        }
    }

    /// Generate Magister OAuth2 login URL with PKCE S256 challenge.
    pub fn generate_login_url(&self, tenant: Option<&str>, username: Option<&str>) -> String {
        let nonce = generate_random_hex(32);
        let state = generate_random_string(50);

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

        let client = reqwest::Client::new();
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

    /// Discover the API endpoint for the authenticated user.
    pub async fn discover_api_endpoint(access_token: &str) -> Result<String, AuthError> {
        let client = reqwest::Client::new();
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
    pub async fn refresh_token(refresh_token: &str) -> Result<TokenResponse, AuthError> {
        let client = reqwest::Client::new();
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
            let text = resp.text().await.unwrap_or_default();
            return Err(AuthError::TokenRefreshFailed(text));
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
    #[error("HTTP request failed: {0}")]
    RequestFailed(String),
    #[error("Token exchange failed: {0}")]
    TokenExchangeFailed(String),
    #[error("Token refresh failed: {0}")]
    TokenRefreshFailed(String),
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
