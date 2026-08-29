use async_trait::async_trait;
use serde_json::Value;

use super::super::tools::ToolDef;
use super::*;

/// Anthropic Claude provider.
pub struct AnthropicProvider;

#[async_trait]
impl AiProvider for AnthropicProvider {
    async fn validate_key(&self, config: &AiConfig) -> Result<bool, String> {
        let url = "https://api.anthropic.com/v1/messages";
        let client = crate::tls::new_client();
        let resp = client
            .post(url)
            .header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "model": config.model,
                "max_tokens": 10,
                "messages": [{"role": "user", "content": "ping"}]
            }))
            .send()
            .await
            .map_err(|e| format!("Verbinding mislukt: {}", e))?;
        // Anthropic returns 200 for valid keys, 401 for invalid
        Ok(resp.status().is_success() || resp.status().as_u16() == 400)
    }

    async fn chat(
        &self,
        config: &AiConfig,
        messages: &[AiMessage],
        tools: &[ToolDef],
    ) -> Result<AiChatResult, String> {
        let url = "https://api.anthropic.com/v1/messages";
        let client = crate::tls::new_client();

        // Anthropic requires alternating user/assistant messages, starting with user
        // We handle system messages separately
        let system_messages: Vec<String> = messages
            .iter()
            .filter(|m| m.role == "system")
            .map(|m| m.content.clone())
            .collect();

        let non_system_messages: Vec<Value> = messages
            .iter()
            .filter(|m| m.role != "system")
            .map(|m| {
                if m.role == "tool" {
                    // Anthropic requires tool_result content blocks
                    serde_json::json!({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": m.tool_call_id.as_deref().unwrap_or("toolu_unknown"),
                            "content": m.content
                        }]
                    })
                } else if m.role == "assistant" && m.tool_calls.is_some() {
                    // Assistant message with tool_use content blocks
                    let mut content_blocks: Vec<Value> = if m.content.is_empty() {
                        vec![]
                    } else {
                        vec![serde_json::json!({"type": "text", "text": m.content})]
                    };
                    if let Some(tcs) = &m.tool_calls {
                        for tc in tcs {
                            content_blocks.push(serde_json::json!({
                                "type": "tool_use",
                                "id": tc.id,
                                "name": tc.name,
                                "input": tc.arguments
                            }));
                        }
                    }
                    serde_json::json!({
                        "role": "assistant",
                        "content": content_blocks
                    })
                } else {
                    serde_json::json!({
                        "role": m.role,
                        "content": m.content,
                    })
                }
            })
            .collect();

        let mut request_body = serde_json::json!({
            "model": config.model,
            "max_tokens": 4096,
            "messages": non_system_messages,
        });

        // Add system prompt if present
        if let Some(system) = system_messages.join("\n\n").into() {
            if !system.is_empty() {
                request_body["system"] = serde_json::Value::String(system);
            }
        }

        // Add tools if available
        if !tools.is_empty() {
            let tool_defs: Vec<Value> = tools.iter().map(|t| t.to_anthropic_tool()).collect();
            request_body["tools"] = serde_json::Value::Array(tool_defs);
        }

        let response = client
            .post(url)
            .header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01")
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
            log::error!("Anthropic API error ({}): {}", status.as_u16(), error_msg);
            return Err(format!("Anthropic-fout ({}): {}", status.as_u16(), error_msg));
        }

        let body: Value = serde_json::from_str(&raw_body)
            .map_err(|e| format!("Kon antwoord niet lezen: {}", e))?;

        // Parse tool calls and text from Anthropic response
        // Anthropic returns content as an array of blocks
        let mut tool_calls = Vec::new();
        let mut text_parts: Vec<String> = Vec::new();
        if let Some(blocks) = body.get("content").and_then(|c| c.as_array()) {
            for block in blocks {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            text_parts.push(text.to_string());
                        }
                    }
                    Some("tool_use") => {
                        let id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("toolu_unknown")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let arguments = block
                            .get("input")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);

                        tool_calls.push(ToolCall {
                            id,
                            name,
                            arguments,
                            status: ToolCallStatus::Pending,
                        });
                    }
                    _ => {}
                }
            }
        }

        // Combine all text parts
        let content = text_parts.join("\n");

        Ok(AiChatResult {
            content,
            tool_calls,
        })
    }
}