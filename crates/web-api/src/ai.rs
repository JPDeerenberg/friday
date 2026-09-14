//! BYO-key AI proxy: forwards chat/validate calls to the user's own provider
//! account. The API key lives in the browser (IndexedDB) and travels here
//! per-request, in memory only — never logged, never stored, never cached.
//!
//! Wire formats mirror `src-tauri/src/ai/providers/` exactly (OpenAI-family,
//! Anthropic, Gemini) so the browser-side tool loop speaks the same protocol
//! as the desktop loop.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessageIn {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<ToolCallIn>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallIn {
    pub id: String,
    pub name: String,
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
    format!("{label}-fout (HTTP {status}): {}", extract_error_message(raw))
}

// ─── OpenAI-family (openai, deepseek, mistral, openai_compatible) ───────────

fn openai_messages(messages: &[AiMessageIn]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .map(|m| {
            let mut msg = serde_json::json!({ "role": m.role, "content": m.content });
            if m.role == "tool" {
                if let Some(id) = &m.tool_call_id {
                    msg["tool_call_id"] = serde_json::Value::String(id.clone());
                }
                if let Some(name) = &m.name {
                    msg["name"] = serde_json::Value::String(name.clone());
                }
            }
            if m.role == "assistant" {
                if let Some(tcs) = &m.tool_calls {
                    msg["tool_calls"] = serde_json::Value::Array(
                        tcs.iter()
                            .map(|tc| {
                                serde_json::json!({
                                    "id": tc.id,
                                    "type": "function",
                                    "function": {
                                        "name": tc.name,
                                        "arguments": serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                    }
                                })
                            })
                            .collect(),
                    );
                }
            }
            msg
        })
        .collect()
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
                arguments: serde_json::from_str(args_str).unwrap_or(serde_json::Value::Null),
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
        eprintln!("ai proxy: {} -> HTTP {}", req.provider, status);
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

#[cfg(test)]
mod tests {
    use super::*;

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
