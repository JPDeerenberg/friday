pub mod anthropic;
pub mod gemini;
pub mod openai;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::tools::{ToolDef, ToolResult};

/// Truncate a string to at most `max_chars` characters, appending an ellipsis.
pub(crate) fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max_chars).collect();
        format!("{}… (afgekapt)", cut)
    }
}

/// Extract a provider error message from an error response body. Tries the
/// common `{"error": {"message": "..."}}` shape first; falls back to the raw
/// body (truncated) so an unexpected error shape still surfaces something
/// actionable instead of a generic "Onbekende fout".
pub(crate) fn extract_error_message(raw_body: &str, max_chars: usize) -> String {
    serde_json::from_str::<Value>(raw_body)
        .ok()
        .and_then(|b| {
            b.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| format!("Onverwacht foutformaat: {}", truncate(raw_body, max_chars)))
}

/// Supported AI provider types.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AiProviderType {
    #[serde(rename = "openai")]
    OpenAI,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "deepseek")]
    DeepSeek,
    #[serde(rename = "mistral")]
    Mistral,
    #[serde(rename = "openai_compatible")]
    OpenAICompatible,
}

impl std::fmt::Display for AiProviderType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiProviderType::OpenAI => write!(f, "OpenAI"),
            AiProviderType::Anthropic => write!(f, "Anthropic"),
            AiProviderType::Gemini => write!(f, "Gemini"),
            AiProviderType::DeepSeek => write!(f, "DeepSeek"),
            AiProviderType::Mistral => write!(f, "Mistral"),
            AiProviderType::OpenAICompatible => write!(f, "OpenAI-compatibel"),
        }
    }
}

/// Extended AI configuration with provider support.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub enabled: bool,
    pub provider: AiProviderType,
    pub use_data_access: bool,
    /// Set by `get_ai_config` to let the frontend know a key is stored without
    /// round-tripping the raw secret. `api_key` itself is returned empty.
    #[serde(default)]
    pub has_api_key: bool,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4o-mini".to_string(),
            enabled: false,
            provider: AiProviderType::OpenAI,
            use_data_access: true,
            has_api_key: false,
        }
    }
}

/// Standard chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiMessage {
    pub role: String, // "system", "user", "assistant", "tool"
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Tool calls attached to an assistant message (for multi-turn tool calling).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

impl AiMessage {
    /// Create a simple message without tool metadata.
    pub fn simple(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
            tool_call_id: None,
            name: None,
            tool_calls: None,
        }
    }
}

/// A tool call request from the AI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub status: ToolCallStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ToolCallStatus {
    Pending,
    Completed(ToolResult),
    Failed(String),
}

/// The result of an AI chat call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatResult {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

/// Trait that all AI providers must implement.
#[async_trait::async_trait]
pub trait AiProvider: Send + Sync {
    /// Send a chat request and get a response (with optional tool calling).
    async fn chat(
        &self,
        config: &AiConfig,
        messages: &[AiMessage],
        tools: &[ToolDef],
    ) -> Result<AiChatResult, String>;

    /// Validate the API key.
    async fn validate_key(&self, config: &AiConfig) -> Result<bool, String>;

    /// Get the list of models available.
    async fn list_models(&self, config: &AiConfig) -> Result<Vec<String>, String> {
        let _ = config;
        Ok(vec![]) // Default: empty, override if provider supports listing
    }
}

/// Get the appropriate provider implementation.
pub fn get_provider(provider_type: &AiProviderType) -> Box<dyn AiProvider> {
    match provider_type {
        AiProviderType::OpenAI
        | AiProviderType::OpenAICompatible
        | AiProviderType::DeepSeek
        | AiProviderType::Mistral => Box::new(openai::OpenAiProvider),
        AiProviderType::Anthropic => Box::new(anthropic::AnthropicProvider),
        AiProviderType::Gemini => Box::new(gemini::GeminiProvider),
    }
}