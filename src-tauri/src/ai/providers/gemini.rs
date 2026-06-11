use async_trait::async_trait;
use serde_json::Value;

use super::super::tools::ToolDef;
use super::*;

/// Google Gemini provider.
pub struct GeminiProvider;

#[async_trait]
impl AiProvider for GeminiProvider {
    async fn validate_key(&self, config: &AiConfig) -> Result<bool, String> {
        // Gemini uses API key in query param
        let url = format!(
            "https://generativelanguage.googleapis.com/v1/models?key={}",
            config.api_key
        );
        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Verbinding mislukt: {}", e))?;
        Ok(resp.status().is_success())
    }

    async fn chat(
        &self,
        config: &AiConfig,
        messages: &[AiMessage],
        tools: &[ToolDef],
    ) -> Result<AiChatResult, String> {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1/models/{}:generateContent?key={}",
            config.model, config.api_key
        );
        let client = reqwest::Client::new();

        // Gemini uses a different structure: contents[] with parts[]
        // System instructions are separate
        let system_prompts: Vec<String> = messages
            .iter()
            .filter(|m| m.role == "system")
            .map(|m| m.content.clone())
            .collect();

        let contents: Vec<Value> = messages
            .iter()
            .filter(|m| m.role != "system")
            .map(|m| {
                let gemini_role = match m.role.as_str() {
                    "assistant" => "model",
                    "tool" => "function", // Gemini uses "function" role for tool results
                    _ => "user",
                };

                if m.role == "tool" {
                    // Tool result messages: send as function response
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
                    // Assistant message with function calls
                    let mut parts: Vec<Value> = if m.content.is_empty() {
                        vec![]
                    } else {
                        vec![serde_json::json!({"text": m.content})]
                    };
                    if let Some(tcs) = &m.tool_calls {
                        for tc in tcs {
                            parts.push(serde_json::json!({
                                "functionCall": {
                                    "name": tc.name,
                                    "args": tc.arguments
                                }
                            }));
                        }
                    }
                    serde_json::json!({
                        "role": gemini_role,
                        "parts": parts
                    })
                } else {
                    serde_json::json!({
                        "role": gemini_role,
                        "parts": [{"text": m.content}]
                    })
                }
            })
            .collect();

        let mut request_body = serde_json::json!({
            "contents": contents,
            "generationConfig": {
                "temperature": 0.7,
                "maxOutputTokens": 4096,
            }
        });

        // Add system instruction
        if !system_prompts.is_empty() {
            request_body["systemInstruction"] = serde_json::json!({
                "parts": [{"text": system_prompts.join("\n\n")}]
            });
        }

        // Gemini uses "functionDeclarations" for tool calling
        if !tools.is_empty() {
            let tool_configs: Vec<Value> = tools
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    })
                })
                .collect();

            request_body["tools"] = serde_json::json!([{
                "functionDeclarations": tool_configs
            }]);
        }

        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("AI-verbinding mislukt: {}", e))?;

        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|e| format!("Kon antwoord niet lezen: {}", e))?;

        if !status.is_success() {
            let error_msg = body
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Onbekende fout");
            return Err(format!("Gemini-fout ({}): {}", status.as_u16(), error_msg));
        }

        // Parse text response
        let content = body
            .get("candidates")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|c| c.get("content"))
            .and_then(|ct| ct.get("parts"))
            .and_then(|p| p.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|part| {
                        if part.get("functionCall").is_none() {
                            part.get("text").and_then(|t| t.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<&str>>()
                    .join("\n")
            })
            .unwrap_or_default();

        // Parse function calls (Gemini's tool call format)
        let mut tool_calls = Vec::new();
        if let Some(parts) = body
            .get("candidates")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|c| c.get("content"))
            .and_then(|ct| ct.get("parts"))
            .and_then(|p| p.as_array())
        {
            for (i, part) in parts.iter().enumerate() {
                if let Some(fc) = part.get("functionCall") {
                    let name = fc
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let arguments = fc
                        .get("args")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);

                    tool_calls.push(ToolCall {
                        id: format!("fc_{}", i),
                        name,
                        arguments,
                        status: ToolCallStatus::Pending,
                    });
                }
            }
        }

        Ok(AiChatResult {
            content,
            tool_calls,
        })
    }
}