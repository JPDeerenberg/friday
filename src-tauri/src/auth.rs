//! OAuth2 PKCE login flow for Magister (M6LOAPP client).
//!
//! Implementation moved to `magister_core::auth` so the web API can reuse
//! it. This module re-exports everything to keep all existing paths
//! (`crate::auth::AuthFlow`, ...) working unchanged.

pub use magister_core::auth::*;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

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
