//! BYO-key AI proxy: forwards chat/validate calls to the user's own provider
//! account. The API key lives in the browser (IndexedDB) and travels here
//! per-request, in memory only — never logged, never stored, never cached.
//!
//! Wire formats mirror `src-tauri/src/ai/providers/` exactly (OpenAI-family,
//! Anthropic, Gemini) so the browser-side tool loop speaks the same protocol
//! as the desktop loop.

use serde::{Deserialize, Serialize};
use std::pin::Pin;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessageIn {
    pub role: String,
    pub content: String,
    // The web loop speaks the same snake_case as the desktop AiMessage;
    // accept both spellings at this boundary.
    #[serde(default, alias = "tool_call_id")]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, alias = "tool_calls")]
    pub tool_calls: Option<Vec<ToolCallIn>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallIn {
    pub id: String,
    pub name: String,
    #[serde(alias = "args")]
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefIn {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub messages: Vec<AiMessageIn>,
    #[serde(default)]
    pub tools: Vec<ToolDefIn>,
    /// Ask for server-sent events (`text` deltas + final `done`) instead of
    /// one JSON body. OpenAI-family streams natively; other providers fall
    /// back to a single-shot response wrapped in the same events.
    #[serde(default)]
    pub stream: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallOut {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub content: String,
    pub tool_calls: Vec<ToolCallOut>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateRequest {
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    pub api_key: String,
}

fn default_base_url(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "https://api.anthropic.com",
        "gemini" => "https://generativelanguage.googleapis.com",
        "deepseek" => "https://api.deepseek.com/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "openai_compatible" => "https://api.groq.com/openai/v1",
        _ => "https://api.openai.com/v1",
    }
}

/// Custom endpoints exist for local/compatible providers (Ollama, Groq,
/// OpenRouter) — but an API key over plaintext HTTP is only acceptable on
/// loopback. Anything else must be https.
pub fn check_base_url(provider: &str, base_url: &str) -> Result<String, String> {
    // Anthropic/Gemini endpoints are hardcoded upstream (like desktop) —
    // a custom base is accepted syntactically but never used.
    if matches!(provider, "anthropic" | "gemini") {
        return Ok(default_base_url(provider).to_string());
    }
    let base = if base_url.trim().is_empty() {
        default_base_url(provider).to_string()
    } else {
        base_url.trim().trim_end_matches('/').to_string()
    };
    let parsed = url::Url::parse(&base).map_err(|_| "Ongeldige provider-URL.".to_string())?;
    let is_loopback = matches!(
        parsed.host_str().unwrap_or_default(),
        "localhost" | "127.0.0.1" | "::1"
    );
    match parsed.scheme() {
        "https" => Ok(base),
        "http" if is_loopback => Ok(base),
        "http" => Err("Alleen https of lokale (localhost) provider-URL's.".to_string()),
        _ => Err("Ongeldige provider-URL.".to_string()),
    }
}

fn is_openai_family(provider: &str) -> bool {
    matches!(provider, "openai" | "openai_compatible" | "deepseek" | "mistral")
}

fn extract_error_message(raw: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|b| {
            b.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| {
            let t: String = raw.chars().take(500).collect();
            format!("Onverwacht foutformaat: {t}")
        })
}

fn extract_error_type(raw: &str) -> Option<(String, String)> {
    let err = serde_json::from_str::<serde_json::Value>(raw).ok()?.get("error")?.clone();
    let t = err.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if t.is_empty() {
        return None;
    }
    let code = err
        .get("code")
        .map(|v| {
            if let Some(s) = v.as_str() {
                s.to_string()
            } else {
                v.to_string()
            }
        })
        .unwrap_or_default();
    Some((t, code))
}

fn provider_error(provider: &str, status: u16, raw: &str) -> String {
    let label = match provider {
        "anthropic" => "Anthropic",
        "gemini" => "Gemini",
        _ => "AI",
    };
    if status == 401 || status == 403 {
        return format!("{label}: ongeldige API-sleutel (HTTP {status}).");
    }
    if status == 429 {
        return format!("{label}: te veel verzoeken, wacht even (HTTP 429).");
    }
    let base = format!(
        "{label}-fout (HTTP {status}): {}",
        extract_error_message(raw)
    );
    // Keep the provider's machine-readable type/code (e.g. Mistral's
    // `invalid_request_assistant_message`/3240) so the client can classify
    // the failure and log it in diagnostics. No content, no keys.
    match extract_error_type(raw) {
        Some((t, c)) if !c.is_empty() => format!("{base} (type={t}, code={c})"),
        Some((t, _)) => format!("{base} (type={t})"),
        None => base,
    }
}

/// Shape of one message for 4xx diagnostics, e.g. `assistant(c0,t1)`.
/// Roles only — never content, never keys.
fn message_shape_in(role: &str, has_content: bool, tool_count: usize) -> String {
    if role == "assistant" {
        format!(
            "assistant(c{},t{})",
            if has_content { 1 } else { 0 },
            tool_count
        )
    } else {
        role.to_string()
    }
}

/// Shapes of a whole history for 4xx diagnostics (roles only).
pub fn history_shape(messages: &[AiMessageIn]) -> Vec<String> {
    messages
        .iter()
        .map(|m| {
            let tools = m
                .tool_calls
                .as_ref()
                .map(|tcs| tcs.iter().filter(|tc| !tc.name.is_empty()).count())
                .unwrap_or(0);
            message_shape_in(&m.role, !m.content.trim().is_empty(), tools)
        })
        .collect()
}

// ─── OpenAI-family (openai, deepseek, mistral, openai_compatible) ───────────

/// Next unused `call_<n>` id (never collides with `used`).
fn fresh_call_id(used: &std::collections::HashSet<String>, counter: &mut u32) -> String {
    loop {
        *counter += 1;
        let candidate = format!("call_{counter}");
        if !used.contains(&candidate) {
            return candidate;
        }
    }
}

fn openai_messages(messages: &[AiMessageIn]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    // Final ids emitted on assistant messages so far (in order). A tool
    // message is kept only when its id was emitted by a *preceding*
    // assistant message — orphan tool results are rejected by strict
    // providers (Mistral 400).
    let mut preceding_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    // New ids minted for empty original ids, in order, so a tool message
    // that echoes the empty id stays linked to its call.
    let mut empty_renames: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut counter: u32 = 0;
    for m in messages {
        if m.role == "assistant" {
            let mut cleaned: Vec<serde_json::Value> = Vec::new();
            if let Some(tcs) = &m.tool_calls {
                for tc in tcs {
                    // Drop calls with an empty name (the model sent junk).
                    if tc.name.is_empty() {
                        continue;
                    }
                    let id = if tc.id.is_empty() || preceding_ids.contains(&tc.id) {
                        let fresh = fresh_call_id(&preceding_ids, &mut counter);
                        if tc.id.is_empty() {
                            empty_renames.push_back(fresh.clone());
                        }
                        fresh
                    } else {
                        tc.id.clone()
                    };
                    // Reserve even the kept originals so later duplicates
                    // (and fresh ids) can never collide with them.
                    preceding_ids.insert(id.clone());
                    cleaned.push(serde_json::json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": serde_json::to_string(&tc.arguments).unwrap_or_default(),
                        }
                    }));
                }
            }
            // Drop assistant messages with empty/whitespace content and no
            // (surviving) tool calls: Mistral rejects them with
            // `invalid_request_assistant_message` (HTTP 400). An empty
            // content *with* tool calls stays (existing replay contract).
            if m.content.trim().is_empty() && cleaned.is_empty() {
                continue;
            }
            let mut msg = serde_json::json!({ "role": m.role, "content": m.content });
            // Omit `tool_calls` when empty — never send an empty array.
            if !cleaned.is_empty() {
                msg["tool_calls"] = serde_json::Value::Array(cleaned);
            }
            out.push(msg);
        } else if m.role == "tool" {
            let mut tid = m.tool_call_id.clone().unwrap_or_default();
            if tid.is_empty() {
                // Re-link to the matching renamed empty id, if any.
                match empty_renames.pop_front() {
                    Some(relinked) => tid = relinked,
                    None => continue,
                }
            }
            if !preceding_ids.contains(&tid) {
                continue;
            }
            let mut msg = serde_json::json!({ "role": m.role, "content": m.content });
            msg["tool_call_id"] = serde_json::Value::String(tid);
            if let Some(name) = &m.name {
                msg["name"] = serde_json::Value::String(name.clone());
            }
            out.push(msg);
        } else {
            out.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
    }
    out
}

fn parse_openai_response(body: &serde_json::Value) -> Result<(String, Vec<ToolCallOut>), String> {
    let choice = body
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "Geen antwoord van AI".to_string())?;
    let content = choice
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let mut tool_calls = Vec::new();
    if let Some(tcs) = choice.get("message").and_then(|m| m.get("tool_calls")).and_then(|t| t.as_array()) {
        for tc in tcs {
            let args_str = tc
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
                .unwrap_or("{}");
            tool_calls.push(ToolCallOut {
                id: tc.get("id").and_then(|v| v.as_str()).unwrap_or("call_unknown").to_string(),
                name: tc.get("function").and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                // Unparseable arguments stay a string so the loop reports
                // bad arguments instead of executing a null call.
                arguments: serde_json::from_str(args_str)
                    .unwrap_or_else(|_| serde_json::Value::String(args_str.to_string())),
            });
        }
    }
    Ok((content, tool_calls))
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

fn anthropic_messages(messages: &[AiMessageIn]) -> (String, Vec<serde_json::Value>) {
    let system = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.clone())
        .collect::<Vec<_>>()
        .join("\n\n");
    let rest = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            if m.role == "tool" {
                serde_json::json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": m.tool_call_id.as_deref().unwrap_or("toolu_unknown"),
                        "content": m.content
                    }]
                })
            } else if m.role == "assistant" && m.tool_calls.is_some() {
                let mut blocks: Vec<serde_json::Value> = if m.content.is_empty() {
                    vec![]
                } else {
                    vec![serde_json::json!({"type": "text", "text": m.content})]
                };
                if let Some(tcs) = &m.tool_calls {
                    for tc in tcs {
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": tc.arguments
                        }));
                    }
                }
                serde_json::json!({ "role": "assistant", "content": blocks })
            } else {
                serde_json::json!({ "role": m.role, "content": m.content })
            }
        })
        .collect();
    (system, rest)
}

fn parse_anthropic_response(body: &serde_json::Value) -> Result<(String, Vec<ToolCallOut>), String> {
    let mut tool_calls = Vec::new();
    let mut texts = Vec::new();
    if let Some(blocks) = body.get("content").and_then(|c| c.as_array()) {
        for block in blocks {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        texts.push(t.to_string());
                    }
                }
                Some("tool_use") => tool_calls.push(ToolCallOut {
                    id: block.get("id").and_then(|v| v.as_str()).unwrap_or("toolu_unknown").to_string(),
                    name: block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    arguments: block.get("input").cloned().unwrap_or(serde_json::Value::Null),
                }),
                _ => {}
            }
        }
    }
    Ok((texts.join(""), tool_calls))
}

// ─── Gemini ────────────────────────────────────────────────────────────────

fn gemini_contents(messages: &[AiMessageIn]) -> (Vec<String>, Vec<serde_json::Value>) {
    let system: Vec<String> = messages.iter().filter(|m| m.role == "system").map(|m| m.content.clone()).collect();
    let contents = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            let role = match m.role.as_str() {
                "assistant" => "model",
                "tool" => "function",
                _ => "user",
            };
            if m.role == "tool" {
                serde_json::json!({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "name": m.name.as_deref().unwrap_or("unknown"),
                            "response": {
                                "name": m.name.as_deref().unwrap_or("unknown"),
                                "content": m.content
                            }
                        }
                    }]
                })
            } else if m.role == "assistant" && m.tool_calls.is_some() {
                let mut parts: Vec<serde_json::Value> = if m.content.is_empty() {
                    vec![]
                } else {
                    vec![serde_json::json!({"text": m.content})]
                };
                if let Some(tcs) = &m.tool_calls {
                    for tc in tcs {
                        parts.push(serde_json::json!({
                            "functionCall": { "name": tc.name, "args": tc.arguments }
                        }));
                    }
                }
                serde_json::json!({ "role": role, "parts": parts })
            } else {
                serde_json::json!({ "role": role, "parts": [{"text": m.content}] })
            }
        })
        .collect();
    (system, contents)
}

fn parse_gemini_response(body: &serde_json::Value) -> Result<(String, Vec<ToolCallOut>), String> {
    let parts = body
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    let mut tool_calls = Vec::new();
    let mut texts = Vec::new();
    let mut counter = 0u32;
    for part in &parts {
        if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
            texts.push(t.to_string());
        }
        if let Some(fc) = part.get("functionCall") {
            counter += 1;
            tool_calls.push(ToolCallOut {
                // Gemini gives no call id — synthesize a stable one so the
                // browser loop can correlate calls with results.
                id: format!("gemini-call-{counter}"),
                name: fc.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                arguments: fc.get("args").cloned().unwrap_or(serde_json::Value::Null),
            });
        }
    }
    Ok((texts.join(""), tool_calls))
}

// ─── Entry points (called from main.rs handlers) ───────────────────────────

pub async fn chat(http: &reqwest::Client, mut req: ChatRequest) -> Result<ChatResponse, (u16, String)> {
    // Defensive trim: pasted keys/URLs/models with stray whitespace fail with
    // a bare provider 401 that looks exactly like a wrong key.
    req.api_key = req.api_key.trim().to_string();
    req.model = req.model.trim().to_string();
    req.base_url = req.base_url.trim().to_string();
    if req.api_key.is_empty() {
        return Err((400, "Geen API-sleutel ingesteld.".to_string()));
    }
    if req.model.is_empty() {
        return Err((400, "Geen model gekozen.".to_string()));
    }
    let base = check_base_url(&req.provider, &req.base_url).map_err(|m| (400, m))?;

    let openai_tools: Vec<serde_json::Value> = req
        .tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": { "name": t.name, "description": t.description, "parameters": t.parameters }
            })
        })
        .collect();

    enum Target {
        OpenAI { url: String, key: String },
        Anthropic { key: String },
        Gemini { url: String },
    }
    let target = match req.provider.as_str() {
        "anthropic" => Target::Anthropic { key: req.api_key.clone() },
        "gemini" => Target::Gemini {
            url: format!(
                "https://generativelanguage.googleapis.com/v1/models/{}:generateContent?key={}",
                req.model, req.api_key
            ),
        },
        _ => Target::OpenAI {
            url: format!("{}/chat/completions", base.trim_end_matches('/')),
            key: req.api_key.clone(),
        },
    };

    // Build the provider-specific request. The key travels only in the
    // Authorization/header/query below — request bodies are never logged.
    let http_req = match &target {
        Target::OpenAI { url, key } => {
            let mut body = serde_json::json!({
                "model": req.model,
                "messages": openai_messages(&req.messages),
                "temperature": 0.7,
                "max_tokens": 4096,
            });
            if !openai_tools.is_empty() {
                body["tools"] = serde_json::Value::Array(openai_tools);
                body["tool_choice"] = serde_json::Value::String("auto".to_string());
            }
            http
                .post(url)
                .header("Authorization", format!("Bearer {key}"))
                .header("Content-Type", "application/json")
                .json(&body)
        }
        Target::Anthropic { key } => {
            let (system, rest) = anthropic_messages(&req.messages);
            let mut body = serde_json::json!({
                "model": req.model,
                "max_tokens": 4096,
                "messages": rest,
            });
            if !system.is_empty() {
                body["system"] = serde_json::Value::String(system);
            }
            if !req.tools.is_empty() {
                body["tools"] = serde_json::Value::Array(
                    req.tools
                        .iter()
                        .map(|t| {
                            serde_json::json!({
                                "name": t.name,
                                "description": t.description,
                                "input_schema": t.parameters
                            })
                        })
                        .collect(),
                );
            }
            http
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .header("Content-Type", "application/json")
                .json(&body)
        }
        Target::Gemini { url } => {
            let (system, contents) = gemini_contents(&req.messages);
            let mut body = serde_json::json!({
                "contents": contents,
                "generationConfig": { "temperature": 0.7, "maxOutputTokens": 4096 },
            });
            if !system.is_empty() {
                body["systemInstruction"] = serde_json::json!({ "parts": [{"text": system.join("\n\n")}] });
            }
            if !req.tools.is_empty() {
                body["tools"] = serde_json::json!([{
                    "functionDeclarations": req.tools.iter().map(|t| {
                        serde_json::json!({
                            "name": t.name, "description": t.description, "parameters": t.parameters
                        })
                    }).collect::<Vec<_>>()
                }]);
            }
            http.post(url).header("Content-Type", "application/json").json(&body)
        }
    };

    let resp = http_req.send().await.map_err(|_| (502, "AI-verbinding mislukt.".to_string()))?;
    let status = resp.status().as_u16();
    let raw = resp.text().await.unwrap_or_default();
    if status < 200 || status >= 300 {
        // Message *shapes* only (roles + content/tool-call counts) — never
        // content, never keys. Diagnoses 400s like Mistral's
        // `invalid_request_assistant_message` from the server logs.
        eprintln!(
            "ai proxy: {} -> HTTP {} shape={:?}",
            req.provider,
            status,
            history_shape(&req.messages)
        );
        return Err((status, provider_error(&req.provider, status, &raw)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| (502, "Kon AI-antwoord niet lezen.".to_string()))?;
    let (content, tool_calls) = match req.provider.as_str() {
        "anthropic" => parse_anthropic_response(&parsed),
        "gemini" => parse_gemini_response(&parsed),
        _ => parse_openai_response(&parsed),
    }
    .map_err(|m| (502, m))?;
    Ok(ChatResponse { content, tool_calls })
}

pub async fn validate(http: &reqwest::Client, mut req: ValidateRequest) -> Result<bool, (u16, String)> {
    req.api_key = req.api_key.trim().to_string();
    req.model = req.model.trim().to_string();
    req.base_url = req.base_url.trim().to_string();
    if req.api_key.is_empty() {
        return Err((400, "Geen API-sleutel ingesteld.".to_string()));
    }
    let base = check_base_url(&req.provider, &req.base_url).map_err(|m| (400, m))?;
    let resp = match req.provider.as_str() {
        "anthropic" => {
            let body = serde_json::json!({
                "model": if req.model.is_empty() { "claude-sonnet-4-20250514".to_string() } else { req.model.clone() },
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "Hi"}],
            });
            http.post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", &req.api_key)
                .header("anthropic-version", "2023-06-01")
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
        }
        "gemini" => {
            http.get(format!(
                "https://generativelanguage.googleapis.com/v1/models?key={}",
                req.api_key
            ))
            .send()
            .await
        }
        _ => {
            http.get(format!("{}/models", base.trim_end_matches('/')))
                .header("Authorization", format!("Bearer {}", req.api_key))
                .send()
                .await
        }
    }
    .map_err(|_| (502, "AI-verbinding mislukt.".to_string()))?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err((401, "Ongeldige API-sleutel.".to_string()));
    }
    if !(200..300).contains(&status) {
        let raw = resp.text().await.unwrap_or_default();
        return Err((status, provider_error(&req.provider, status, &raw)));
    }
    Ok(true)
}

pub async fn list_models(http: &reqwest::Client, mut req: ValidateRequest) -> Result<Vec<String>, (u16, String)> {
    req.api_key = req.api_key.trim().to_string();
    req.base_url = req.base_url.trim().to_string();
    if req.api_key.is_empty() {
        return Err((400, "Geen API-sleutel ingesteld.".to_string()));
    }
    if !is_openai_family(&req.provider) {
        return Ok(vec![]); // mirrors desktop default (only OpenAI-family lists)
    }
    let base = check_base_url(&req.provider, &req.base_url).map_err(|m| (400, m))?;
    let resp = http
        .get(format!("{}/models", base.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {}", req.api_key))
        .send()
        .await
        .map_err(|_| (502, "AI-verbinding mislukt.".to_string()))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let raw = resp.text().await.unwrap_or_default();
        return Err((status, provider_error(&req.provider, status, &raw)));
    }
    let body: serde_json::Value = resp.json().await.map_err(|_| (502, "Kon antwoord niet lezen.".to_string()))?;
    let mut models: Vec<String> = body
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| arr.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string())).collect())
        .unwrap_or_default();
    models.sort();
    Ok(models)
}

// ─── Streaming (SSE pass-through for the OpenAI family) ────────────────────
// Unified browser protocol: `text` events carry deltas, a final `done` event
// carries the assembled `{content, toolCalls}`. Anything else falls back to
// the single-shot path wrapped in the same events, so the frontend only ever
// speaks one protocol.

/// Split complete SSE frames (`\n\n`-separated) off the front of `buf`.
/// Returns the `data:` payloads; the remainder stays buffered for the next
/// chunk (provider chunks can split mid-line).
pub fn split_sse_frames(buf: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buf.find("\n\n") {
        let frame: String = buf.drain(..pos + 2).collect();
        let mut data: Vec<&str> = Vec::new();
        for line in frame.lines() {
            if let Some(payload) = line.strip_prefix("data:") {
                data.push(payload.trim_start());
            }
            // `event:`/`id:`/`:comment` lines carry no payload for us.
        }
        if !data.is_empty() {
            out.push(data.join("\n"));
        }
    }
    out
}

/// One tool call being assembled from stream deltas, keyed by `index`.
#[derive(Default)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Feed one provider SSE `data:` payload into the assembly. Returns the text
/// delta to forward (if any). `[DONE]` and unparseable frames yield nothing.
pub fn apply_openai_delta(
    payload: &str,
    content: &mut String,
    calls: &mut std::collections::BTreeMap<u32, PendingToolCall>,
) -> Option<String> {
    if payload.trim() == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let delta = v
        .get("choices")?
        .as_array()?
        .first()?
        .get("delta")?;
    let mut text = String::new();
    if let Some(t) = delta.get("content").and_then(|c| c.as_str()) {
        if !t.is_empty() {
            content.push_str(t);
            text.push_str(t);
        }
    }
    if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
        for (pos, tc) in tcs.iter().enumerate() {
            let idx = tc
                .get("index")
                .and_then(|i| i.as_u64())
                .unwrap_or(pos as u64) as u32;
            let incoming_id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            // A delta for an already-named index that carries a *different*
            // non-empty id starts a new call instead of appending: some
            // providers reuse `index` across parallel calls, and appending
            // would concatenate two argument streams into invalid JSON.
            let key = match calls.get(&idx) {
                Some(existing)
                    if !existing.id.is_empty()
                        && !incoming_id.is_empty()
                        && existing.id != incoming_id =>
                {
                    let mut free = calls.keys().max().map(|m| m + 1).unwrap_or(0);
                    while calls.contains_key(&free) {
                        free += 1;
                    }
                    free
                }
                _ => idx,
            };
            let entry = calls.entry(key).or_default();
            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                if !id.is_empty() && entry.id.is_empty() {
                    entry.id = id.to_string();
                }
            }
            if let Some(name) = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
            {
                if !name.is_empty() && entry.name.is_empty() {
                    entry.name = name.to_string();
                }
            }
            if let Some(args) = tc
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
            {
                entry.arguments.push_str(args);
            }
        }
    }
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn assemble_tool_calls(calls: std::collections::BTreeMap<u32, PendingToolCall>) -> Vec<ToolCallOut> {
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut counter: u32 = 0;
    let mut out = Vec::new();
    for (_, c) in calls {
        // Nameless fragments carry no callable tool — drop them.
        if c.name.is_empty() {
            continue;
        }
        let id = if c.id.is_empty() || used.contains(&c.id) {
            fresh_call_id(&used, &mut counter)
        } else {
            c.id
        };
        used.insert(id.clone());
        // Empty argument streams mean `{}`; unparseable streams stay a
        // string so the loop reports bad arguments instead of a null call.
        let arguments = if c.arguments.trim().is_empty() {
            serde_json::Value::Object(serde_json::Map::new())
        } else {
            serde_json::from_str(&c.arguments)
                .unwrap_or_else(|_| serde_json::Value::String(c.arguments.clone()))
        };
        out.push(ToolCallOut {
            id,
            name: c.name,
            arguments,
        });
    }
    out
}

fn sse_data(event: &str, json: &str) -> axum::response::sse::Event {
    axum::response::sse::Event::default()
        .event(event)
        .data(json)
}

/// Stream one chat turn to the browser. OpenAI-family providers stream
/// natively; Anthropic/Gemini fall back to a single-shot call wrapped in
/// the same events. Upstream HTTP errors surface as JSON errors before any
/// event, exactly like the non-streaming path.
pub async fn chat_stream(
    http: &reqwest::Client,
    mut req: ChatRequest,
) -> Result<
    axum::response::sse::Sse<
        axum::response::sse::KeepAliveStream<
            Pin<
                Box<
                    dyn futures_core::Stream<
                            Item = Result<
                                axum::response::sse::Event,
                                std::convert::Infallible,
                            >,
                        > + Send,
                >,
            >,
        >,
    >,
    (u16, String),
> {
    req.api_key = req.api_key.trim().to_string();
    req.model = req.model.trim().to_string();
    req.base_url = req.base_url.trim().to_string();
    if req.api_key.is_empty() {
        return Err((400, "Geen API-sleutel ingesteld.".to_string()));
    }
    if req.model.is_empty() {
        return Err((400, "Geen model gekozen.".to_string()));
    }

    if !is_openai_family(&req.provider) {
        // No native SSE path here: run single-shot, wrap in events.
        return match chat(http, req).await {
            Ok(out) => {
                let text = serde_json::to_string(&serde_json::json!({ "delta": out.content }))
                    .unwrap_or_default();
                let done = serde_json::to_string(&serde_json::json!({
                    "content": out.content, "toolCalls": out.tool_calls
                }))
                .unwrap_or_default();
                let stream = async_stream::stream! {
                    yield Ok(sse_data("text", &text));
                    yield Ok(sse_data("done", &done));
                };
                Ok(axum::response::sse::Sse::new(
                    Box::pin(stream)
                        as Pin<
                            Box<
                                dyn futures_core::Stream<
                                        Item = Result<
                                            axum::response::sse::Event,
                                            std::convert::Infallible,
                                        >,
                                    > + Send,
                            >,
                        >,
                )
                .keep_alive(axum::response::sse::KeepAlive::default()))
            }
            Err(e) => Err(e),
        };
    }

    let base = check_base_url(&req.provider, &req.base_url).map_err(|m| (400, m))?;
    let openai_tools: Vec<serde_json::Value> = req
        .tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": { "name": t.name, "description": t.description, "parameters": t.parameters }
            })
        })
        .collect();
    let mut body = serde_json::json!({
        "model": req.model,
        "messages": openai_messages(&req.messages),
        "temperature": 0.7,
        "max_tokens": 4096,
        "stream": true,
    });
    if !openai_tools.is_empty() {
        body["tools"] = serde_json::Value::Array(openai_tools);
        body["tool_choice"] = serde_json::Value::String("auto".to_string());
    }
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let mut resp = http
        .post(&url)
        .header("Authorization", format!("Bearer {}", req.api_key))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(|_| (502, "AI-verbinding mislukt.".to_string()))?;
    let status = resp.status().as_u16();
    if status < 200 || status >= 300 {
        let raw = resp.text().await.unwrap_or_default();
        eprintln!(
            "ai proxy: {} -> HTTP {} shape={:?}",
            req.provider,
            status,
            history_shape(&req.messages)
        );
        return Err((status, provider_error(&req.provider, status, &raw)));
    }

    let stream = async_stream::stream! {
        let mut buf = String::new();
        let mut content = String::new();
        let mut calls: std::collections::BTreeMap<u32, PendingToolCall> = std::collections::BTreeMap::new();
        loop {
            match resp.chunk().await {
                Err(_) => {
                    let msg = serde_json::to_string(
                        &serde_json::json!({ "message": "AI-verbinding verbroken." }),
                    )
                    .unwrap_or_default();
                    yield Ok(sse_data("error", &msg));
                    break;
                }
                Ok(None) => break,
                Ok(Some(bytes)) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));
                }
            }
            for payload in split_sse_frames(&mut buf) {
                if let Some(delta) = apply_openai_delta(&payload, &mut content, &mut calls) {
                    let msg = serde_json::to_string(&serde_json::json!({ "delta": delta }))
                        .unwrap_or_default();
                    yield Ok(sse_data("text", &msg));
                }
            }
        }
        let tool_calls = assemble_tool_calls(calls);
        let done = serde_json::to_string(&serde_json::json!({
            "content": content,
            "toolCalls": tool_calls,
        }))
        .unwrap_or_default();
        yield Ok(sse_data("done", &done));
    };
    Ok(
        axum::response::sse::Sse::new(
            Box::pin(stream)
                as Pin<
                    Box<
                        dyn futures_core::Stream<
                                Item = Result<axum::response::sse::Event, std::convert::Infallible>,
                            > + Send,
                    >,
                >,
        )
        .keep_alive(axum::response::sse::KeepAlive::default()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_accepts_snake_case_tool_keys() {
        // The web loop replays assistant tool calls the same way the
        // desktop AiMessage serializes (snake_case); the camelCase proxy
        // contract must accept both spellings or strict providers
        // (Mistral) reject the turn.
        let body: ChatRequest = serde_json::from_value(serde_json::json!({
            "provider": "mistral",
            "model": "mistral-small-latest",
            "apiKey": "x",
            "messages": [
                {"role": "user", "content": "hoe laat is het?"},
                {"role": "assistant", "content": "",
                 "tool_calls": [{"id": "c1", "name": "get_current_time", "args": {}}]},
                {"role": "tool", "content": "{...}", "tool_call_id": "c1",
                 "name": "get_current_time"}
            ],
            "stream": true
        }))
        .expect("history must deserialize");
        let assistant = &body.messages[1];
        let tcs = assistant.tool_calls.as_ref().expect("tool_calls kept");
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0].id, "c1");
        let tool = &body.messages[2];
        assert_eq!(tool.tool_call_id.as_deref(), Some("c1"));
        // And the replayed calls reach the provider payload intact.
        let out = openai_messages(&body.messages);
        assert!(out[1].get("tool_calls").is_some());
        assert_eq!(out[2].get("tool_call_id").unwrap(), "c1");
    }

    #[test]
    fn sse_frames_split_on_blank_lines_and_keep_remainder() {
        let mut buf = "data: {\"a\":1}\n\ndata: {\"b\":2".to_string();
        let frames = split_sse_frames(&mut buf);
        assert_eq!(frames, vec!["{\"a\":1}"]);
        assert_eq!(buf, "data: {\"b\":2");
        buf.push_str("}\n\n");
        let frames = split_sse_frames(&mut buf);
        assert_eq!(frames, vec!["{\"b\":2}"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn sse_frames_ignore_comments_and_join_data_lines() {
        let mut buf = ": ping\n\ndata: line1\ndata: line2\n\n".to_string();
        let frames = split_sse_frames(&mut buf);
        assert_eq!(frames, vec!["line1\nline2"]);
    }

    #[test]
    fn delta_assembly_concatenates_text_and_tool_args() {
        let mut content = String::new();
        let mut calls = std::collections::BTreeMap::new();
        let d1 = r#"{"choices":[{"delta":{"content":"Hallo","tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_grades","arguments":"{\"to"}}]}}]}"#;
        let d2 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"p\":5}"}}]}}]}"#;
        assert_eq!(
            apply_openai_delta(d1, &mut content, &mut calls),
            Some("Hallo".to_string())
        );
        assert_eq!(apply_openai_delta(d2, &mut content, &mut calls), None);
        assert_eq!(content, "Hallo");
        assert_eq!(apply_openai_delta("[DONE]", &mut content, &mut calls), None);
        assert_eq!(apply_openai_delta("not json", &mut content, &mut calls), None);
        let assembled = assemble_tool_calls(calls);
        assert_eq!(assembled.len(), 1);
        assert_eq!(assembled[0].id, "call_1");
        assert_eq!(assembled[0].name, "get_grades");
        assert_eq!(assembled[0].arguments, serde_json::json!({"top": 5}));
    }

    #[test]
    fn openai_tool_message_roundtrip() {
        let msgs = vec![
            AiMessageIn {
                role: "user".into(),
                content: "hi".into(),
                tool_call_id: None,
                name: None,
                tool_calls: None,
            },
            AiMessageIn {
                role: "assistant".into(),
                content: "".into(),
                tool_call_id: None,
                name: None,
                tool_calls: Some(vec![ToolCallIn {
                    id: "call_1".into(),
                    name: "get_grades".into(),
                    arguments: serde_json::json!({"top": 5}),
                }]),
            },
            AiMessageIn {
                role: "tool".into(),
                content: "{\"items\":[]}".into(),
                tool_call_id: Some("call_1".into()),
                name: Some("get_grades".into()),
                tool_calls: None,
            },
        ];
        let wire = openai_messages(&msgs);
        assert_eq!(wire[2]["tool_call_id"], "call_1");
        assert_eq!(wire[1]["tool_calls"][0]["function"]["name"], "get_grades");
        // Arguments serialize as a JSON *string* on the OpenAI wire.
        assert_eq!(wire[1]["tool_calls"][0]["function"]["arguments"], "{\"top\":5}");
    }

    #[test]
    fn sanitiser_drops_empty_assistant_without_calls() {
        let msgs = vec![
            AiMessageIn {
                role: "user".into(),
                content: "hi".into(),
                tool_call_id: None,
                name: None,
                tool_calls: None,
            },
            AiMessageIn {
                role: "assistant".into(),
                content: "   ".into(),
                tool_call_id: None,
                name: None,
                tool_calls: None,
            },
            AiMessageIn {
                role: "assistant".into(),
                content: "".into(),
                tool_call_id: None,
                name: None,
                tool_calls: Some(vec![]),
            },
        ];
        let wire = openai_messages(&msgs);
        assert_eq!(wire.len(), 1);
        assert_eq!(wire[0]["role"], "user");
    }

    #[test]
    fn sanitiser_keeps_empty_content_with_tool_calls_but_omits_empty_array() {
        // The existing replay contract: content "" + calls must keep working.
        let msgs = vec![AiMessageIn {
            role: "assistant".into(),
            content: "".into(),
            tool_call_id: None,
            name: None,
            tool_calls: Some(vec![ToolCallIn {
                id: "c1".into(),
                name: "get_grades".into(),
                arguments: serde_json::json!({}),
            }]),
        }];
        let wire = openai_messages(&msgs);
        assert_eq!(wire.len(), 1);
        assert!(wire[0].get("tool_calls").is_some());

        // ...while an assistant whose only calls have empty names loses them
        // (and the empty content with them), and no empty array is sent.
        let msgs = vec![AiMessageIn {
            role: "assistant".into(),
            content: "denk".into(),
            tool_call_id: None,
            name: None,
            tool_calls: Some(vec![ToolCallIn {
                id: "c2".into(),
                name: "".into(),
                arguments: serde_json::json!({}),
            }]),
        }];
        let wire = openai_messages(&msgs);
        assert_eq!(wire.len(), 1);
        assert!(wire[0].get("tool_calls").is_none());
        assert_eq!(wire[0]["content"], "denk");
    }

    #[test]
    fn sanitiser_uniques_ids_and_relinks_tool_messages() {
        let msgs = vec![
            AiMessageIn {
                role: "assistant".into(),
                content: "".into(),
                tool_call_id: None,
                name: None,
                tool_calls: Some(vec![
                    ToolCallIn {
                        id: "c1".into(),
                        name: "get_grades".into(),
                        arguments: serde_json::json!({}),
                    },
                    ToolCallIn {
                        id: "c1".into(),
                        name: "get_calendar_events".into(),
                        arguments: serde_json::json!({}),
                    },
                    ToolCallIn {
                        id: "".into(),
                        name: "get_messages".into(),
                        arguments: serde_json::json!({}),
                    },
                ]),
            },
            AiMessageIn {
                role: "tool".into(),
                content: "{}".into(),
                tool_call_id: Some("c1".into()),
                name: Some("get_grades".into()),
                tool_calls: None,
            },
            AiMessageIn {
                role: "tool".into(),
                content: "{}".into(),
                tool_call_id: Some("".into()),
                name: Some("get_messages".into()),
                tool_calls: None,
            },
            AiMessageIn {
                role: "tool".into(),
                content: "{}".into(),
                tool_call_id: Some("orphan".into()),
                name: Some("nope".into()),
                tool_calls: None,
            },
        ];
        let wire = openai_messages(&msgs);
        // Assistant + first tool + relinked empty-id tool; orphan dropped.
        assert_eq!(wire.len(), 3);
        let ids: Vec<&str> = wire[0]["tool_calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tc| tc["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids[0], "c1");
        assert_ne!(ids[1], "c1");
        assert_ne!(ids[1], ids[2]);
        assert!(ids[1].starts_with("call_"));
        assert!(ids[2].starts_with("call_"));
        // The matching tool_call_ids stayed consistent with the calls.
        assert_eq!(wire[1]["tool_call_id"], ids[0]);
        assert_eq!(wire[2]["tool_call_id"], ids[2]);
    }

    #[test]
    fn history_shape_lists_roles_only() {
        let msgs = vec![
            AiMessageIn {
                role: "system".into(),
                content: "secret prompt".into(),
                tool_call_id: None,
                name: None,
                tool_calls: None,
            },
            AiMessageIn {
                role: "user".into(),
                content: "secret vraag".into(),
                tool_call_id: None,
                name: None,
                tool_calls: None,
            },
            AiMessageIn {
                role: "assistant".into(),
                content: "".into(),
                tool_call_id: None,
                name: None,
                tool_calls: Some(vec![ToolCallIn {
                    id: "c1".into(),
                    name: "t".into(),
                    arguments: serde_json::json!({}),
                }]),
            },
            AiMessageIn {
                role: "tool".into(),
                content: "secret result".into(),
                tool_call_id: Some("c1".into()),
                name: Some("t".into()),
                tool_calls: None,
            },
            AiMessageIn {
                role: "assistant".into(),
                content: "antwoord".into(),
                tool_call_id: None,
                name: None,
                tool_calls: None,
            },
        ];
        let shape = history_shape(&msgs);
        assert_eq!(
            shape,
            vec!["system", "user", "assistant(c0,t1)", "tool", "assistant(c1,t0)"]
        );
        let flat = shape.join(",");
        assert!(!flat.contains("secret"));
    }

    #[test]
    fn provider_error_keeps_type_and_code() {
        let raw = r#"{"object":"error","message":"Assistant message must have either content or tool_calls, but not none.","type":"invalid_request_assistant_message","code":"3240"}"#;
        let msg = provider_error("mistral", 400, raw);
        assert!(msg.contains("invalid_request_assistant_message"));
        assert!(msg.contains("3240"));
        assert!(msg.contains("Assistant message must have either content"));
    }

    #[test]
    fn delta_with_new_id_starts_new_entry() {
        // Hypothesis (b) mechanism: parallel calls sharing one index with
        // distinct ids must not have their arguments concatenated.
        let mut content = String::new();
        let mut calls = std::collections::BTreeMap::new();
        let d1 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"get_grades","arguments":"{\"to"}}]}}]}"#;
        let d2 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","function":{"name":"get_messages","arguments":"{\"fo"}}]}}]}"#;
        let d3 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"p\":5}"}}]}}]}"#;
        let d4 = r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"o\":\"x\"}"}}]}}]}"#;
        assert_eq!(apply_openai_delta(d1, &mut content, &mut calls), None);
        assert_eq!(apply_openai_delta(d2, &mut content, &mut calls), None);
        assert_eq!(apply_openai_delta(d3, &mut content, &mut calls), None);
        assert_eq!(apply_openai_delta(d4, &mut content, &mut calls), None);
        let assembled = assemble_tool_calls(calls);
        assert_eq!(assembled.len(), 2);
        assert_eq!(assembled[0].id, "call_a");
        assert_eq!(assembled[0].name, "get_grades");
        assert_eq!(assembled[0].arguments, serde_json::json!({"top": 5}));
        assert_eq!(assembled[1].id, "call_b");
        assert_eq!(assembled[1].name, "get_messages");
        assert_eq!(assembled[1].arguments, serde_json::json!({"foo": "x"}));
    }

    #[test]
    fn assemble_uniques_ids_and_reports_bad_args() {
        let mut calls = std::collections::BTreeMap::new();
        calls.insert(
            0,
            PendingToolCall {
                id: "".to_string(),
                name: "get_grades".to_string(),
                arguments: "".to_string(),
            },
        );
        calls.insert(
            1,
            PendingToolCall {
                id: "".to_string(),
                name: "get_messages".to_string(),
                arguments: "{oops".to_string(),
            },
        );
        calls.insert(
            2,
            PendingToolCall {
                id: "x".to_string(),
                name: "".to_string(),
                arguments: "{}".to_string(),
            },
        );
        let assembled = assemble_tool_calls(calls);
        // Nameless entry dropped; empty args become {}; junk stays a string.
        assert_eq!(assembled.len(), 2);
        assert_ne!(assembled[0].id, assembled[1].id);
        assert!(assembled[0].id.starts_with("call_"));
        assert_eq!(assembled[0].arguments, serde_json::json!({}));
        assert_eq!(assembled[1].arguments, serde_json::Value::String("{oops".to_string()));
    }

    #[test]
    fn parse_openai_choice_with_tools() {
        let body = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{
                        "id": "call_9",
                        "type": "function",
                        "function": {"name": "get_calendar_events", "arguments": "{\"start\":\"2026-09-14\"}"}
                    }]
                }
            }]
        });
        let (content, tcs) = parse_openai_response(&body).unwrap();
        assert_eq!(content, "");
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0].name, "get_calendar_events");
        assert_eq!(tcs[0].arguments["start"], "2026-09-14");
    }

    #[test]
    fn anthropic_blocks_roundtrip() {
        let msgs = vec![AiMessageIn {
            role: "assistant".into(),
            content: "even kijken".into(),
            tool_call_id: None,
            name: None,
            tool_calls: Some(vec![ToolCallIn {
                id: "toolu_1".into(),
                name: "get_grades".into(),
                arguments: serde_json::json!({}),
            }]),
        }];
        let (system, rest) = anthropic_messages(&msgs);
        assert_eq!(system, "");
        assert_eq!(rest[0]["content"][0]["type"], "text");
        assert_eq!(rest[0]["content"][1]["type"], "tool_use");
        let resp = serde_json::json!({
            "content": [
                {"type": "text", "text": "hier zijn ze"},
                {"type": "tool_use", "id": "toolu_2", "name": "get_absences", "input": {"start": "x"}}
            ]
        });
        let (text, tcs) = parse_anthropic_response(&resp).unwrap();
        assert_eq!(text, "hier zijn ze");
        assert_eq!(tcs[0].id, "toolu_2");
        assert_eq!(tcs[0].arguments["start"], "x");
    }

    #[test]
    fn gemini_parts_roundtrip() {
        let msgs = vec![AiMessageIn {
            role: "tool".into(),
            content: "{\"ok\":true}".into(),
            tool_call_id: Some("gemini-call-1".into()),
            name: Some("get_grades".into()),
            tool_calls: None,
        }];
        let (system, contents) = gemini_contents(&msgs);
        assert!(system.is_empty());
        assert_eq!(contents[0]["parts"][0]["functionResponse"]["name"], "get_grades");
        let resp = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {"text": "antwoord"},
                        {"functionCall": {"name": "get_calendar_events", "args": {"start": "y"}}}
                    ]
                }
            }]
        });
        let (text, tcs) = parse_gemini_response(&resp).unwrap();
        assert_eq!(text, "antwoord");
        assert_eq!(tcs[0].name, "get_calendar_events");
        assert!(tcs[0].id.starts_with("gemini-call-"));
    }

    #[test]
    fn base_url_gate() {
        assert!(check_base_url("openai", "").is_ok());
        assert!(check_base_url("openai", "https://api.groq.com/openai/v1/").is_ok());
        assert!(check_base_url("openai", "http://api.example.com/v1").is_err());
        assert!(check_base_url("openai", "http://localhost:11434/v1").is_ok());
        assert!(check_base_url("openai", "not a url").is_err());
        // Anthropic/Gemini ignore custom base (hardcoded upstream, like desktop).
        assert_eq!(check_base_url("anthropic", "https://evil.example.com"), Ok("https://api.anthropic.com".to_string()));
    }
}
