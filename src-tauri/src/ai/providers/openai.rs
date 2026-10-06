use async_trait::async_trait;
use serde_json::Value;

use super::super::tools::ToolDef;
use super::*;

/// OpenAI-compatible provider (also works with Groq, DeepSeek, OpenRouter, Ollama).
pub struct OpenAiProvider;

/// Build the `/chat/completions` URL + JSON body (shared by chat/stream).
fn build_request_body(
    config: &AiConfig,
    messages: &[AiMessage],
    tools: &[ToolDef],
    stream: bool,
) -> (String, Value) {
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    // Sanitiser (mirrors `crates/web-api/src/ai.rs::openai_messages`): drop
    // assistant messages with empty content and no surviving tool calls
    // (Mistral 400 `invalid_request_assistant_message`), omit `tool_calls`
    // when empty, drop nameless calls, make ids unique (`call_<n>`) while
    // keeping the matching `tool_call_id` consistent, and drop tool messages
    // with no preceding assistant call of that id.
    let mut chat_messages: Vec<Value> = Vec::new();
    let mut preceding_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut empty_renames: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut counter: u32 = 0;
    for m in messages {
        if m.role == "assistant" {
            let mut cleaned: Vec<Value> = Vec::new();
            if let Some(tcs) = &m.tool_calls {
                for tc in tcs {
                    if tc.name.is_empty() {
                        continue;
                    }
                    let id = if tc.id.is_empty() || preceding_ids.contains(&tc.id) {
                        let fresh = loop {
                            counter += 1;
                            let candidate = format!("call_{counter}");
                            if !preceding_ids.contains(&candidate) {
                                break candidate;
                            }
                        };
                        if tc.id.is_empty() {
                            empty_renames.push_back(fresh.clone());
                        }
                        fresh
                    } else {
                        tc.id.clone()
                    };
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
            if m.content.trim().is_empty() && cleaned.is_empty() {
                continue;
            }
            let mut msg = serde_json::json!({
                "role": m.role,
                "content": m.content,
            });
            if !cleaned.is_empty() {
                msg["tool_calls"] = serde_json::Value::Array(cleaned);
            }
            chat_messages.push(msg);
        } else if m.role == "tool" {
            let mut tid = m.tool_call_id.clone().unwrap_or_default();
            if tid.is_empty() {
                match empty_renames.pop_front() {
                    Some(relinked) => tid = relinked,
                    None => continue,
                }
            }
            if !preceding_ids.contains(&tid) {
                continue;
            }
            let mut msg = serde_json::json!({
                "role": m.role,
                "content": m.content,
            });
            msg["tool_call_id"] = serde_json::Value::String(tid);
            if let Some(name) = &m.name {
                msg["name"] = serde_json::Value::String(name.clone());
            }
            chat_messages.push(msg);
        } else {
            chat_messages.push(serde_json::json!({
                "role": m.role,
                "content": m.content,
            }));
        }
    }

    let mut request_body = serde_json::json!({
        "model": config.model,
        "messages": chat_messages,
        "temperature": 0.7,
        "max_tokens": 4096,
    });

    // Add tools if available
    if !tools.is_empty() {
        let tool_defs: Vec<Value> = tools.iter().map(|t| t.to_openai_tool()).collect();
        request_body["tools"] = serde_json::Value::Array(tool_defs);
        request_body["tool_choice"] = serde_json::Value::String("auto".to_string());
    }
    if stream {
        request_body["stream"] = serde_json::Value::Bool(true);
    }
    (url, request_body)
}

/// One tool call being assembled from stream deltas, keyed by `index`.
/// Mirrors the web-api proxy assembler (`crates/web-api/src/ai.rs`).
#[derive(Default)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Feed one provider SSE `data:` payload into the assembly. Returns the text
/// delta to forward (if any). Mirrors the proxy twin exactly.
fn apply_stream_delta(
    payload: &str,
    content: &mut String,
    calls: &mut std::collections::BTreeMap<u32, PendingToolCall>,
) -> Option<String> {
    if payload.trim() == "[DONE]" {
        return None;
    }
    let v: Value = serde_json::from_str(payload).ok()?;
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
            let incoming_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            // Mirrors the web-api proxy: a delta for an already-named index
            // carrying a *different* non-empty id starts a new call instead
            // of concatenating two argument streams into invalid JSON.
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

#[async_trait]
impl AiProvider for OpenAiProvider {
    async fn validate_key(&self, config: &AiConfig) -> Result<bool, String> {
        let url = format!("{}/models", config.base_url.trim_end_matches('/'));
        let client = crate::tls::new_client();
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .send()
            .await
            .map_err(|e| format!("Verbinding mislukt: {}", e))?;
        Ok(resp.status().is_success())
    }

    async fn list_models(&self, config: &AiConfig) -> Result<Vec<String>, String> {
        let url = format!("{}/models", config.base_url.trim_end_matches('/'));
        let client = crate::tls::new_client();
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .send()
            .await
            .map_err(|e| format!("Verbinding mislukt: {}", e))?;

        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("Kon antwoord niet lezen: {}", e))?;

        let models = body
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|id| id.as_str().map(|s| s.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        Ok(models)
    }

    async fn chat(
        &self,
        config: &AiConfig,
        messages: &[AiMessage],
        tools: &[ToolDef],
    ) -> Result<AiChatResult, String> {
        let (url, request_body) = build_request_body(config, messages, tools, false);
        let client = crate::tls::new_client();

        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("AI-verbinding mislukt: {}", e))?;

        let status = response.status();
        let raw_body = response
            .text()
            .await
            .map_err(|e| format!("Kon antwoord niet lezen: {}", e))?;

        if !status.is_success() {
            let error_msg = extract_error_message(&raw_body, 500);
            log::error!("OpenAI API error ({}): {}", status.as_u16(), error_msg);
            return Err(format!("AI-fout ({}): {}", status.as_u16(), error_msg));
        }

        let body: Value = serde_json::from_str(&raw_body)
            .map_err(|e| format!("Kon antwoord niet lezen: {}", e))?;

        // Parse response
        let choice = body
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .ok_or_else(|| "Geen antwoord van AI".to_string())?;

        let content = choice
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();

        // Parse tool calls
        let mut tool_calls = Vec::new();
        if let Some(tcs) = choice
            .get("message")
            .and_then(|m| m.get("tool_calls"))
            .and_then(|t| t.as_array())
        {
            for tc in tcs {
                let id = tc
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("call_unknown")
                    .to_string();
                let name = tc
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args_str = tc
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}");
                let arguments: Value = serde_json::from_str(args_str)
                    .unwrap_or_else(|_| serde_json::Value::String(args_str.to_string()));

                tool_calls.push(ToolCall {
                    id,
                    name,
                    arguments,
                    status: ToolCallStatus::Pending,
                });
            }
        }

        Ok(AiChatResult {
            content,
            tool_calls,
        })
    }

    async fn chat_stream(
        &self,
        config: &AiConfig,
        messages: &[AiMessage],
        tools: &[ToolDef],
        should_stop: &(dyn Fn() -> bool + Send + Sync),
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<AiChatResult, String> {
        use futures::StreamExt;
        let (url, request_body) = build_request_body(config, messages, tools, true);
        let client = crate::tls::new_client();

        let mut response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("AI-verbinding mislukt: {}", e))?;

        let status = response.status();
        if !status.is_success() {
            let raw_body = response.text().await.unwrap_or_default();
            let error_msg = extract_error_message(&raw_body, 500);
            log::error!("OpenAI API error ({}): {}", status.as_u16(), error_msg);
            return Err(format!("AI-fout ({}): {}", status.as_u16(), error_msg));
        }

        let mut buf = String::new();
        let mut content = String::new();
        let mut calls: std::collections::BTreeMap<u32, PendingToolCall> =
            std::collections::BTreeMap::new();
        let mut stream = response.bytes_stream();
        let mut stopped = false;
        while let Some(chunk) = stream.next().await {
            if should_stop() {
                stopped = true;
                break;
            }
            let bytes = chunk.map_err(|e| format!("AI-verbinding verbroken: {}", e))?;
            buf.push_str(&String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));
            while let Some(pos) = buf.find("\n\n") {
                let frame: String = buf.drain(..pos + 2).collect();
                let mut data_parts: Vec<&str> = Vec::new();
                for line in frame.lines() {
                    if let Some(payload) = line.strip_prefix("data:") {
                        data_parts.push(payload.trim_start());
                    }
                }
                if data_parts.is_empty() {
                    continue;
                }
                let payload = data_parts.join("\n");
                if let Some(delta) = apply_stream_delta(&payload, &mut content, &mut calls) {
                    on_event(StreamEvent::TextDelta(delta));
                }
            }
        }

        // A stopped turn returns partial text with no tool calls: the loop
        // ends the turn instead of executing half-received calls.
        if stopped {
            return Ok(AiChatResult {
                content,
                tool_calls: Vec::new(),
            });
        }
        let mut tool_calls = Vec::new();
        let mut used_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut id_counter: u32 = 0;
        for (_, c) in calls {
            // Mirrors the web-api `assemble_tool_calls`: nameless fragments
            // are dropped, ids stay unique, and unparseable arguments stay a
            // string so the loop reports bad arguments.
            if c.name.is_empty() {
                continue;
            }
            let id = if c.id.is_empty() || used_ids.contains(&c.id) {
                id_counter += 1;
                while used_ids.contains(&format!("call_{id_counter}")) {
                    id_counter += 1;
                }
                format!("call_{id_counter}")
            } else {
                c.id
            };
            used_ids.insert(id.clone());
            let arguments = if c.arguments.trim().is_empty() {
                serde_json::Value::Object(serde_json::Map::new())
            } else {
                serde_json::from_str(&c.arguments)
                    .unwrap_or_else(|_| serde_json::Value::String(c.arguments.clone()))
            };
            tool_calls.push(ToolCall {
                id,
                name: c.name,
                arguments,
                status: ToolCallStatus::Pending,
            });
        }

        Ok(AiChatResult {
            content,
            tool_calls,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> AiConfig {
        AiConfig {
            api_key: "k".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            enabled: true,
            provider: AiProviderType::OpenAI,
            use_data_access: true,
            has_api_key: true,
            ai_notes_ai_can_edit: true,
            ai_notes_use_in_chats: true,
        }
    }

    #[test]
    fn request_body_marks_streaming() {
        let (_, plain) = build_request_body(&test_config(), &[], &[], false);
        assert!(plain.get("stream").is_none());
        let (url, streamed) = build_request_body(&test_config(), &[], &[], true);
        assert!(url.ends_with("/chat/completions"));
        assert_eq!(streamed["stream"], true);
        assert_eq!(streamed["model"], "gpt-4o-mini");
    }

    #[test]
    fn request_body_sanitises_empty_assistant_and_orphan_tools() {
        use super::super::ToolCallStatus;
        let cfg = test_config();
        let msgs = vec![
            AiMessage::simple("user", "hi"),
            AiMessage {
                role: "assistant".to_string(),
                content: "  ".to_string(),
                tool_call_id: None,
                name: None,
                tool_calls: None,
            },
            AiMessage {
                role: "assistant".to_string(),
                content: "".to_string(),
                tool_call_id: None,
                name: None,
                tool_calls: Some(vec![
                    ToolCall {
                        id: "c1".to_string(),
                        name: "get_grades".to_string(),
                        arguments: serde_json::json!({}),
                        status: ToolCallStatus::Pending,
                    },
                    ToolCall {
                        id: "c1".to_string(),
                        name: "get_messages".to_string(),
                        arguments: serde_json::json!({}),
                        status: ToolCallStatus::Pending,
                    },
                    ToolCall {
                        id: "".to_string(),
                        name: "".to_string(),
                        arguments: serde_json::json!({}),
                        status: ToolCallStatus::Pending,
                    },
                ]),
            },
            AiMessage {
                role: "tool".to_string(),
                content: "{}".to_string(),
                tool_call_id: Some("c1".to_string()),
                name: Some("get_grades".to_string()),
                tool_calls: None,
            },
            AiMessage {
                role: "tool".to_string(),
                content: "{}".to_string(),
                tool_call_id: Some("orphan".to_string()),
                name: Some("nope".to_string()),
                tool_calls: None,
            },
        ];
        let (_, body) = build_request_body(&cfg, &msgs, &[], false);
        let wire = body["messages"].as_array().unwrap();
        // user + assistant-with-calls + its tool result; the whitespace-only
        // assistant and the orphan tool message are gone.
        assert_eq!(wire.len(), 3);
        assert_eq!(wire[0]["role"], "user");
        let tcs = wire[1]["tool_calls"].as_array().unwrap();
        // Nameless call dropped, duplicate id made unique.
        assert_eq!(tcs.len(), 2);
        assert_eq!(tcs[0]["id"], "c1");
        assert_ne!(tcs[1]["id"], "c1");
        assert!(tcs[1]["id"].as_str().unwrap().starts_with("call_"));
        assert_eq!(wire[2]["tool_call_id"], "c1");
    }

    #[test]
    fn request_body_omits_empty_tool_calls_array() {
        let cfg = test_config();
        let msgs = vec![AiMessage {
            role: "assistant".to_string(),
            content: "denk".to_string(),
            tool_call_id: None,
            name: None,
            tool_calls: Some(vec![]),
        }];
        let (_, body) = build_request_body(&cfg, &msgs, &[], false);
        let wire = body["messages"].as_array().unwrap();
        assert_eq!(wire.len(), 1);
        assert!(wire[0].get("tool_calls").is_none());
    }

    #[test]
    fn delta_with_new_id_starts_new_entry() {
        let mut content = String::new();
        let mut calls = std::collections::BTreeMap::new();
        let d1 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"get_grades","arguments":"{\"to"}}]}}]}"#;
        let d2 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","function":{"name":"get_messages","arguments":"{\"fo"}}]}}]}"#;
        let d3 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"p\":5}"}}]}}]}"#;
        let d4 = r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"o\":\"x\"}"}}]}}]}"#;
        assert_eq!(apply_stream_delta(d1, &mut content, &mut calls), None);
        assert_eq!(apply_stream_delta(d2, &mut content, &mut calls), None);
        assert_eq!(apply_stream_delta(d3, &mut content, &mut calls), None);
        assert_eq!(apply_stream_delta(d4, &mut content, &mut calls), None);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls.get(&0).unwrap().arguments, "{\"top\":5}");
        assert_eq!(calls.get(&1).unwrap().arguments, "{\"foo\":\"x\"}");
        assert_eq!(calls.get(&1).unwrap().id, "call_b");
    }

    #[test]
    fn delta_assembly_concatenates_text_and_tool_args() {
        let mut content = String::new();
        let mut calls = std::collections::BTreeMap::new();
        let d1 = r#"{"choices":[{"delta":{"content":"Hallo","tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_grades","arguments":"{\"to"}}]}}]}"#;
        let d2 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"p\":5}"}}]}}]}"#;
        assert_eq!(
            apply_stream_delta(d1, &mut content, &mut calls),
            Some("Hallo".to_string())
        );
        assert_eq!(apply_stream_delta(d2, &mut content, &mut calls), None);
        assert_eq!(content, "Hallo");
        assert_eq!(apply_stream_delta("[DONE]", &mut content, &mut calls), None);
        assert_eq!(apply_stream_delta("not json", &mut content, &mut calls), None);
        let entry = calls.get(&0).unwrap();
        assert_eq!(entry.id, "call_1");
        assert_eq!(entry.name, "get_grades");
        assert_eq!(entry.arguments, "{\"top\":5}");
    }
}
