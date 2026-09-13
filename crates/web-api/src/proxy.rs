//! Tier-A generic Magister proxy: fixed-path forwarding with zero
//! endpoint-specific code. The browser holds its own tokens; every request
//! carries them, the server stores nothing.
//!
//! SSRF guard: the target endpoint comes from the client (`X-Magister-Endpoint`
//! header, matching `WebBackend` in `src/lib/backend.ts`), so it is pinned to
//! `https://*.magister.net`. Anything else is rejected before any I/O.

use axum::body::Bytes;

/// Build the upstream URL. Pure — unit-tested.
pub fn upstream_url(endpoint: &str, path: &str, query: Option<&str>) -> Result<String, &'static str> {
    let ep = endpoint.trim_end_matches('/');
    let parsed = url::Url::parse(ep).map_err(|_| "Ongeldig Magister-adres.")?;
    if parsed.scheme() != "https" {
        return Err("Ongeldig Magister-adres.");
    }
    let host = parsed.host_str().unwrap_or_default();
    if host != "magister.net" && !host.ends_with(".magister.net") {
        return Err("Ongeldig Magister-adres.");
    }
    let mut url = format!("{ep}/{}", path.trim_start_matches('/'));
    if let Some(q) = query {
        if !q.is_empty() {
            url.push('?');
            url.push_str(q);
        }
    }
    Ok(url)
}

/// Retry delays for upstream 429s, mirroring `client.rs` (2s, 4s, 8s).
pub const RATE_LIMIT_BACKOFF_SECS: [u64; 3] = [2, 4, 8];

/// A 401 whose body shows the access token itself expired (same match as
/// `client.rs::is_expired_token_body`): the frontend must refresh and retry.
pub fn is_expired_token_body(text: &str) -> bool {
    text.contains("SecurityToken Expired") || text.contains("invalid_token")
}

/// Forward one request with 429 retries. Returns (status, content-type, bytes).
pub async fn forward(
    http: &reqwest::Client,
    method: axum::http::Method,
    url: String,
    bearer: String,
    content_type: Option<String>,
    body: Bytes,
) -> Result<(u16, Option<String>, Bytes), reqwest::Error> {
    for (attempt, backoff) in RATE_LIMIT_BACKOFF_SECS.iter().enumerate() {
        let mut req = http.request(method.clone(), &url).header("Authorization", format!("Bearer {bearer}"));
        if let Some(ct) = &content_type {
            req = req.header("Content-Type", ct.clone());
        }
        if !body.is_empty() {
            req = req.body(body.clone());
        }
        let resp = req.send().await?;
        if resp.status().as_u16() == 429 {
            if attempt + 1 < RATE_LIMIT_BACKOFF_SECS.len() {
                tokio::time::sleep(std::time::Duration::from_secs(*backoff)).await;
                continue;
            }
            return Ok((429, None, Bytes::from_static(b"{\"error\":\"Te veel verzoeken\"}")));
        }
        let status = resp.status().as_u16();
        let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
        let bytes = resp.bytes().await?;
        return Ok((status, ct, bytes));
    }
    unreachable!("backoff loop always returns")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_upstream_url() {
        let u = upstream_url("https://hlml.magister.net/", "/personen/1/afspraken", Some("van=2026-01-01")).unwrap();
        assert_eq!(u, "https://hlml.magister.net/personen/1/afspraken?van=2026-01-01");
        assert!(upstream_url("https://hlml.magister.net", "account", None).unwrap().ends_with("/account"));
    }

    #[test]
    fn rejects_non_magister_endpoints() {
        assert!(upstream_url("http://hlml.magister.net/x", "", None).is_err());
        assert!(upstream_url("https://evil.example.com/", "x", None).is_err());
        assert!(upstream_url("https://magister.net.evil.com/x", "", None).is_err());
        assert!(upstream_url("not a url", "", None).is_err());
        // Bare magister.net itself is fine.
        assert!(upstream_url("https://magister.net/", "x", None).is_ok());
    }

    #[test]
    fn expired_token_detection_matches_client() {
        assert!(is_expired_token_body("SecurityToken Expired"));
        assert!(is_expired_token_body("{\"error\":\"invalid_token\"}"));
        assert!(!is_expired_token_body("Unauthorized"));
    }
}
