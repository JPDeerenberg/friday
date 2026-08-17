use async_trait::async_trait;
use serde_json::Value;

use super::super::tools::ToolDef;
use super::*;

/// OpenAI-compatible provider (also works with Groq, DeepSeek, OpenRouter, Ollama).
pub struct OpenAiProvider;

#[async_trait]
impl AiProvider for OpenAiProvider {
    async fn validate_key(&self, config: &AiConfig) -> Result<bool, String> {
        let url = format!("{}/models", config.base_url.trim_end_matches('/'));
        let client = reqwest::Client::new();
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
        let client = reqwest::Client::new();
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
        let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
        let client = reqwest::Client::new();

        let chat_messages: Vec<Value> = messages
            .iter()
            .map(|m| {
                let mut msg = serde_json::json!({
                    "role": m.role,
                    "content": m.content,
                });
                // For tool role messages, include tool_call_id and name
                if m.role == "tool" {
                    if let Some(id) = &m.tool_call_id {
                        msg["tool_call_id"] = serde_json::Value::String(id.clone());
                    }
                    if let Some(name) = &m.name {
                        msg["name"] = serde_json::Value::String(name.clone());
                    }
                }
                // For assistant messages with tool calls, include the tool_calls array
                if m.role == "assistant" {
                    if let Some(tcs) = &m.tool_calls {
                        let tool_calls_value: Vec<Value> = tcs
                            .iter()
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
                            .collect();
                        msg["tool_calls"] = serde_json::Value::Array(tool_calls_value);
                    }
                }
                msg
            })
            .collect();

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
                let arguments: Value =
                    serde_json::from_str(args_str).unwrap_or(serde_json::Value::Null);

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
}