//! Minimal manual cookie jar for the Magister challenge login sequence.
//!
//! The password-challenge flow (tenant → username → password → authorize)
//! requires one cookie session across many requests, mirroring MagisterPy's
//! explicit `requests.Session` handling. Kept manual (instead of reqwest's
//! `cookies` feature) so the jar stays inspectable: only cookie *names* are
//! ever logged, never values.

use std::collections::HashMap;

/// Name → value store. Values are secret-adjacent (session ids, XSRF tokens):
/// never log them, only names.
#[derive(Debug, Default)]
pub struct Jar {
    inner: HashMap<String, String>,
}

/// Parse one `Set-Cookie` header value into its `name=value` pair,
/// ignoring attributes (`Path`, `HttpOnly`, ...).
fn parse_set_cookie(raw: &str) -> Option<(String, String)> {
    let pair = raw.split(';').next()?;
    let mut kv = pair.splitn(2, '=');
    let k = kv.next()?.trim().to_string();
    let v = kv.next()?.trim().to_string();
    if k.is_empty() || v.is_empty() {
        return None;
    }
    Some((k, v))
}

impl Jar {
    /// Fold every `Set-Cookie` header of a response into the jar.
    pub fn store_from_response(&mut self, resp: &reqwest::Response) {
        for value in resp.headers().get_all(reqwest::header::SET_COOKIE) {
            if let Ok(raw) = value.to_str() {
                if let Some((k, v)) = parse_set_cookie(raw) {
                    self.inner.insert(k, v);
                }
            }
        }
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.inner.get(name).map(|s| s.as_str())
    }

    /// Cookie *names* only — safe to log.
    pub fn names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.inner.keys().map(|s| s.as_str()).collect();
        names.sort_unstable();
        names
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// Render the `Cookie` request header value.
    pub fn header_value(&self) -> String {
        self.inner
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_value_and_ignores_attributes() {
        assert_eq!(
            parse_set_cookie("XSRF-TOKEN=abc123; Path=/; HttpOnly"),
            Some(("XSRF-TOKEN".to_string(), "abc123".to_string()))
        );
        assert_eq!(parse_set_cookie("session=xyz; Secure"), Some(("session".to_string(), "xyz".to_string())));
        assert_eq!(parse_set_cookie("novalue"), None);
        assert_eq!(parse_set_cookie("=empty-name; Path=/"), None);
    }

    #[test]
    fn jar_roundtrip() {
        let mut jar = Jar::default();
        jar.inner.insert("a".to_string(), "1".to_string());
        assert!(jar.get("b").is_none());
        assert!(!jar.is_empty());
        assert_eq!(jar.names(), vec!["a"]);
        assert!(jar.header_value().contains("a=1"));
        assert!(Jar::default().is_empty());
    }
}
