//! Authcode extraction ported from `MagisterPy/MagisterPy/jsparser.py`.
//!
//! The login page loads a JS bundle whose URL is in a `<script defer src=...>`
//! tag; that bundle contains an obfuscated authcode (two adjacent JSON arrays:
//! a char pool and an index list) right before the literal `"].map((function(t)"`.
//! Faithful port of the Python logic, but each failure stage reports *which*
//! stage failed so a Magister frontend redeploy shows up as a precise error
//! instead of a bare `AuthcodeError`.
//!
//! Proven against the live bundle: the Phase-0 spike harness extracted a
//! working authcode with this exact logic.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum JsParserError {
    #[error("authcode marker not found in JS bundle")]
    MarkerNotFound,
    #[error("could not locate the two obfuscation arrays before the marker")]
    ArraysNotFound,
    #[error("obfuscation arrays are not valid JSON string lists: {0}")]
    InvalidArrays(String),
    #[error("index list contains a non-integer entry")]
    InvalidIndex,
    #[error("index {0} out of range for char pool of length {1}")]
    IndexOutOfRange(usize, usize),
}

/// Right-to-left nth occurrence of `sub` in `s` (Python `rfind` loop).
fn rfind_nth(s: &str, sub: &str, n: usize) -> Option<usize> {
    let mut idx = s.len();
    let mut found = None;
    for _ in 0..n {
        let found_at = s[..idx].rfind(sub)?;
        found = Some(found_at);
        idx = found_at;
    }
    found
}

/// Extract the dynamic authcode from the full text of the login JS bundle.
pub fn extract_authcode(js: &str) -> Result<String, JsParserError> {
    const MARKER: &str = "].map((function(t)";
    const WINDOW: usize = 200;

    let marker_at = js.find(MARKER).ok_or(JsParserError::MarkerNotFound)?;
    // `+1` keeps the closing `]` of the second array, mirroring the Python slice.
    let end = marker_at + 1;
    let start = end.saturating_sub(WINDOW);
    let window = &js[start..end];

    let arrays_at = rfind_nth(window, "[", 2).ok_or(JsParserError::ArraysNotFound)?;
    let mut slice = &window[arrays_at..];

    // Collect the first two `[...]` JSON lists in order.
    let mut lists: Vec<Vec<String>> = Vec::new();
    while lists.len() < 2 {
        let open = slice.find('[').ok_or(JsParserError::ArraysNotFound)?;
        let rest = &slice[open..];
        let close = rest.find(']').ok_or(JsParserError::ArraysNotFound)?;
        let candidate = &rest[..=close];
        let parsed: Vec<String> =
            serde_json::from_str(candidate).map_err(|e| JsParserError::InvalidArrays(e.to_string()))?;
        lists.push(parsed);
        slice = &rest[close + 1..];
    }

    let (pool, indices) = (&lists[0], &lists[1]);
    let mut authcode = String::new();
    for raw in indices {
        let i: usize = raw.parse().map_err(|_| JsParserError::InvalidIndex)?;
        let ch = pool.get(i).ok_or(JsParserError::IndexOutOfRange(i, pool.len()))?;
        authcode.push_str(ch);
    }
    Ok(authcode)
}

/// Find the `src` of the `<script defer ...>` tag in the login HTML.
/// String scan only — no HTML parser dependency.
pub fn extract_defer_script_src(html: &str) -> Option<String> {
    for tag in html.split("<script") {
        let end = tag.find('>')?;
        let head = &tag[..end];
        if !head.contains("defer") {
            continue;
        }
        let src_at = head.find("src=")?;
        let after = head[src_at + 4..].trim_start();
        let quote = after.chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let rest = &after[1..];
        let close = rest.find(quote)?;
        return Some(rest[..close].to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_authcode_from_synthetic_bundle() {
        let js = r#"var x=1;["q","w","e"]["2","0","1"]].map((function(t){return t})"#;
        assert_eq!(extract_authcode(js).unwrap(), "eqw");
    }

    #[test]
    fn reports_missing_marker() {
        assert!(matches!(
            extract_authcode("var x = 1;"),
            Err(JsParserError::MarkerNotFound)
        ));
    }

    #[test]
    fn extracts_defer_script_src() {
        let html = r#"<html><head><script defer="defer" src="login-abc123.js"></script></head></html>"#;
        assert_eq!(extract_defer_script_src(html).as_deref(), Some("login-abc123.js"));
        assert_eq!(extract_defer_script_src("<html></html>"), None);
    }
}
