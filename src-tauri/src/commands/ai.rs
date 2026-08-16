use crate::ai::providers::{self, AiConfig, AiMessage, AiProviderType};
use crate::ai::tools::{self, execute_pending_action, execute_tool, PendingAction, PendingActionStore};
use crate::client::SharedClient;
use crate::secure_store;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// Shared state for AI configuration, stored in memory + synced to disk.
///
/// The API key is the only secret and lives in the OS keyring
/// ([`crate::secure_store`]); everything else (base_url, model, provider,
/// enabled flags) is persisted to `ai_config.json` in plaintext.
pub struct AiState {
    pub config: Mutex<AiConfig>,
    /// Side-effecting AI actions awaiting explicit user confirmation.
    pub pending_actions: PendingActionStore,
    config_path: PathBuf,
}

impl AiState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let config_path = app_data_dir.join("ai_config.json");
        let mut config = if config_path.exists() {
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            AiConfig::default()
        };

        // Load the API key from secure storage (never persisted to disk).
        config.api_key = secure_store::get_secret(secure_store::USER_AI_API_KEY)
            .ok()
            .flatten()
            .unwrap_or_default();

        Self {
            config: Mutex::new(config),
            pending_actions: Mutex::new(HashMap::new()),
            config_path,
        }
    }

    fn save(&self) {
        if let Ok(config) = self.config.lock() {
            // Persist the key to the keyring, and the rest to ai_config.json
            // (with the key cleared so it never lands in plaintext).
            if !config.api_key.is_empty() {
                let _ = secure_store::set_secret(secure_store::USER_AI_API_KEY, &config.api_key);
            }
            let mut disk = config.clone();
            disk.api_key.clear();
            if let Ok(json) = serde_json::to_string(&disk) {
                let _ = std::fs::write(&self.config_path, json);
            }
        }
    }
}

/// Get the current AI configuration (without exposing the API key).
#[tauri::command]
pub fn get_ai_config(state: State<'_, AiState>) -> Result<AiConfig, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    let mut out = config.clone();
    out.has_api_key = !out.api_key.is_empty();
    out.api_key.clear();
    Ok(out)
}

/// Set the AI configuration (API key, base URL, model, enabled, provider).
///
/// An empty `api_key` keeps the currently stored key (used by the frontend to
/// round-trip the config without ever receiving the raw secret back).
#[tauri::command]
pub fn set_ai_config(
    state: State<'_, AiState>,
    api_key: String,
    base_url: String,
    model: String,
    enabled: bool,
    provider: String,
    use_data_access: bool,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    if !api_key.is_empty() {
        config.api_key = api_key;
    }
    config.base_url = base_url;
    config.model = model;
    config.enabled = enabled;
    config.use_data_access = use_data_access;

    // Parse provider string
    config.provider = match provider.as_str() {
        "anthropic" => AiProviderType::Anthropic,
        "gemini" => AiProviderType::Gemini,
        "deepseek" => AiProviderType::DeepSeek,
        "mistral" => AiProviderType::Mistral,
        "openai_compatible" => AiProviderType::OpenAICompatible,
        _ => AiProviderType::OpenAI,
    };

    drop(config);
    state.save();
    Ok(())
}

/// Validate the configured API key by testing the connection.
#[tauri::command]
pub async fn validate_ai_key(state: State<'_, AiState>) -> Result<bool, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    if !config.enabled || config.api_key.is_empty() {
        return Ok(false);
    }
    crate::ai_client::validate_api_key(&config).await
}

/// Send a chat message to the AI and get a response.
/// Messages is a JSON-encoded array of `AiMessage` objects.
/// This version does NOT have access to Magister tools.
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AiState>,
    messages_json: String,
    page_context: Option<String>,
) -> Result<String, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();

    let mut messages: Vec<AiMessage> =
        serde_json::from_str(&messages_json).map_err(|e| format!("Ongeldig berichtformaat: {}", e))?;

    // Prepend system prompt with page context (no tools — this is the non-data-access version)
    let system_prompt = crate::ai_client::build_school_context_system_prompt(page_context.as_deref(), false);
    messages.insert(
        0,
        AiMessage::simple("system", system_prompt),
    );

    crate::ai_client::send_chat(&config, &messages).await
}

/// Result of a tools-enabled AI chat: the assistant's reply text plus any
/// side-effecting actions that were staged for user confirmation during the run.
#[derive(Debug, Clone, Serialize)]
pub struct AiChatWithToolsResult {
    pub content: String,
    /// Each entry is a "pending_user_confirmation" payload (action_id,
    /// action_type, recipient/subject/body or message_ids, ...) that the
    /// frontend renders as a confirm/cancel card.
    pub pending_actions: Vec<Value>,
}

/// Send a chat message with full Magister data access via tool calling.
/// This version has access to execute tools that fetch real school data.
#[tauri::command]
pub async fn ai_chat_with_tools(
    state: State<'_, AiState>,
    client: State<'_, SharedClient>,
    messages_json: String,
    page_context: Option<String>,
    person_id: i64,
) -> Result<AiChatWithToolsResult, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();

    let mut messages: Vec<providers::AiMessage> =
        serde_json::from_str(&messages_json).map_err(|e| format!("Ongeldig berichtformaat: {}", e))?;

    // Prepend system prompt with page context and tools enabled
    let system_prompt = crate::ai_client::build_school_context_system_prompt(page_context.as_deref(), true);
    messages.insert(
        0,
        providers::AiMessage::simple("system", system_prompt),
    );

    // Call AI with tools (up to 5 rounds of tool execution)
    let provider = providers::get_provider(&config.provider);
    let tools = tools::get_all_tool_defs();

    let mut current_messages = messages.clone();
    let mut final_content = String::new();
    let mut staged_pending_actions: Vec<Value> = Vec::new();
    let max_rounds = 5;

    for round in 0..max_rounds {
        let result = provider.chat(&config, &current_messages, &tools).await?;

        // Store the text content (AI might respond with only tool calls and no text — that's fine)
        if !result.content.is_empty() {
            final_content = result.content.clone();
        }

        // If no tool calls, we're done
        if result.tool_calls.is_empty() {
            break;
        }

        // Add assistant message with the tool calls to history.
        // Keep the original content (even empty) — some models like DeepSeek/Claude
        // return empty content when they only call tools (thinking mode).
        // Do NOT fabricate text content, as that would confuse the model in the next round.
        // IMPORTANT: Include the tool_calls so the API knows these tool results are a response to this message.
        current_messages.push(providers::AiMessage {
            role: "assistant".to_string(),
            content: result.content.clone(),
            tool_call_id: None,
            name: None,
            tool_calls: Some(result.tool_calls.clone()),
        });

        // Execute each tool call
        let tool_results: Vec<(String, String, tools::ToolResult)> = {
            let mut c = client.lock().await;
            let mut results = Vec::new();
            for tool_call in &result.tool_calls {
                let tool_result =
                    execute_tool(&mut c, &tool_call.name, &tool_call.arguments, person_id, &state.pending_actions).await;
                results.push((tool_call.id.clone(), tool_call.name.clone(), tool_result));
            }
            results
        }; // Lock is released here

        // Add each tool result back as a proper "tool" role message
        for (tool_call_id, tool_name, tool_result) in &tool_results {
            let result_content = if tool_result.success {
                serde_json::to_string(&tool_result.data).unwrap_or_else(|_| "{}".to_string())
            } else {
                format!("Fout bij ophalen van data: {}", tool_result.error.as_deref().unwrap_or("Onbekende fout"))
            };

            current_messages.push(providers::AiMessage {
                role: "tool".to_string(),
                content: result_content,
                tool_call_id: Some(tool_call_id.to_string()),
                name: Some(tool_name.to_string()),
                tool_calls: None,
            });
        }

        // Surface staged write actions to the frontend so it can render a
        // confirm/cancel card for each one.
        for (_, _, tool_result) in &tool_results {
            if tool_result.success
                && tool_result.data.get("status").and_then(|v| v.as_str())
                    == Some("pending_user_confirmation")
            {
                staged_pending_actions.push(tool_result.data.clone());
            }
        }

        // If this was the last round and the AI still wants tools, summarize
        if round == max_rounds - 1 && !tool_results.is_empty() {
            if final_content.is_empty() {
                final_content = "Ik heb de beschikbare data opgehaald. Meer details nodig? Stel gerust een vervolgvraag!".to_string();
            }
        }
    }

    Ok(AiChatWithToolsResult {
        content: final_content,
        pending_actions: staged_pending_actions,
    })
}

/// Confirm and execute a previously-staged AI action (e.g. sending a message).
///
/// This is the only path that performs real write operations on the user's
/// behalf. The pending action is consumed: it can only be confirmed once and
/// expires after [`crate::ai::tools::PENDING_ACTION_TTL_SECS`] seconds.
#[tauri::command]
pub async fn confirm_pending_action(
    state: State<'_, AiState>,
    client: State<'_, SharedClient>,
    action_id: String,
) -> Result<String, String> {
    let action: PendingAction = {
        let mut store = state.pending_actions.lock().map_err(|e| e.to_string())?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Prune expired actions so a stale confirm button can never fire.
        store.retain(|_, a| now.saturating_sub(a.created_at) < tools::PENDING_ACTION_TTL_SECS);
        store.remove(&action_id).ok_or_else(|| {
            "De actie is niet meer beschikbaar (verlopen of al bevestigd).".to_string()
        })?
    };

    let mut c = client.lock().await;
    let result = execute_pending_action(&mut c, &action).await?;
    Ok(serde_json::to_string(&result).unwrap_or_else(|_| "Actie uitgevoerd.".to_string()))
}

/// Get a quick AI insight for a specific page.
/// This is a convenience wrapper that builds the messages and calls ai_chat.
#[tauri::command]
pub async fn ai_page_insight(
    state: State<'_, AiState>,
    page: String,
    data_json: String,
    query: String,
) -> Result<String, String> {
    let page_context = match page.as_str() {
        "dashboard" => format!(
            "Pagina: Dashboard (overzicht)\nData: {}\nVraag: {}",
            data_json, query
        ),
        "grades" => format!(
            "Pagina: Cijfers\nData: {}\nVraag: {}",
            data_json, query
        ),
        _ => format!(
            "Pagina: {}\nData: {}\nVraag: {}",
            page, data_json, query
        ),
    };

    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    let system_prompt = crate::ai_client::build_school_context_system_prompt(Some(&page_context), false);

    let ai_messages = vec![
        providers::AiMessage::simple("system", system_prompt),
        providers::AiMessage::simple("user", query),
    ];

    crate::ai_client::send_chat(&config, &ai_messages).await
}

/// List available models from the configured provider.
#[tauri::command]
pub async fn list_ai_models(state: State<'_, AiState>) -> Result<Vec<String>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    crate::ai_client::list_models(&config).await
}