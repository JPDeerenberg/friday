use crate::ai::providers::{self, AiConfig, AiMessage, AiProviderType};
use crate::ai::tools::{self, execute_pending_action, execute_tool, PendingAction, PendingActionStore};
use crate::client::SharedClient;
use crate::models::ai_schedule::{AiScheduleItem, AiScheduleItemType, AiScheduleSource, AiScheduleStatus, DurationSource};
use crate::secure_store;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// Shared state for AI configuration, stored in memory + synced to disk.
///
/// The API key is the only secret and lives in the OS keyring
/// ([`crate::secure_store`]); everything else (base_url, model, provider,
/// enabled flags) is persisted to `ai_config.json` in plaintext.
pub struct AiState {
    pub config: Arc<Mutex<AiConfig>>,
    /// Side-effecting AI actions awaiting explicit user confirmation.
    pub pending_actions: PendingActionStore,
    config_path: PathBuf,
}

impl AiState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let config_path = app_data_dir.join("ai_config.json");
        let config = if config_path.exists() {
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            AiConfig::default()
        };

        Self {
            config: Arc::new(Mutex::new(config)),
            pending_actions: Mutex::new(HashMap::new()),
            config_path,
        }
    }

    /// Load the API key after Tauri's Android UI context has had time to initialize.
    pub async fn load_api_key_async(config: Arc<Mutex<AiConfig>>) {
        // The Android keyring performs JNI calls and must not run on the async
        // executor thread. In particular, it reads ndk-context during startup.
        let result = tokio::task::spawn_blocking(|| {
            secure_store::get_secret(secure_store::USER_AI_API_KEY)
        })
        .await;

        let Ok(Ok(Some(api_key))) = result else {
            return;
        };

        if let Ok(mut current) = config.lock() {
            // Do not overwrite a key supplied by a command while loading.
            if current.api_key.is_empty() {
                current.api_key = api_key;
            }
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
    schedule_state: State<'_, crate::commands::ai_schedule::AiScheduleState>,
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

        // Execute each tool call — schedule tools are handled via AiScheduleState,
        // Magister tools via MagisterClient. Both are auto-applying (schedule is sandboxed),
        // while Magister writes remain staged for user confirmation.
        let mut tool_results: Vec<(String, String, tools::ToolResult)> = Vec::new();
        for tool_call in &result.tool_calls {
            let is_schedule_tool = matches!(
                tool_call.name.as_str(),
                "get_ai_schedule"
                    | "create_ai_schedule_item"
                    | "update_ai_schedule_item"
                    | "complete_ai_schedule_item"
                    | "dismiss_ai_schedule_item"
                    | "set_homework_duration"
                    | "run_update_ai_schedule"
            );
            let tool_result = if is_schedule_tool {
                handle_schedule_tool(
                    &tool_call.name,
                    &tool_call.arguments,
                    &schedule_state,
                    &client,
                    person_id,
                )
                .await
            } else {
                let mut c = client.lock().await;
                execute_tool(&mut c, &tool_call.name, &tool_call.arguments, person_id, &state.pending_actions).await
            };
            if !tool_result.success {
                log::error!(
                    "AI tool '{}' failed. Arguments: {} Error: {}",
                    tool_call.name,
                    tool_call.arguments,
                    tool_result.error.as_deref().unwrap_or("Onbekende fout")
                );
            }
            tool_results.push((tool_call.id.clone(), tool_call.name.clone(), tool_result));
        }

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

async fn handle_schedule_tool(
    tool_name: &str,
    args: &Value,
    schedule_state: &State<'_, crate::commands::ai_schedule::AiScheduleState>,
    client: &State<'_, SharedClient>,
    person_id: i64,
) -> tools::ToolResult {
    match tool_name {
        "get_ai_schedule" => {
            let start = args.get("start").and_then(|v| v.as_str()).unwrap_or("");
            let end = args.get("end").and_then(|v| v.as_str()).unwrap_or("");
            let s = crate::ai::schedule::iso_to_naive(start);
            let e = crate::ai::schedule::iso_to_naive(end);
            if s.is_none() || e.is_none() {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Ongeldige start/eind datum (verwacht ISO 8601).".to_string()),
                };
            }
            let s = s.unwrap();
            let e = e.unwrap();
            let items = schedule_state.items.read().await;
            let filtered: Vec<Value> = items
                .iter()
                .filter(|item| {
                    if let (Some(is), Some(ie)) = (
                        crate::ai::schedule::iso_to_naive(&item.start),
                        crate::ai::schedule::iso_to_naive(&item.end),
                    ) {
                        ie >= s && is <= e
                    } else {
                        false
                    }
                })
                .map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
                .collect();
            let count = filtered.len();
            tools::ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({ "items": filtered, "count": count }),
                error: None,
            }
        }
        "create_ai_schedule_item" => {
            // Build item from args
            let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if title.is_empty() {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Titel is verplicht.".to_string()),
                };
            }
            let item_type_str = args.get("item_type").and_then(|v| v.as_str()).unwrap_or("custom");
            let item_type = match item_type_str {
                "assignment_work" => AiScheduleItemType::AssignmentWork,
                "study_block" => AiScheduleItemType::StudyBlock,
                "homework_review" => AiScheduleItemType::HomeworkReview,
                "custom" => AiScheduleItemType::Custom,
                "break" => AiScheduleItemType::Break,
                "free_time" => AiScheduleItemType::FreeTime,
                "sleep" => AiScheduleItemType::Sleep,
                _ => AiScheduleItemType::Custom,
            };
            let start = args.get("start").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let end = args.get("end").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let urgency = args.get("urgency").and_then(|v| v.as_i64()).unwrap_or(3) as u8;
            if !(1..=5).contains(&urgency) {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Urgency moet 1-5 zijn.".to_string()),
                };
            }
            let now = chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
            let mut item = AiScheduleItem {
                id: format!("ai-{}-{}", chrono::Utc::now().timestamp_millis(), {
                    use rand::RngExt;
                    let r: u32 = rand::rng().random();
                    r
                }),
                title,
                description: args.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
                item_type,
                start: start.clone(),
                end: end.clone(),
                status: AiScheduleStatus::Planned,
                urgency,
                related_assignment_id: args.get("related_assignment_id").and_then(|v| v.as_i64()),
                related_calendar_event_id: args.get("related_calendar_event_id").and_then(|v| v.as_i64()),
                related_subject: args.get("related_subject").and_then(|v| v.as_str()).map(|s| s.to_string()),
                estimated_minutes: args.get("estimated_minutes").and_then(|v| v.as_i64()).map(|v| v as u32),
                duration_source: args
                    .get("estimated_minutes")
                    .and_then(|v| v.as_i64())
                    .map(|_| DurationSource::AiEstimated),
                source: AiScheduleSource::AiChat,
                created_at: now.clone(),
                updated_at: now.clone(),
                completed_at: None,
            };
            // Validate
            if crate::ai::schedule::iso_to_naive(&item.start).is_none()
                || crate::ai::schedule::iso_to_naive(&item.end).is_none()
            {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Ongeldige start/eind datum.".to_string()),
                };
            }
            let s = crate::ai::schedule::iso_to_naive(&item.start).unwrap();
            let e = crate::ai::schedule::iso_to_naive(&item.end).unwrap();
            if e <= s {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Eind moet na start liggen.".to_string()),
                };
            }
            let mut items = schedule_state.items.write().await;
            items.push(item.clone());
            schedule_state.save(&items);
            tools::ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::to_value(&item).unwrap_or(Value::Null),
                error: None,
            }
        }
        "update_ai_schedule_item" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("ID is verplicht.".to_string()),
                };
            }
            let mut items = schedule_state.items.write().await;
            let idx = items.iter().position(|i| i.id == id);
            let idx = match idx {
                Some(i) => i,
                None => {
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(format!("Item '{}' niet gevonden.", id)),
                    }
                }
            };
            // Apply patch
            let mut item = items[idx].clone();
            if let Some(v) = args.get("title").and_then(|v| v.as_str()) {
                item.title = v.to_string();
            }
            if let Some(v) = args.get("description").and_then(|v| v.as_str()) {
                item.description = Some(v.to_string());
            }
            if let Some(v) = args.get("item_type").and_then(|v| v.as_str()) {
                item.item_type = match v {
                    "assignment_work" => AiScheduleItemType::AssignmentWork,
                    "study_block" => AiScheduleItemType::StudyBlock,
                    "homework_review" => AiScheduleItemType::HomeworkReview,
                    "custom" => AiScheduleItemType::Custom,
                    "break" => AiScheduleItemType::Break,
                    "free_time" => AiScheduleItemType::FreeTime,
                    "sleep" => AiScheduleItemType::Sleep,
                    _ => item.item_type,
                };
            }
            if let Some(v) = args.get("start").and_then(|v| v.as_str()) {
                item.start = v.to_string();
            }
            if let Some(v) = args.get("end").and_then(|v| v.as_str()) {
                item.end = v.to_string();
            }
            if let Some(v) = args.get("urgency").and_then(|v| v.as_i64()) {
                if !(1..=5).contains(&(v as u8)) {
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some("Urgency moet 1-5 zijn.".to_string()),
                    };
                }
                item.urgency = v as u8;
            }
            if let Some(v) = args.get("estimated_minutes").and_then(|v| v.as_i64()) {
                item.estimated_minutes = Some(v as u32);
                item.duration_source = Some(DurationSource::AiEstimated);
            }
            if let Some(v) = args.get("status").and_then(|v| v.as_str()) {
                item.status = match v {
                    "planned" => AiScheduleStatus::Planned,
                    "in_progress" => AiScheduleStatus::InProgress,
                    "completed" => AiScheduleStatus::Completed,
                    "dismissed" => AiScheduleStatus::Dismissed,
                    _ => item.status,
                };
                if item.status == AiScheduleStatus::Completed && item.completed_at.is_none() {
                    item.completed_at = Some(chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string());
                }
                if item.status != AiScheduleStatus::Completed {
                    item.completed_at = None;
                }
            }
            item.updated_at = chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
            // Validate
            if let (Some(s), Some(e)) = (
                crate::ai::schedule::iso_to_naive(&item.start),
                crate::ai::schedule::iso_to_naive(&item.end),
            ) {
                if e <= s {
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some("Eind moet na start liggen.".to_string()),
                    };
                }
            }
            items[idx] = item.clone();
            let snapshot = items.clone();
            schedule_state.save(&snapshot);
            tools::ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::to_value(&item).unwrap_or(Value::Null),
                error: None,
            }
        }
        "complete_ai_schedule_item" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mut items = schedule_state.items.write().await;
            let item = items.iter_mut().find(|i| i.id == id);
            match item {
                Some(it) => {
                    it.status = AiScheduleStatus::Completed;
                    let now = chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
                    it.completed_at = Some(now.clone());
                    it.updated_at = now;
                    let snapshot = items.clone();
                    schedule_state.save(&snapshot);
                    tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "id": id, "status": "completed" }),
                        error: None,
                    }
                }
                None => tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(format!("Item '{}' niet gevonden.", id)),
                },
            }
        }
        "dismiss_ai_schedule_item" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mut items = schedule_state.items.write().await;
            let item = items.iter_mut().find(|i| i.id == id);
            match item {
                Some(it) => {
                    it.status = AiScheduleStatus::Dismissed;
                    it.updated_at = chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
                    let snapshot = items.clone();
                    schedule_state.save(&snapshot);
                    tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "id": id, "status": "dismissed" }),
                        error: None,
                    }
                }
                None => tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(format!("Item '{}' niet gevonden.", id)),
                },
            }
        }
        "set_homework_duration" => {
            let assignment_id = args.get("assignment_id").and_then(|v| v.as_i64());
            let estimated_minutes = args.get("estimated_minutes").and_then(|v| v.as_i64()).map(|v| v as u32);
            let urgency = args.get("urgency").and_then(|v| v.as_i64()).map(|v| v as u8);
            if assignment_id.is_none() || estimated_minutes.is_none() {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("assignment_id en estimated_minutes zijn verplicht.".to_string()),
                };
            }
            let assignment_id = assignment_id.unwrap();
            let estimated_minutes = estimated_minutes.unwrap();
            if estimated_minutes == 0 || estimated_minutes > 600 {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Ongeldige duur (1-600).".to_string()),
                };
            }
            if let Some(u) = urgency {
                if !(1..=5).contains(&u) {
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some("Urgency moet 1-5 zijn.".to_string()),
                    };
                }
            }
            let mut items = schedule_state.items.write().await;
            let now = chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
            if let Some(item) = items.iter_mut().find(|i| i.related_assignment_id == Some(assignment_id)) {
                item.estimated_minutes = Some(estimated_minutes);
                item.duration_source = Some(DurationSource::UserEntered);
                if let Some(u) = urgency {
                    item.urgency = u;
                }
                item.updated_at = now.clone();
                let cloned = item.clone();
                let snapshot = items.clone();
                schedule_state.save(&snapshot);
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: true,
                    data: serde_json::to_value(&cloned).unwrap_or(Value::Null),
                    error: None,
                };
            }
            // No existing item: create one
            let new_item = AiScheduleItem {
                id: format!("work-{}-manual", assignment_id),
                title: format!("Huiswerk {}", assignment_id),
                description: Some("Duur ingesteld via AI".to_string()),
                item_type: AiScheduleItemType::AssignmentWork,
                start: now.clone(),
                end: {
                    let start_dt = crate::ai::schedule::iso_to_naive(&now).unwrap_or(chrono::Local::now().naive_local());
                    let end_dt = start_dt + chrono::Duration::minutes(estimated_minutes as i64);
                    crate::ai::schedule::naive_to_iso(end_dt)
                },
                status: AiScheduleStatus::Planned,
                urgency: urgency.unwrap_or(3),
                related_assignment_id: Some(assignment_id),
                related_calendar_event_id: None,
                related_subject: args.get("subject").and_then(|v| v.as_str()).map(|s| s.to_string()),
                estimated_minutes: Some(estimated_minutes),
                duration_source: Some(DurationSource::UserEntered),
                source: AiScheduleSource::User,
                created_at: now.clone(),
                updated_at: now,
                completed_at: None,
            };
            items.push(new_item.clone());
            let snapshot = items.clone();
            schedule_state.save(&snapshot);
            tools::ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::to_value(&new_item).unwrap_or(Value::Null),
                error: None,
            }
        }
        "run_update_ai_schedule" => {
            // Trigger the same planning as the manual button
            if person_id == 0 {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Geen person_id beschikbaar voor planning.".to_string()),
                };
            }
            // Need to clone client Arc for inner
            let client_clone = (**client).clone();
            let settings = crate::ai::schedule::ScheduleSettings::default();
            match crate::commands::ai_schedule::perform_update_inner(schedule_state, client_clone, person_id, settings).await {
                Ok(updated) => {
                    let vals: Vec<Value> = updated.iter().map(|i| serde_json::to_value(i).unwrap_or(Value::Null)).collect();
                    tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "items": vals, "count": vals.len(), "message": "Planning bijgewerkt voor deze week + volgende week." }),
                        error: None,
                    }
                }
                Err(e) => tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e),
                },
            }
        }
        _ => tools::ToolResult {
            tool: tool_name.to_string(),
            success: false,
            data: Value::Null,
            error: Some(format!("Onbekende schedule tool: {}", tool_name)),
        },
    }
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
