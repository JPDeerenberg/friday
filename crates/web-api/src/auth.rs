//! Password-form login ported from the Phase-0 spike harness (proven live).
//!
//! One call = one full MagisterPy-compatible flow: authorize-entry →
//! sessionId/returnUrl → authcode → tenant/username/password challenges →
//! profile/app tokens → account/person → PKCE code exchange (Spike 0) →
//! refresh-capable token set. The password lives only in this call's stack
//! frame: it is never logged, stored, or returned.

use std::collections::HashMap;

use magister_core::auth::AuthFlow;
use magister_core::cookies::Jar;
use magister_core::jsparser;
use magister_core::tokens::TokenSet;

const ACCOUNTS: &str = "https://accounts.magister.net";

/// User-facing failure. Messages are Dutch, static, and secret-free.
#[derive(Debug)]
pub enum LoginError {
    /// 400: school/username/password missing, or SSO school.
    BadRequest(&'static str),
    /// 401: unknown school, wrong credentials, or cooldown.
    Unauthorized(&'static str),
    /// 429: Magister throttled us.
    UpstreamThrottled,
    /// 502: Magister unreachable or changed shape mid-flow.
    Upstream(String),
}

impl LoginError {
    pub fn status(&self) -> axum::http::StatusCode {
        match self {
            LoginError::BadRequest(_) => axum::http::StatusCode::BAD_REQUEST,
            LoginError::Unauthorized(_) => axum::http::StatusCode::UNAUTHORIZED,
            LoginError::UpstreamThrottled => axum::http::StatusCode::TOO_MANY_REQUESTS,
            LoginError::Upstream(_) => axum::http::StatusCode::BAD_GATEWAY,
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            LoginError::BadRequest(m) => m,
            LoginError::Unauthorized(m) => m,
            LoginError::UpstreamThrottled => "Magister is druk, probeer het over een minuut opnieuw.",
            LoginError::Upstream(_) => "Magister gaf een onverwacht antwoord, probeer het later opnieuw.",
        }
    }

    /// Server-side diagnostic, safe for Render logs (values redacted at
    /// construction). Never sent to the client — see `message()`.
    pub fn detail(&self) -> Option<&str> {
        match self {
            LoginError::Upstream(d) => Some(d),
            _ => None,
        }
    }
}

/// Redact sensitive query-param values (sessionId, PKCE state/nonce/code)
/// from a diagnostic string. Passwords and tokens never appear in URLs.
fn redact_query_values(msg: &str) -> String {
    let mut out = msg.to_string();
    for param in ["sessionId", "returnUrl", "code", "code_verifier", "state", "nonce"] {
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

impl From<reqwest::Error> for LoginError {
    fn from(e: reqwest::Error) -> Self {
        // Debug format carries the source chain (Display hides it); redacted.
        LoginError::Upstream(redact_query_values(&format!("{e:?}")))
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokensOut {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: String,
    pub api_endpoint: String,
    pub person_id: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOk {
    pub tokens: SessionTokensOut,
    pub account_id: String,
}

impl LoginOk {
    fn from_token_set(ts: TokenSet, account_id: String) -> Self {
        Self {
            tokens: SessionTokensOut {
                access_token: ts.access_token,
                refresh_token: ts.refresh_token,
                expires_at: ts.expires_at.to_rfc3339(),
                api_endpoint: ts.api_endpoint,
                person_id: ts.person_id,
            },
            account_id,
        }
    }
}

struct Session {
    client: reqwest::Client,
    jar: Jar,
}

impl Session {
    fn apply_cookies(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.jar.is_empty() {
            req
        } else {
            req.header("Cookie", self.jar.header_value())
        }
    }

    async fn get(&mut self, url: &str) -> Result<reqwest::Response, LoginError> {
        let resp = self.apply_cookies(self.client.get(url)).send().await?;
        self.jar.store_from_response(&resp);
        Ok(resp)
    }

    async fn get_with(
        &mut self,
        url: &str,
        params: &[(&str, &str)],
        bearer: Option<&str>,
    ) -> Result<reqwest::Response, LoginError> {
        // Scoped: `Serializer` is !Send and must not live across `.await`.
        let full = {
            let mut ser = url::form_urlencoded::Serializer::new(String::new());
            for (k, v) in params {
                ser.append_pair(k, v);
            }
            format!("{url}?{}", ser.finish())
        };
        let mut req = self.apply_cookies(self.client.get(full));
        if let Some(token) = bearer {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        let resp = req.send().await?;
        self.jar.store_from_response(&resp);
        Ok(resp)
    }

    async fn post_json(
        &mut self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<reqwest::Response, LoginError> {
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
}

fn header_location(resp: &reqwest::Response) -> Result<String, LoginError> {
    let raw = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| LoginError::Upstream(format!("no Location header (HTTP {})", resp.status())))?;
    Ok(url::Url::parse(resp.url().as_str())
        .map_err(|e| LoginError::Upstream(e.to_string()))?
        .join(&raw)
        .map_err(|e| LoginError::Upstream(e.to_string()))?
        .to_string())
}

fn fragment_access_token(location: &str) -> Option<String> {
    let parsed = url::Url::parse(&location.replace('#', "?")).ok()?;
    parsed.query_pairs().find(|(k, _)| k == "access_token").map(|(_, v)| v.to_string())
}

fn subdomain_of(host: &str) -> Option<String> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 2 {
        Some(parts[..parts.len() - 2].join("."))
    } else {
        None
    }
}

fn check_throttle(status: reqwest::StatusCode) -> Result<(), LoginError> {
    if status.as_u16() == 429 {
        return Err(LoginError::UpstreamThrottled);
    }
    Ok(())
}

/// Forced post-password actions Magister can demand (e.g. a school-wide
/// password reset policy). The challenge answers HTTP 200, but the session
/// is NOT authenticated until the user completes the action out-of-band —
/// without this check the flow fails later with a cryptic error.
fn forced_action_message(body: &serde_json::Value) -> Option<&'static str> {
    match body.get("action").and_then(|v| v.as_str()) {
        Some("changepassword") => Some(
            "Je school vereist een nieuw wachtwoord. Log eerst in via de Magister-website of -app, stel een nieuw wachtwoord in en probeer het daarna opnieuw.",
        ),
        Some(_) => Some(
            "Magister vereist eerst een extra stap op je account. Log in via de Magister-website of -app en probeer het daarna opnieuw.",
        ),
        None => None,
    }
}

/// Full login. `http` must be redirect-disabled (Policy::none).
pub async fn password_login(
    http: &reqwest::Client,
    school: &str,
    username: &str,
    password: &str,
) -> Result<LoginOk, LoginError> {
    if school.trim().is_empty() || username.trim().is_empty() || password.is_empty() {
        return Err(LoginError::BadRequest("Vul school, gebruikersnaam en wachtwoord in."));
    }
    let mut sess = Session { client: http.clone(), jar: Jar::default() };

    // 1. Enter via M6LOAPP authorize; follow 302s to /account/login?sessionId&returnUrl.
    let entry = AuthFlow::new();
    let entry_url = entry.generate_login_url(None, None);
    let mut r = sess.get(&entry_url).await?;
    for _ in 0..5 {
        if !r.status().is_redirection() {
            break;
        }
        let loc = header_location(&r)?;
        r = sess.get(&loc).await?;
    }
    let final_url = r.url().to_string();
    let query: HashMap<String, String> =
        url::Url::parse(&final_url).map_err(|e| LoginError::Upstream(e.to_string()))?.query_pairs().into_owned().collect();
    let session_id = query.get("sessionId").cloned().ok_or(LoginError::Upstream("no sessionId".into()))?;
    let return_url = query.get("returnUrl").cloned().ok_or(LoginError::Upstream("no returnUrl".into()))?;

    // SSO early-out: password challenges cannot work for federated schools.
    // (challenges/current reports the login capabilities of this session.)
    if let Ok(resp) = sess.post_json(&format!("{ACCOUNTS}/challenges/current"), &serde_json::json!({})).await {
        if let Ok(body) = resp.json::<serde_json::Value>().await {
            let idps = body.get("externalIdPs").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
            let has_authcode = body.get("authCode").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
            if idps > 0 && !has_authcode {
                return Err(LoginError::BadRequest(
                    "Deze school logt in via single sign-on — gebruik de desktop-app.",
                ));
            }
            if has_authcode {
                // Lucky path: session already carries an authcode, skip JS scrape.
                if let Some(a) = body.get("authCode").and_then(|v| v.as_str()) {
                    return finish_with_authcode(http, &mut sess, a, &session_id, &return_url, school, username, password).await;
                }
            }
        }
    }

    // 2. Authcode via defer JS bundle (proven live by the spike).
    let html = sess.get(&final_url).await?.text().await?;
    let script_src = jsparser::extract_defer_script_src(&html)
        .ok_or_else(|| LoginError::Upstream("login page changed shape".into()))?;
    let js_url = if script_src.starts_with("http") { script_src } else { format!("{ACCOUNTS}/{script_src}") };
    let js = sess.get(&js_url).await?.text().await?;
    let authcode = jsparser::extract_authcode(&js).map_err(|e| LoginError::Upstream(e.to_string()))?;

    finish_with_authcode(http, &mut sess, &authcode, &session_id, &return_url, school, username, password).await
}

#[allow(clippy::too_many_arguments)]
async fn finish_with_authcode(
    http: &reqwest::Client,
    sess: &mut Session,
    authcode: &str,
    session_id: &str,
    return_url: &str,
    school: &str,
    username: &str,
    password: &str,
) -> Result<LoginOk, LoginError> {
    let _ = http;
    let mut payload = serde_json::json!({
        "authCode": authcode,
        "returnUrl": return_url,
        "sessionId": session_id,
    });

    // 3. Tenant → username → password challenges.
    let search_resp = sess
        .get_with(
            &format!("{ACCOUNTS}/challenges/tenant/search"),
            &[("sessionId", session_id), ("key", school)],
            None,
        )
        .await?;
    check_throttle(search_resp.status())?;
    let search_text = search_resp.text().await?;
    let search: serde_json::Value =
        serde_json::from_str(&search_text).map_err(|_| LoginError::Unauthorized("School niet gevonden."))?;
    let tenant_id = search
        .get(0)
        .and_then(|t| t.get("id"))
        .and_then(|v| v.as_str())
        .ok_or(LoginError::Unauthorized("School niet gevonden."))?;
    payload["tenant"] = serde_json::Value::String(tenant_id.to_string());
    let r = sess.post_json(&format!("{ACCOUNTS}/challenges/tenant"), &payload).await?;
    check_throttle(r.status())?;
    if !r.status().is_success() {
        return Err(LoginError::Unauthorized("School niet gevonden."));
    }
    payload["username"] = serde_json::Value::String(username.to_string());
    let r = sess.post_json(&format!("{ACCOUNTS}/challenges/username"), &payload).await?;
    check_throttle(r.status())?;
    if !r.status().is_success() {
        return Err(LoginError::Unauthorized("Onbekende gebruikersnaam."));
    }
    payload["password"] = serde_json::Value::String(password.to_string());
    payload["userWantsToPairSoftToken"] = serde_json::Value::Bool(false);
    let r = sess.post_json(&format!("{ACCOUNTS}/challenges/password"), &payload).await?;
    check_throttle(r.status())?;
    if !r.status().is_success() {
        return Err(LoginError::Unauthorized("Onjuist wachtwoord, of even wachten bij te vaak proberen."));
    }
    // HTTP 200 is not the whole story: Magister can demand an out-of-band
    // action (e.g. forced password change) while leaving the session
    // unauthenticated. Surface that plainly instead of failing downstream.
    if let Ok(body) = r.json::<serde_json::Value>().await {
        if let Some(msg) = forced_action_message(&body) {
            return Err(LoginError::Unauthorized(msg));
        }
    }

    // 4. Profile token → api_url → app token → account/person.
    let profile_url = format!(
        "{ACCOUNTS}/connect/authorize?client_id=iam-profile&redirect_uri=https%3A%2F%2Faccounts.magister.net%2Fprofile%2Foidc%2Fredirect_callback.html&response_type=id_token%20token&scope=openid%20profile%20email%20magister.iam.profile&state=web&nonce=web"
    );
    let r = sess.get(&profile_url).await?;
    let profile_token = fragment_access_token(&header_location(&r)?)
        .ok_or_else(|| LoginError::Upstream("profile token missing".into()))?;
    let meta: serde_json::Value = sess
        .get_with("https://magister.net/.well-known/host-meta.json", &[], Some(&profile_token))
        .await?
        .json()
        .await?;
    let api_url = meta["links"][0]["href"]
        .as_str()
        .ok_or_else(|| LoginError::Upstream("api discovery failed".into()))?
        .to_string();
    let api_host = url::Url::parse(&api_url)
        .map_err(|e| LoginError::Upstream(e.to_string()))?
        .host_str()
        .unwrap_or_default()
        .to_string();
    let sub = subdomain_of(&api_host).unwrap_or_default();

    let r = sess
        .get_with(
            &format!("{ACCOUNTS}/connect/authorize"),
            &[
                ("client_id", format!("M6-{sub}.magister.net").as_str()),
                ("redirect_uri", format!("https://{sub}.magister.net/oidc/redirect_callback.html").as_str()),
                ("response_type", "id_token token"),
                ("scope", "openid profile"),
                ("state", "web"),
                ("nonce", "web"),
                ("acr_values", format!("tenant:{sub}.magister.net").as_str()),
            ],
            None,
        )
        .await?;
    let app_token = fragment_access_token(&header_location(&r)?)
        .ok_or_else(|| LoginError::Upstream("app token missing".into()))?;

    let current: serde_json::Value = sess
        .get_with(&format!("{api_url}/sessions/current"), &[], Some(&app_token))
        .await?
        .json()
        .await?;
    let account_href = current["links"]["account"]["href"].as_str().unwrap_or_default().to_string();
    let account_id = account_href.rsplit('/').next().unwrap_or_default().to_string();
    if account_id.is_empty() {
        return Err(LoginError::Upstream("account lookup failed".into()));
    }
    let acc: serde_json::Value = sess
        .get_with(&format!("{api_url}/accounts/{account_id}"), &[], Some(&app_token))
        .await?
        .json()
        .await?;
    let person_id: i64 = if let Some(h) = acc["links"]["leerling"]["href"].as_str() {
        h.rsplit('/').next().unwrap_or_default().parse().unwrap_or(0)
    } else if let Some(h) = acc["links"]["ouder"]["href"].as_str() {
        let parent_id = h.rsplit('/').next().unwrap_or_default();
        let kids: serde_json::Value = sess
            .get_with(&format!("{api_url}/personen/{parent_id}/kinderen"), &[], Some(&app_token))
            .await?
            .json()
            .await?;
        kids["Items"][0]["Id"].as_i64().unwrap_or(0)
    } else {
        0
    };
    if person_id == 0 {
        return Err(LoginError::Upstream("person lookup failed".into()));
    }

    // 5. Spike-0 exchange: warm session cookies + M6LOAPP PKCE → refresh_token.
    // Attempt 1: desktop-identical. Attempt 2: with tenant acr + login hint.
    for (tenant, login_hint) in [(None, None), (Some(format!("{sub}.magister.net")), Some(username.to_string()))] {
        let auth = AuthFlow::new();
        let url = auth.generate_login_url(tenant.as_deref(), login_hint.as_deref());
        let resp = sess.get(&url).await?;
        if !resp.status().is_redirection() {
            continue;
        }
        let Ok(loc) = header_location(&resp) else { continue };
        if !loc.starts_with("m6loapp://") {
            continue;
        }
        auth.verify_state(&loc).map_err(|e| LoginError::Upstream(e.to_string()))?;
        let tok = auth.exchange_code(&loc).await.map_err(|e| LoginError::Upstream(e.to_string()))?;
        auth.verify_id_token_nonce(&tok.id_token).map_err(|e| LoginError::Upstream(e.to_string()))?;
        let mut ts = TokenSet::from_response(&tok, &api_url);
        ts.person_id = Some(person_id);
        ts.account_uuid = Some(account_id.clone());
        return Ok(LoginOk::from_token_set(ts, account_id));
    }
    Err(LoginError::Upstream("sessie aanmaken mislukt, probeer het opnieuw".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_query_values_hides_secrets() {
        let msg = "url: \"https://x/search?sessionId=abc123&key=school\" state=zzz code=ccc";
        let out = redact_query_values(msg);
        assert!(!out.contains("abc123"), "{out}");
        assert!(!out.contains("state=zzz"), "{out}");
        assert!(!out.contains("code=ccc"), "{out}");
        assert!(out.contains("key=school"), "{out}");
    }

    #[test]
    fn forced_action_detection() {
        assert!(forced_action_message(&serde_json::json!({})).is_none());
        assert!(forced_action_message(&serde_json::json!({ "action": "changepassword" }))
            .unwrap()
            .contains("nieuw wachtwoord"));
        assert!(forced_action_message(&serde_json::json!({ "action": "something-else" }))
            .unwrap()
            .contains("extra stap"));
    }

    #[test]
    fn error_status_mapping() {        assert_eq!(LoginError::BadRequest("x").status(), axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(LoginError::Unauthorized("x").status(), axum::http::StatusCode::UNAUTHORIZED);
        assert_eq!(LoginError::UpstreamThrottled.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(LoginError::Upstream("x".into()).status(), axum::http::StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn login_ok_serializes_camel_case() {
        let ok = LoginOk {
            tokens: SessionTokensOut {
                access_token: "a".into(),
                refresh_token: "r".into(),
                expires_at: "t".into(),
                api_endpoint: "e".into(),
                person_id: Some(1),
            },
            account_id: "9".into(),
        };
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v["tokens"]["accessToken"], "a");
        assert_eq!(v["tokens"]["personId"], 1);
        assert_eq!(v["accountId"], "9");
    }
}
