use crate::ai::providers::{self, AiConfig, AiMessage, AiProviderType, StreamEvent};
use crate::ai::tools::{self, execute_pending_action, execute_tool, PendingAction, PendingActionStore};
use crate::client::SharedClient;
use crate::models::ai_schedule::{AiScheduleItem, AiScheduleItemType, AiScheduleSource, AiScheduleStatus, DurationSource};
use crate::secure_store;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

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
    ai_notes_ai_can_edit: bool,
    ai_notes_use_in_chats: bool,
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
    config.ai_notes_ai_can_edit = ai_notes_ai_can_edit;
    config.ai_notes_use_in_chats = ai_notes_use_in_chats;

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
    notes_state: State<'_, crate::commands::ai_notes::AiNotesState>,
    app: AppHandle,
    messages_json: String,
    page_context: Option<String>,
) -> Result<String, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();

    let mut messages: Vec<AiMessage> =
        serde_json::from_str(&messages_json).map_err(|e| format!("Ongeldig berichtformaat: {}", e))?;

    // Prepend system prompt with page context (no tools — this is the non-data-access version)
    let notes = notes_prompt_for(&notes_state, config.ai_notes_use_in_chats, config.ai_notes_ai_can_edit).await;
    let system_prompt =
        crate::ai_client::build_school_context_system_prompt(page_context.as_deref(), None, notes.as_ref());
    messages.insert(
        0,
        AiMessage::simple("system", system_prompt),
    );

    let diag_start = std::time::Instant::now();
    let provider = providers::get_provider(&config.provider);
    let mut text_buf = String::new();
    let mut last_flush = std::time::Instant::now();
    let never_stop = || false;
    let mut on_text = |ev: StreamEvent| {
        let StreamEvent::TextDelta(delta) = ev else {
            return;
        };
        text_buf.push_str(&delta);
        if text_buf.len() >= 1000 || last_flush.elapsed() >= std::time::Duration::from_millis(150) {
            let d = std::mem::take(&mut text_buf);
            emit_activity(&app, "text", None, Some(&d));
            last_flush = std::time::Instant::now();
        }
    };
    emit_activity(&app, "answer", None, None);
    let out = provider
        .chat_stream(&config, &messages, &[], &never_stop, &mut on_text)
        .await
        .map(|r| r.content);
    if !text_buf.is_empty() {
        let d = std::mem::take(&mut text_buf);
        emit_activity(&app, "text", None, Some(&d));
    }
    emit_activity(&app, "idle", None, None);
    let status = if out.is_ok() { "ok" } else { "error" };
    record_ai_diag(AiDiagEntry {
        ts: now_millis(),
        platform: "desktop".to_string(),
        provider: provider_id(&config.provider).to_string(),
        model: config.model.clone(),
        op: "chat".to_string(),
        status: status.to_string(),
        duration_ms: diag_start.elapsed().as_millis() as u64,
        error_class: out.as_ref().err().map(|e| diag_error_class(e).to_string()),
        tool_names: Vec::new(),
    });
    out
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
    /// True when the user stopped generation mid-turn (partial content kept).
    pub stopped: bool,
    /// True when an AI plan mutation succeeded this turn (undo chip).
    pub plan_changed: bool,
    /// Compact per-turn tool trace for persistence (item 4).
    pub trace: Vec<TurnTrace>,
}

/// Max tool rounds per turn (plan item 5).
const MAX_ROUNDS: usize = 8;
/// Per-tool timeout in seconds (plan item 1).
const TOOL_TIMEOUT_SECS: u64 = 15;
/// File reads get longer (plan item 1).
const FILE_READ_TIMEOUT_SECS: u64 = 30;
const FILE_READ_TOOLS: &[&str] = &["read_attachment_text", "download_file"];
/// Final tools-disabled nudge (plan item 5).
const FINAL_NUDGE: &str = "Geef nu je beste antwoord met wat je hebt; zeg wat ontbreekt.";
/// Empty-content last resort (only when even the final call is blank).
const EMPTY_FALLBACK: &str = "Ik kon geen antwoord formuleren. Probeer het opnieuw.";
/// Provider attempts per chat call: 1 try + 2 retries (plan item 6).
const MAX_CHAT_ATTEMPTS: u32 = 3;
/// Max AI plan item writes per turn (plan item 5 bulk cap), counted on attempts.
const MAX_PLAN_WRITES_PER_TURN: usize = 10;
/// Plan-mutating tools covered by the bulk cap (run_update excluded: single
/// planned op with already-bounded output).
const PLAN_WRITE_TOOLS: &[&str] = &[
    "create_ai_schedule_item",
    "update_ai_schedule_item",
    "complete_ai_schedule_item",
    "dismiss_ai_schedule_item",
    "delete_ai_schedule_item",
    "move_ai_schedule_item",
    "set_homework_duration",
];

/// Compact per-turn tool trace for persistence (Phase 5 item 4).
#[derive(Debug, Clone, Serialize)]
pub struct ToolCallTrace {
    pub name: String,
    pub args: Value,
    pub ok: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnTrace {
    /// Assistant text of the turn (may be empty when thinking).
    pub text: String,
    pub calls: Vec<ToolCallTrace>,
}

/// Diagnostics ring buffer (plan item 6b/12): last 50 AI requests with
/// metadata only — never content, never keys.
#[derive(Debug, Clone, Serialize)]
pub struct AiDiagEntry {
    /// Epoch millis.
    pub ts: u64,
    pub platform: String,
    pub provider: String,
    pub model: String,
    /// "chat" | "tools".
    pub op: String,
    /// "ok" | "error" | "aborted" | "stopped".
    pub status: String,
    pub duration_ms: u64,
    /// Error class only (never messages that could hold keys).
    pub error_class: Option<String>,
    /// Tool names called this turn — never arguments or results.
    pub tool_names: Vec<String>,
}

/// Ring capacity (matches TS DIAG_LIMIT).
pub const DIAG_LIMIT: usize = 50;

static AI_DIAGNOSTICS: Mutex<VecDeque<AiDiagEntry>> = Mutex::new(VecDeque::new());

/// Record one AI request. Never panics, never blocks the chat.
pub fn record_ai_diag(entry: AiDiagEntry) {
    if let Ok(mut buf) = AI_DIAGNOSTICS.lock() {
        buf.push_back(entry);
        while buf.len() > DIAG_LIMIT {
            buf.pop_front();
        }
    }
}

/// Best-effort error class for a provider error string.
fn diag_error_class(msg: &str) -> &'static str {
    let m = msg.to_lowercase();
    if m.contains("401") || m.contains("403") || m.contains("invalid_api_key") || m.contains("unauthorized") {
        "invalid_key"
    } else if m.contains("404") || m.contains("model_not_found") || m.contains("model not found") {
        "model_not_found"
    } else if m.contains("429") || m.contains("te veel verzoeken") || m.contains("rate limit") {
        "rate_limited"
    } else if is_context_overflow(msg) {
        "context_too_long"
    } else if m.contains("abort") {
        "aborted"
    } else {
        "unknown"
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Wire provider id for diagnostics (matches the TS provider strings).
fn provider_id(provider: &AiProviderType) -> &'static str {
    match provider {
        AiProviderType::OpenAI => "openai",
        AiProviderType::Anthropic => "anthropic",
        AiProviderType::Gemini => "gemini",
        AiProviderType::DeepSeek => "deepseek",
        AiProviderType::Mistral => "mistral",
        AiProviderType::OpenAICompatible => "openai_compatible",
    }
}

/// List buffered AI diagnostics, newest first.
#[tauri::command]
pub fn get_ai_diagnostics() -> Vec<AiDiagEntry> {
    match AI_DIAGNOSTICS.lock() {
        Ok(buf) => buf.iter().rev().cloned().collect(),
        Err(_) => Vec::new(),
    }
}

/// Clear buffered AI diagnostics.
#[tauri::command]
pub fn clear_ai_diagnostics() -> Result<(), String> {
    match AI_DIAGNOSTICS.lock() {
        Ok(mut buf) => {
            buf.clear();
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Cancellation generation for `cancel_ai_chat` (plan item 7). The loop
/// captures the generation at start and stops at the next checkpoint when it
/// changes. In-flight provider calls are not aborted (streaming in Phase 6b
/// will fix that); everything between checkpoints stops promptly.
static AI_CHAT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Ask a running tool loop to stop at the next checkpoint. Best-effort and idempotent.
#[tauri::command]
pub async fn cancel_ai_chat() -> Result<(), String> {
    AI_CHAT_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// True when `code` (e.g. "429") appears as a standalone number, not as part
/// of a longer digit run (so "1503" never matches "503").
fn contains_status(hay: &str, code: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = hay[start..].find(code) {
        let i = start + pos;
        let before_ok = i == 0 || !hay.as_bytes()[i - 1].is_ascii_digit();
        let after_ok = hay
            .as_bytes()
            .get(i + code.len())
            .map(|b| !b.is_ascii_digit())
            .unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
        start = i + 1;
    }
    false
}

/// Retryable provider failures (plan item 6): transient network errors and
/// 408/429/502/503/504. Never 400/401/403/404, unknown models, or bad keys.
/// Mirrors TS `classifyAiError` retryability.
fn provider_error_retryable(msg: &str) -> bool {
    let m = msg.to_lowercase();
    for code in ["401", "403", "404"] {
        if contains_status(&m, code) {
            return false;
        }
    }
    for phrase in [
        "invalid_api_key",
        "incorrect api key",
        "unauthorized",
        "model_not_found",
        "model not found",
    ] {
        if m.contains(phrase) {
            return false;
        }
    }
    for code in ["408", "429", "502", "503", "504"] {
        if contains_status(&m, code) {
            return true;
        }
    }
    for phrase in [
        "timed out",
        "timeout",
        "connection",
        "network",
        "dns",
        "reset by peer",
        "broken pipe",
        "econn",
        "enotfound",
        "temporarily unavailable",
        "service unavailable",
        "bad gateway",
        "gateway timeout",
    ] {
        if m.contains(phrase) {
            return true;
        }
    }
    false
}

/// Provider errors that mean "history too long" (trim + retry once, never
/// blind-retry).
fn is_context_overflow(msg: &str) -> bool {
    let m = msg.to_lowercase();
    for phrase in [
        "maximum context",
        "context length",
        "context_length",
        "context window",
        "token limit",
        "max tokens",
        "too many tokens",
        "too long",
    ] {
        if m.contains(phrase) {
            return true;
        }
    }
    false
}

/// Call the provider with up to 2 retries and exponential backoff + jitter.
/// Never retries fatal errors (see `provider_error_retryable`).
/// Backoff before retry attempt n (0-based): 500ms, 1s… plus jitter.
fn retry_delay_ms(attempt: u32) -> u64 {
    let base = 500u64.saturating_mul(1 << attempt).min(8000);
    let jitter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.subsec_nanos() % 250) as u64)
        .unwrap_or(0);
    base + jitter
}

async fn chat_with_retry(
    provider: &dyn providers::AiProvider,
    config: &AiConfig,
    messages: &[providers::AiMessage],
    tools: &[tools::ToolDef],
) -> Result<providers::AiChatResult, String> {
    let mut attempt: u32 = 0;
    loop {
        match provider.chat(config, messages, tools).await {
            Ok(r) => return Ok(r),
            Err(e) => {
                if !provider_error_retryable(&e) || attempt >= MAX_CHAT_ATTEMPTS - 1 {
                    return Err(e);
                }
                tokio::time::sleep(std::time::Duration::from_millis(retry_delay_ms(attempt))).await;
                attempt += 1;
            }
        }
    }
}

/// Emit an `ai-activity` event for the chat UI (best-effort).
fn emit_activity(app: &AppHandle, kind: &str, tool: Option<&str>, delta: Option<&str>) {
    let mut payload = serde_json::json!({ "kind": kind });
    if let Some(t) = tool {
        payload["tool"] = serde_json::Value::String(t.to_string());
    }
    if let Some(d) = delta {
        payload["delta"] = serde_json::Value::String(d.to_string());
    }
    let _ = app.emit("ai-activity", payload);
}

/// Streaming chat with the same retry policy as [`chat_with_retry`].
/// `on_attempt` fires before every attempt (the UI resets streamed text on
/// retries); text deltas flow through `on_text` throttled by the caller.
#[allow(clippy::too_many_arguments)]
async fn chat_stream_with_retry(
    provider: &dyn providers::AiProvider,
    config: &AiConfig,
    messages: &[providers::AiMessage],
    tools: &[tools::ToolDef],
    should_stop: &(dyn Fn() -> bool + Send + Sync),
    on_attempt: &mut (dyn FnMut(u32) + Send),
    on_text: &mut (dyn FnMut(String) + Send),
) -> Result<providers::AiChatResult, String> {
    use crate::ai::providers::StreamEvent;
    let mut attempt: u32 = 0;
    loop {
        on_attempt(attempt);
        let mut events = |ev: StreamEvent| {
            if let StreamEvent::TextDelta(d) = ev {
                on_text(d);
            }
        };
        match provider
            .chat_stream(config, messages, tools, should_stop, &mut events)
            .await
        {
            Ok(r) => return Ok(r),
            Err(e) => {
                if !provider_error_retryable(&e) || attempt >= MAX_CHAT_ATTEMPTS - 1 {
                    return Err(e);
                }
                tokio::time::sleep(std::time::Duration::from_millis(retry_delay_ms(attempt))).await;
                attempt += 1;
            }
        }
    }
}

/// Keep the system prompt plus the last few turns for one recovery retry.
/// (Phase 5 upgrades this to a rolling summary.)
fn trim_history(messages: &mut Vec<providers::AiMessage>) {
    if messages.is_empty() {
        return;
    }
    const KEEP: usize = 4;
    if messages.len() <= KEEP + 1 {
        return;
    }
    let tail: Vec<providers::AiMessage> = messages[messages.len() - KEEP..].to_vec();
    if messages[0].role == "system" {
        let head = messages[0].clone();
        messages.clear();
        messages.push(head);
        messages.extend(tail);
    } else {
        *messages = tail;
    }
}

fn canonical_json(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_default(),
        Value::Array(a) => {
            let parts: Vec<String> = a.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_default(),
                        canonical_json(&o[*k])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// Stable dedupe key: same name + same args (any key order) = same call.
/// Mirrors TS `dedupeKey`.
fn dedupe_key(name: &str, args: &Value) -> String {
    format!("{}\n{}", name, canonical_json(args))
}

/// Load the AI-Geheugen prompt block when enabled; never fails the chat.
async fn notes_prompt_for(
    notes_state: &State<'_, crate::commands::ai_notes::AiNotesState>,
    use_in_chats: bool,
    can_edit: bool,
) -> Option<crate::commands::ai_notes::NotesPrompt> {
    if !use_in_chats {
        return None;
    }
    let notes = notes_state.notes.read().await;
    Some(crate::commands::ai_notes::NotesPrompt {
        content: notes.content.clone(),
        revision: notes.revision,
        updated_by: notes.updated_by.clone(),
        writable: can_edit,
    })
}

/// Send a chat message with full Magister data access via tool calling.
/// This version has access to execute tools that fetch real school data.
#[tauri::command]
pub async fn ai_chat_with_tools(
    state: State<'_, AiState>,
    client: State<'_, SharedClient>,
    schedule_state: State<'_, crate::commands::ai_schedule::AiScheduleState>,
    notes_state: State<'_, crate::commands::ai_notes::AiNotesState>,
    app: AppHandle,
    messages_json: String,
    page_context: Option<String>,
    person_id: i64,
    plan_settings: Option<Value>,
) -> Result<AiChatWithToolsResult, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    // Frontend AI-Planning settings (same store as Settings); the AI replan
    // and free-slot tools respect them instead of silently using defaults.
    let plan_settings = plan_settings
        .as_ref()
        .map(parse_plan_settings)
        .unwrap_or_default();

    let mut messages: Vec<providers::AiMessage> =
        serde_json::from_str(&messages_json).map_err(|e| format!("Ongeldig berichtformaat: {}", e))?;

    // Prepend system prompt with page context and tools enabled.
    // Filtering happens first so listed tools always match offered tools.
    let mut tools = tools::get_all_tool_defs();
    // Notes tools follow the Geheugen settings: unreadable when chats opt
    // out entirely, write tools hidden when editing is disabled.
    if !config.ai_notes_use_in_chats {
        tools.retain(|t| !tools::NOTES_TOOLS.contains(&t.name.as_str()));
    } else if !config.ai_notes_ai_can_edit {
        tools.retain(|t| !tools::NOTES_WRITE_TOOLS.contains(&t.name.as_str()));
    }
    let notes = notes_prompt_for(&notes_state, config.ai_notes_use_in_chats, config.ai_notes_ai_can_edit).await;
    let system_prompt = crate::ai_client::build_school_context_system_prompt(
        page_context.as_deref(),
        Some(&tools),
        notes.as_ref(),
    );
    messages.insert(
        0,
        providers::AiMessage::simple("system", system_prompt),
    );

    // Call AI with tools (up to MAX_ROUNDS rounds of tool execution).
    // Desktop executes sequentially: execute_tool needs &mut MagisterClient
    // and concurrent token refreshes would storm the rotating refresh token
    // (see the staleness guard in client.rs) — the web loop parallelises
    // reads instead. Policy otherwise mirrors TS runToolLoop.
    let provider = providers::get_provider(&config.provider);

    let start_gen = AI_CHAT_GENERATION.load(std::sync::atomic::Ordering::SeqCst);
    let cancelled = || AI_CHAT_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != start_gen;
    let should_stop = || cancelled();

    let mut current_messages = messages.clone();
    let mut final_content = String::new();
    let mut staged_pending_actions: Vec<Value> = Vec::new();
    // Phase 3 budget: all successful tool payloads of this turn counted together.
    let mut budget = crate::ai::budget::TurnBudget::new();
    // Dedupe: identical calls within the turn share one execution + note.
    let mut dedupe: HashMap<String, (String, bool)> = HashMap::new();
    // Compact per-turn tool trace for persistence (item 4).
    let mut trace: Vec<TurnTrace> = Vec::new();
    // Diagnostics (item 12): per-turn metadata only.
    let diag_start = std::time::Instant::now();
    let mut diag_tools: Vec<String> = Vec::new();
    // Bulk cap (plan item 5): max AI plan item writes per turn.
    let mut plan_writes: usize = 0;
    let mut plan_changed = false;
    let mut tool_calls_seen = false;
    let mut budget_tripped = false;
    let mut trim_retried = false;
    let mut rounds_used: usize = 0;

    let mut round: usize = 0;
    let mut stopped = false;
    while round < MAX_ROUNDS {
        if cancelled() {
            stopped = true;
            break;
        }
        // Text throttle: accumulate deltas, flush ~7x/sec or per 1000 chars
        // so the UI renders live without event spam.
        let mut text_buf = String::new();
        let mut last_flush = std::time::Instant::now();
        let mut on_text = |delta: String| {
            text_buf.push_str(&delta);
            if text_buf.len() >= 1000
                || last_flush.elapsed() >= std::time::Duration::from_millis(150)
            {
                let d = std::mem::take(&mut text_buf);
                emit_activity(&app, "text", None, Some(&d));
                last_flush = std::time::Instant::now();
            }
        };
        let mut on_attempt = |_attempt: u32| {
            emit_activity(&app, "answer", None, None);
        };
        let result = match chat_stream_with_retry(
            provider.as_ref(),
            &config,
            &current_messages,
            &tools,
            &should_stop,
            &mut on_attempt,
            &mut on_text,
        )
        .await
        {
            Ok(r) => r,
            Err(e) if is_context_overflow(&e) && !trim_retried => {
                trim_retried = true;
                trim_history(&mut current_messages);
                continue; // same round again, trimmed
            }
            Err(e) => {
                record_ai_diag(AiDiagEntry {
                    ts: now_millis(),
                    platform: "desktop".to_string(),
                    provider: provider_id(&config.provider).to_string(),
                    model: config.model.clone(),
                    op: "tools".to_string(),
                    status: if e.to_lowercase().contains("abort") {
                        "aborted".to_string()
                    } else {
                        "error".to_string()
                    },
                    duration_ms: diag_start.elapsed().as_millis() as u64,
                    error_class: Some(diag_error_class(&e).to_string()),
                    tool_names: diag_tools.clone(),
                });
                return Err(e);
            }
        };
        // Flush any throttled remainder of this round's deltas.
        if !text_buf.is_empty() {
            let d = std::mem::take(&mut text_buf);
            emit_activity(&app, "text", None, Some(&d));
        }

        // Store the text content (AI might respond with only tool calls and no text — that's fine)
        if !result.content.is_empty() {
            final_content = result.content.clone();
        }

        // If no tool calls, we're done
        if result.tool_calls.is_empty() {
            break;
        }
        tool_calls_seen = true;
        rounds_used = round + 1;

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
        // Every call gets a result (timeout or structured error, never a throw).
        let mut pending_trace: Vec<ToolCallTrace> = Vec::new();
        'calls: for tool_call in &result.tool_calls {
            if cancelled() {
                stopped = true;
                break 'calls;
            }
            if !diag_tools.contains(&tool_call.name) {
                diag_tools.push(tool_call.name.clone());
            }
            let key = dedupe_key(&tool_call.name, &tool_call.arguments);
            let mut round_trace: Option<ToolCallTrace> = None;
            let result_content = if let Some((cached, was_ok)) = dedupe.get(&key) {
                round_trace = Some(ToolCallTrace {
                    name: tool_call.name.clone(),
                    args: tool_call.arguments.clone(),
                    ok: *was_ok,
                    text: cached.clone(),
                });
                format!(
                    "{}\n[Notitie: identieke tool-aanroep als eerder deze beurt — cached resultaat hergebruikt.]",
                    cached
                )
            } else {
                // Bulk cap: max 10 AI plan item writes per turn, counted on
                // attempts (prevents retry storms from a bad generation).
                if PLAN_WRITE_TOOLS.contains(&tool_call.name.as_str()) {
                    if plan_writes >= MAX_PLAN_WRITES_PER_TURN {
                        let text = serde_json::to_string(&serde_json::json!({
                            "error": format!(
                                "Limiet planwijzigingen bereikt (max {} per beurt). Vat samen wat je hebt gedaan en vraag de gebruiker welke wijzigingen eerst moeten.",
                                MAX_PLAN_WRITES_PER_TURN
                            ),
                            "retryable": false,
                        }))
                        .unwrap_or_else(|_| "{}".to_string());
                        round_trace = Some(ToolCallTrace {
                            name: tool_call.name.clone(),
                            args: tool_call.arguments.clone(),
                            ok: false,
                            text: text.clone(),
                        });
                        dedupe.insert(key, (text.clone(), false));
                        if let Some(t) = round_trace.take() {
                            pending_trace.push(t);
                        }
                        current_messages.push(providers::AiMessage {
                            role: "tool".to_string(),
                            content: text,
                            tool_call_id: Some(tool_call.id.clone()),
                            name: Some(tool_call.name.clone()),
                            tool_calls: None,
                        });
                        continue;
                    }
                    plan_writes += 1;
                }
                let secs = if FILE_READ_TOOLS.contains(&tool_call.name.as_str()) {
                    FILE_READ_TIMEOUT_SECS
                } else {
                    TOOL_TIMEOUT_SECS
                };
                emit_activity(&app, "tool", Some(&tool_call.name), None);
                let is_schedule_tool = matches!(
                    tool_call.name.as_str(),
                    "get_ai_schedule"
                        | "create_ai_schedule_item"
                        | "update_ai_schedule_item"
                        | "complete_ai_schedule_item"
                        | "dismiss_ai_schedule_item"
                        | "delete_ai_schedule_item"
                        | "move_ai_schedule_item"
                        | "get_plan_settings"
                        | "get_free_slots"
                        | "undo_last_ai_plan_change"
                        | "set_homework_duration"
                        | "run_update_ai_schedule"
                );
                let exec = async {
                    if is_notes_tool(&tool_call.name) {
                        handle_notes_tool(
                            &tool_call.name,
                            &tool_call.arguments,
                            &notes_state,
                            config.ai_notes_ai_can_edit,
                            &app,
                        )
                        .await
                    } else if is_schedule_tool {
                        handle_schedule_tool(
                            &tool_call.name,
                            &tool_call.arguments,
                            &schedule_state,
                            &client,
                            person_id,
                            &plan_settings,
                            &app,
                        )
                        .await
                    } else {
                        let mut c = client.lock().await;
                        execute_tool(&mut c, &tool_call.name, &tool_call.arguments, person_id, &state.pending_actions).await
                    }
                };
                let tool_result = match tokio::time::timeout(std::time::Duration::from_secs(secs), exec).await
                {
                    Err(_) => tools::ToolResult {
                        tool: tool_call.name.clone(),
                        success: false,
                        data: serde_json::json!({
                            "error": format!("Time-out bij tool {} (>{}s)", tool_call.name, secs),
                            "retryable": true,
                        }),
                        error: Some(format!("Time-out bij tool {} (>{}s)", tool_call.name, secs)),
                    },
                    Ok(tr) => tr,
                };
                if !tool_result.success {
                    log::error!(
                        "AI tool '{}' failed. Arguments: {} Error: {}",
                        tool_call.name,
                        tool_call.arguments,
                        tool_result.error.as_deref().unwrap_or("Onbekende fout")
                    );
                    let text = match tool_result.data.get("error").and_then(|v| v.as_str()) {
                        Some(_) => serde_json::to_string(&tool_result.data)
                            .unwrap_or_else(|_| "{}".to_string()),
                        None => format!(
                            "Fout bij ophalen van data: {}",
                            tool_result.error.as_deref().unwrap_or("Onbekende fout")
                        ),
                    };
                    round_trace = Some(ToolCallTrace {
                        name: tool_call.name.clone(),
                        args: tool_call.arguments.clone(),
                        ok: false,
                        text: text.clone(),
                    });
                    dedupe.insert(key.clone(), (text.clone(), false));
                    text
                } else {
                    // Surface staged write actions to the frontend so it can render a
                    // confirm/cancel card for each one.
                    if tool_result.data.get("status").and_then(|v| v.as_str())
                        == Some("pending_user_confirmation")
                    {
                        staged_pending_actions.push(tool_result.data.clone());
                    }
                    if PLAN_WRITE_TOOLS.contains(&tool_call.name.as_str()) {
                        plan_changed = true;
                    }
                    let (payload, hit) = budget.account(&tool_result.data);
                    if hit {
                        budget_tripped = true;
                    }
                    let text = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
                    round_trace = Some(ToolCallTrace {
                        name: tool_call.name.clone(),
                        args: tool_call.arguments.clone(),
                        ok: true,
                        text: text.clone(),
                    });
                    dedupe.insert(key, (text.clone(), true));
                    text
                }
            };
            if let Some(t) = round_trace.take() {
                // Completed calls of this round join the persistence trace.
                pending_trace.push(t);
            }
            current_messages.push(providers::AiMessage {
                role: "tool".to_string(),
                content: result_content,
                tool_call_id: Some(tool_call.id.clone()),
                name: Some(tool_call.name.clone()),
                tool_calls: None,
            });
        }
        if !pending_trace.is_empty() {
            trace.push(TurnTrace {
                text: result.content.clone(),
                calls: std::mem::take(&mut pending_trace),
            });
        }
        if stopped {
            break;
        }

        round += 1;
    }

    if stopped {
        record_ai_diag(AiDiagEntry {
            ts: now_millis(),
            platform: "desktop".to_string(),
            provider: provider_id(&config.provider).to_string(),
            model: config.model.clone(),
            op: "tools".to_string(),
            status: "stopped".to_string(),
            duration_ms: diag_start.elapsed().as_millis() as u64,
            error_class: None,
            tool_names: diag_tools.clone(),
        });
        emit_activity(&app, "idle", None, None);
        return Ok(AiChatWithToolsResult {
            content: final_content,
            pending_actions: staged_pending_actions,
            stopped: true,
            plan_changed,
            trace,
        });
    }

    // Rounds exhausted with tools pending, or a budget trip after which the
    // model went quiet without answering: one final tools-disabled call with
    // a Dutch nudge instead of a canned fallback.
    let hit_limit = tool_calls_seen && rounds_used >= MAX_ROUNDS;
    let tripped_quiet = budget_tripped && final_content.is_empty();
    if tool_calls_seen && (hit_limit || tripped_quiet) && !cancelled() {
        let mut closing = current_messages.clone();
        closing.push(providers::AiMessage::simple("system", FINAL_NUDGE));
        emit_activity(&app, "answer", None, None);
        let mut on_attempt = |_attempt: u32| {
            emit_activity(&app, "answer", None, None);
        };
        let mut close_buf = String::new();
        let mut close_flush = std::time::Instant::now();
        let mut on_text = |delta: String| {
            close_buf.push_str(&delta);
            if close_buf.len() >= 1000 || close_flush.elapsed() >= std::time::Duration::from_millis(150) {
                let d = std::mem::take(&mut close_buf);
                emit_activity(&app, "text", None, Some(&d));
                close_flush = std::time::Instant::now();
            }
        };
        match chat_stream_with_retry(
            provider.as_ref(),
            &config,
            &closing,
            &[],
            &should_stop,
            &mut on_attempt,
            &mut on_text,
        )
        .await
        {
            Ok(r) if !r.content.is_empty() => final_content = r.content,
            Err(e) if final_content.is_empty() => {
                record_ai_diag(AiDiagEntry {
                    ts: now_millis(),
                    platform: "desktop".to_string(),
                    provider: provider_id(&config.provider).to_string(),
                    model: config.model.clone(),
                    op: "tools".to_string(),
                    status: "error".to_string(),
                    duration_ms: diag_start.elapsed().as_millis() as u64,
                    error_class: Some(diag_error_class(&e).to_string()),
                    tool_names: diag_tools.clone(),
                });
                return Err(e);
            }
            _ => {}
        }
        if !close_buf.is_empty() {
            let d = std::mem::take(&mut close_buf);
            emit_activity(&app, "text", None, Some(&d));
        }
    }

    if final_content.is_empty() {
        final_content = EMPTY_FALLBACK.to_string();
    }

    record_ai_diag(AiDiagEntry {
        ts: now_millis(),
        platform: "desktop".to_string(),
        provider: provider_id(&config.provider).to_string(),
        model: config.model.clone(),
        op: "tools".to_string(),
        status: "ok".to_string(),
        duration_ms: diag_start.elapsed().as_millis() as u64,
        error_class: None,
        tool_names: diag_tools,
    });
    emit_activity(&app, "idle", None, None);

    Ok(AiChatWithToolsResult {
        content: final_content,
        pending_actions: staged_pending_actions,
        stopped: false,
        plan_changed,
        trace,
    })
}

fn is_notes_tool(name: &str) -> bool {
    matches!(name, "read_notes" | "append_note" | "edit_note" | "replace_notes")
}

/// Parse frontend AI-Planning settings (camelCase from the shared Settings
/// store; snake_case also accepted). Unknown/missing fields fall back to
/// defaults per field.
fn parse_plan_settings(v: &Value) -> crate::ai::schedule::ScheduleSettings {
    use crate::ai::schedule::{BlockedTime, ScheduleSettings};
    let str_field = |snake: &str, camel: &str| {
        v.get(snake)
            .or_else(|| v.get(camel))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
    };
    let blocked_times = v
        .get("blocked_times")
        .or_else(|| v.get("blockedTimes"))
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| {
                    Some(BlockedTime {
                        day: b.get("day")?.as_str()?.to_string(),
                        start: b.get("start")?.as_str()?.to_string(),
                        end: b.get("end")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    ScheduleSettings {
        bedtime: str_field("bedtime", "bedtime").unwrap_or_else(|| "23:00".to_string()),
        wake_time: str_field("wake_time", "wakeTime").unwrap_or_else(|| "07:00".to_string()),
        blocked_times,
        after_school_buffer_min: v
            .get("after_school_buffer_min")
            .or_else(|| v.get("afterSchoolBufferMin"))
            .and_then(|x| x.as_u64())
            .unwrap_or(60) as u32,
        plan_in_school_gaps: v
            .get("plan_in_school_gaps")
            .or_else(|| v.get("planInSchoolGaps"))
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
    }
}

/// Overlap with a real lesson (cancelled lessons don't count).
fn lesson_overlap(
    lessons: &[crate::models::calendar::CalendarEvent],
    start: &str,
    end: &str,
) -> Option<String> {
    let s = crate::ai::schedule::iso_to_naive(start)?;
    let e = crate::ai::schedule::iso_to_naive(end)?;
    for ev in lessons {
        if ev.status == 4 || ev.status == 5 {
            continue;
        }
        if let (Some(ls), Some(le)) = (
            crate::ai::schedule::iso_to_naive(&ev.start),
            crate::ai::schedule::iso_to_naive(&ev.einde),
        ) {
            if ls < e && s < le {
                return Some(
                    ev.omschrijving
                        .clone()
                        .filter(|o| !o.trim().is_empty())
                        .unwrap_or_else(|| format!("les {}", ev.id)),
                );
            }
        }
    }
    None
}

fn slot_json(slot: &crate::ai::schedule::FreeSlot) -> Value {
    let minutes = (slot.end - slot.start).num_minutes().max(0);
    serde_json::json!({
        "start": crate::ai::schedule::naive_to_iso(slot.start),
        "end": crate::ai::schedule::naive_to_iso(slot.end),
        "minutes": minutes,
        "date": slot.start.format("%Y-%m-%d").to_string(),
    })
}

/// Nearest free slots for a day, for guardrail rejections and get_free_slots.
/// Lessons fetch is best-effort: on failure only AI items are subtracted and
/// the caller is told via `lessons_checked: false`.
async fn day_lessons(
    client: &State<'_, SharedClient>,
    person_id: i64,
    day: chrono::NaiveDate,
) -> (Vec<crate::models::calendar::CalendarEvent>, bool) {
    let day_str = day.format("%Y-%m-%d").to_string();
    match crate::commands::ai_schedule::fetch_magister_events_inner(
        (**client).clone(),
        person_id,
        &day_str,
        &day_str,
    )
    .await
    {
        Ok(lessons) => (lessons, true),
        Err(_) => (Vec::new(), false),
    }
}

async fn suggest_free_slots(
    schedule_state: &State<'_, crate::commands::ai_schedule::AiScheduleState>,
    lessons: &[crate::models::calendar::CalendarEvent],
    plan_settings: &crate::ai::schedule::ScheduleSettings,
    day: chrono::NaiveDate,
    min_minutes: i64,
    count: usize,
) -> Vec<Value> {
    let items = schedule_state.items.read().await;
    let locked = crate::commands::ai_schedule::locked_items_in_window(&items, day, day);
    drop(items);
    let slots = crate::ai::schedule::compute_free_slots(day, day, lessons, &locked, plan_settings);
    slots
        .iter()
        .filter(|s| (s.end - s.start).num_minutes() >= min_minutes)
        .take(count)
        .map(slot_json)
        .collect()
}

/// Record an AI plan mutation for undo (max 20, oldest dropped).
async fn push_undo(
    schedule_state: &State<'_, crate::commands::ai_schedule::AiScheduleState>,
    op: &str,
    item_id: String,
    before: Option<crate::models::ai_schedule::AiScheduleItem>,
    after: Option<crate::models::ai_schedule::AiScheduleItem>,
) {
    if let Ok(mut log) = schedule_state.undo.lock() {
        log.push(crate::commands::ai_schedule::UndoEntry {
            op: op.to_string(),
            item_id,
            before,
            after,
        });
        while log.len() > crate::commands::ai_schedule::UNDO_LIMIT {
            log.remove(0);
        }
    }
}

fn emit_schedule_changed(app: &AppHandle) {
    let _ = app.emit("ai-schedule-changed", serde_json::json!({ "source": "ai" }));
}

/// AI-Geheugen tools (plan item 4.4). Writes record `updated_by: "ai"` and
/// emit `ai-notes-changed` so open Settings views refresh live.
async fn handle_notes_tool(
    tool_name: &str,
    args: &Value,
    notes_state: &State<'_, crate::commands::ai_notes::AiNotesState>,
    writable: bool,
    app: &AppHandle,
) -> tools::ToolResult {
    use crate::commands::ai_notes as notes;
    if tool_name != "read_notes" && !writable {
        return tools::ToolResult {
            tool: tool_name.to_string(),
            success: false,
            data: Value::Null,
            error: Some(
                "Notities bewerken staat uit (Instellingen > AI). Alleen lezen is mogelijk.".to_string(),
            ),
        };
    }
    let outcome: Result<Value, String> = match tool_name {
        "read_notes" => Ok(notes::ai_read_notes(notes_state).await),
        "append_note" => {
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.trim().is_empty() {
                Err("Geen tekst opgegeven om te onthouden.".to_string())
            } else {
                let section = args
                    .get("section")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                notes::ai_append_note(notes_state, section, text.to_string()).await
            }
        }
        "edit_note" => {
            let old = args.get("old_text").and_then(|v| v.as_str()).unwrap_or("");
            let new = args.get("new_text").and_then(|v| v.as_str()).unwrap_or("");
            notes::ai_edit_note(notes_state, old.to_string(), new.to_string()).await
        }
        "replace_notes" => {
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            // Missing revision can never match: forces a read_notes first.
            let rev = args
                .get("expected_revision")
                .and_then(|v| v.as_u64())
                .unwrap_or(u64::MAX);
            notes::ai_replace_notes(notes_state, content.to_string(), rev).await
        }
        _ => Err(format!("Onbekende tool: {}", tool_name)),
    };
    match outcome {
        Ok(data) => {
            if let Some(rev) = data.get("revision").and_then(|v| v.as_u64()) {
                let _ = app.emit("ai-notes-changed", serde_json::json!({ "revision": rev }));
            }
            tools::ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data,
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

async fn handle_schedule_tool(
    tool_name: &str,
    args: &Value,
    schedule_state: &State<'_, crate::commands::ai_schedule::AiScheduleState>,
    client: &State<'_, SharedClient>,
    person_id: i64,
    plan_settings: &crate::ai::schedule::ScheduleSettings,
    app: &AppHandle,
) -> tools::ToolResult {
    match tool_name {
        "get_ai_schedule" => {
            // Omitted sides fall back to the 3-week default window (Phase 2);
            // spans over 62 days are clamped, like get_calendar_events.
            let start_arg = args.get("start").and_then(|v| v.as_str()).unwrap_or("");
            let end_arg = args.get("end").and_then(|v| v.as_str()).unwrap_or("");
            let start_arg = start_arg.get(0..10).unwrap_or(start_arg);
            let end_arg = end_arg.get(0..10).unwrap_or(end_arg);
            let offset = tools::int_arg(args, "offset", 0).max(0) as usize;
            let limit = tools::int_arg(args, "limit", tools::CALENDAR_DEFAULT_LIMIT as i64);
            let limit = (limit.max(1).min(tools::CALENDAR_MAX_LIMIT as i64)) as usize;
            let range = match tools::resolve_calendar_range(
                start_arg,
                end_arg,
                &crate::ai::time::today_amsterdam(),
            ) {
                Ok(r) => r,
                Err(e) => {
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(e),
                    }
                }
            };
            let s = crate::ai::schedule::iso_to_naive(&format!("{}T00:00:00", range.start));
            let e = crate::ai::schedule::iso_to_naive(&format!("{}T23:59:59", range.effective_end));
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
            let mut filtered: Vec<Value> = items
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
            filtered.sort_by(|a, b| {
                let sa = a.get("start").and_then(|v| v.as_str()).unwrap_or("");
                let sb = b.get("start").and_then(|v| v.as_str()).unwrap_or("");
                sa.cmp(sb)
            });
            let total = filtered.len();
            let (page, truncated, next_offset) = tools::paginate_slice(&filtered, offset, limit);
            tools::ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({
                    "items": page,
                    "count": page.len(),
                    "meta": {
                        "requested": { "start": range.start, "end": range.end },
                        "effective": { "start": range.start, "end": range.effective_end },
                        "clamped": range.clamped,
                        "returned": page.len(),
                        "total": total,
                        "truncated": truncated,
                        "next_offset": next_offset,
                        "window_default": { "start": range.window_start, "end": range.window_end },
                    }
                }),
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
            // Overlap guardrail with free-slot suggestions (background
            // free_time/sleep items are exempt from the AI-item check).
            let day = s.date();
            let check_ai_overlap = item.item_type != AiScheduleItemType::FreeTime
                && item.item_type != AiScheduleItemType::Sleep;
            let ai_conflict = if check_ai_overlap {
                let items = schedule_state.items.read().await;
                crate::commands::ai_schedule::find_overlap(&items, &item.start, &item.end, None)
            } else {
                None
            };
            let (lessons, lessons_checked) = day_lessons(&client, person_id, day).await;
            let lesson_conflict = lesson_overlap(&lessons, &item.start, &item.end);
            if ai_conflict.is_some() || lesson_conflict.is_some() {
                let suggestions =
                    suggest_free_slots(&schedule_state, &lessons, plan_settings, day, 0, 3).await;
                let (kind, what) = match (&ai_conflict, &lesson_conflict) {
                    (Some(id), _) => ("ai_item", id.clone()),
                    (_, Some(les)) => ("les", les.clone()),
                    _ => ("onbekend", String::new()),
                };
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: serde_json::json!({
                        "reason": format!("Overlap met {} '{}'.", kind, what),
                        "conflict_with": { "type": kind, "id": what },
                        "suggestions": suggestions,
                        "lessons_checked": lessons_checked,
                    }),
                    error: Some(format!("Overlap met {} '{}'. Kies een van de voorgestelde vrije plekken.", kind, what)),
                };
            }
            let mut items = schedule_state.items.write().await;
            items.push(item.clone());
            schedule_state.save(&items);
            push_undo(&schedule_state, "create_ai_schedule_item", item.id.clone(), None, Some(item.clone())).await;
            emit_schedule_changed(app);
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
            let before = match idx {
                Some(i) => items[i].clone(),
                None => {
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(format!("Item '{}' niet gevonden.", id)),
                    }
                }
            };
            drop(items);
            // Apply patch
            let mut item = before.clone();
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
            let (s, e) = match (
                crate::ai::schedule::iso_to_naive(&item.start),
                crate::ai::schedule::iso_to_naive(&item.end),
            ) {
                (Some(s), Some(e)) => (s, e),
                _ => {
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some("Ongeldige start/eind datum.".to_string()),
                    };
                }
            };
            if e <= s {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Eind moet na start liggen.".to_string()),
                };
            }
            // Overlap guardrail when the item stays plannable and its time
            // or type changed, with free-slot suggestions.
            let time_changed =
                item.start != before.start || item.end != before.end || item.item_type != before.item_type;
            let plannable = item.item_type != AiScheduleItemType::FreeTime
                && item.item_type != AiScheduleItemType::Sleep
                && item.status != AiScheduleStatus::Completed
                && item.status != AiScheduleStatus::Dismissed;
            if time_changed && plannable {
                let day = s.date();
                let ai_conflict = {
                    let items = schedule_state.items.read().await;
                    crate::commands::ai_schedule::find_overlap(&items, &item.start, &item.end, Some(&id))
                };
                let (lessons, lessons_checked) = day_lessons(&client, person_id, day).await;
                let lesson_conflict = lesson_overlap(&lessons, &item.start, &item.end);
                if ai_conflict.is_some() || lesson_conflict.is_some() {
                    let suggestions =
                        suggest_free_slots(&schedule_state, &lessons, plan_settings, day, 0, 3).await;
                    let (kind, what) = match (&ai_conflict, &lesson_conflict) {
                        (Some(cid), _) => ("ai_item", cid.clone()),
                        (_, Some(les)) => ("les", les.clone()),
                        _ => ("onbekend", String::new()),
                    };
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: serde_json::json!({
                            "reason": format!("Overlap met {} '{}'.", kind, what),
                            "conflict_with": { "type": kind, "id": what },
                            "suggestions": suggestions,
                            "lessons_checked": lessons_checked,
                        }),
                        error: Some(format!("Overlap met {} '{}'. Kies een van de voorgestelde vrije plekken.", kind, what)),
                    };
                }
            }
            // Apply under the write lock (re-check existence: lost races fail).
            {
                let mut items = schedule_state.items.write().await;
                match items.iter().position(|i| i.id == id) {
                    Some(idx) => items[idx] = item.clone(),
                    None => {
                        return tools::ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(format!("Item '{}' niet gevonden.", id)),
                        };
                    }
                }
                let snapshot = items.clone();
                schedule_state.save(&snapshot);
            }
            push_undo(&schedule_state, "update_ai_schedule_item", id.clone(), Some(before), Some(item.clone())).await;
            emit_schedule_changed(app);
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
                    let before = it.clone();
                    it.status = AiScheduleStatus::Completed;
                    let now = chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
                    it.completed_at = Some(now.clone());
                    it.updated_at = now;
                    let after = it.clone();
                    let snapshot = items.clone();
                    schedule_state.save(&snapshot);
                    drop(items);
                    push_undo(&schedule_state, "complete_ai_schedule_item", id.clone(), Some(before), Some(after)).await;
                    emit_schedule_changed(app);
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
                    let before = it.clone();
                    it.status = AiScheduleStatus::Dismissed;
                    it.updated_at = chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
                    let after = it.clone();
                    let snapshot = items.clone();
                    schedule_state.save(&snapshot);
                    drop(items);
                    push_undo(&schedule_state, "dismiss_ai_schedule_item", id.clone(), Some(before), Some(after)).await;
                    emit_schedule_changed(app);
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
                let before = item.clone();
                item.estimated_minutes = Some(estimated_minutes);
                item.duration_source = Some(DurationSource::UserEntered);
                if let Some(u) = urgency {
                    item.urgency = u;
                }
                item.updated_at = now.clone();
                let cloned = item.clone();
                let snapshot = items.clone();
                schedule_state.save(&snapshot);
                drop(items);
                push_undo(&schedule_state, "set_homework_duration", cloned.id.clone(), Some(before), Some(cloned.clone())).await;
                emit_schedule_changed(app);
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
            drop(items);
            push_undo(&schedule_state, "set_homework_duration", new_item.id.clone(), None, Some(new_item.clone())).await;
            emit_schedule_changed(app);
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
            // Respect the frontend AI-Planning settings (threaded through the
            // chat call) instead of silently using defaults.
            let settings = plan_settings.clone();
            match crate::commands::ai_schedule::perform_update_inner(schedule_state, client_clone, person_id, settings).await {
                Ok(updated) => {
                    let vals: Vec<Value> = updated.iter().map(|i| serde_json::to_value(i).unwrap_or(Value::Null)).collect();
                    // Bound the prompt payload: the full replan can be long.
                    let total = vals.len();
                    let (page, truncated, _) = tools::paginate_slice(&vals, 0, tools::CALENDAR_DEFAULT_LIMIT);
                    emit_schedule_changed(app);
                    tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({
                            "items": page,
                            "count": page.len(),
                            "total": total,
                            "truncated": truncated,
                            "message": "Planning bijgewerkt voor deze week + volgende week."
                        }),
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
        "delete_ai_schedule_item" => {
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
            match idx {
                Some(i) => {
                    let before = items.remove(i);
                    let snapshot = items.clone();
                    schedule_state.save(&snapshot);
                    drop(items);
                    push_undo(&schedule_state, "delete_ai_schedule_item", id.clone(), Some(before), None).await;
                    emit_schedule_changed(app);
                    tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "id": id, "status": "deleted" }),
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
        "move_ai_schedule_item" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let new_start = args.get("new_start").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if id.is_empty() || new_start.is_empty() {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("ID en new_start zijn verplicht.".to_string()),
                };
            }
            let before = {
                let items = schedule_state.items.read().await;
                match items.iter().find(|i| i.id == id) {
                    Some(it) => it.clone(),
                    None => {
                        return tools::ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(format!("Item '{}' niet gevonden.", id)),
                        };
                    }
                }
            };
            // Keep the duration, move the start.
            let (old_s, old_e) = match (
                crate::ai::schedule::iso_to_naive(&before.start),
                crate::ai::schedule::iso_to_naive(&before.end),
            ) {
                (Some(s), Some(e)) => (s, e),
                _ => {
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some("Item heeft een ongeldige start/eind datum.".to_string()),
                    };
                }
            };
            let duration = old_e - old_s;
            if duration.num_seconds() <= 0 {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Item heeft geen positieve duur.".to_string()),
                };
            }
            let new_s = match crate::ai::schedule::iso_to_naive(&new_start) {
                Some(s) => s,
                None => {
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some("Ongeldige new_start (verwacht ISO 8601).".to_string()),
                    };
                }
            };
            let new_e = new_s + duration;
            let new_start_str = crate::ai::schedule::naive_to_iso(new_s);
            let new_end_str = crate::ai::schedule::naive_to_iso(new_e);
            // Overlap guardrail with free-slot suggestions.
            let day = new_s.date();
            let ai_conflict = {
                let items = schedule_state.items.read().await;
                crate::commands::ai_schedule::find_overlap(&items, &new_start_str, &new_end_str, Some(&id))
            };
            let (lessons, lessons_checked) = day_lessons(&client, person_id, day).await;
            let lesson_conflict = lesson_overlap(&lessons, &new_start_str, &new_end_str);
            if ai_conflict.is_some() || lesson_conflict.is_some() {
                let suggestions =
                    suggest_free_slots(&schedule_state, &lessons, plan_settings, day, 0, 3).await;
                let (kind, what) = match (&ai_conflict, &lesson_conflict) {
                    (Some(cid), _) => ("ai_item", cid.clone()),
                    (_, Some(les)) => ("les", les.clone()),
                    _ => ("onbekend", String::new()),
                };
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: serde_json::json!({
                        "reason": format!("Overlap met {} '{}'.", kind, what),
                        "conflict_with": { "type": kind, "id": what },
                        "suggestions": suggestions,
                        "lessons_checked": lessons_checked,
                    }),
                    error: Some(format!("Overlap met {} '{}'. Kies een van de voorgestelde vrije plekken.", kind, what)),
                };
            }
            let mut item = before.clone();
            item.start = new_start_str;
            item.end = new_end_str;
            item.updated_at = chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
            {
                let mut items = schedule_state.items.write().await;
                match items.iter().position(|i| i.id == id) {
                    Some(idx) => items[idx] = item.clone(),
                    None => {
                        return tools::ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(format!("Item '{}' niet gevonden.", id)),
                        };
                    }
                }
                let snapshot = items.clone();
                schedule_state.save(&snapshot);
            }
            push_undo(&schedule_state, "move_ai_schedule_item", id.clone(), Some(before), Some(item.clone())).await;
            emit_schedule_changed(app);
            tools::ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::to_value(&item).unwrap_or(Value::Null),
                error: None,
            }
        }
        "get_plan_settings" => tools::ToolResult {
            tool: tool_name.to_string(),
            success: true,
            data: serde_json::json!({
                "bedtime": plan_settings.bedtime,
                "wake_time": plan_settings.wake_time,
                "blocked_times": plan_settings.blocked_times.iter().map(|b| serde_json::json!({
                    "day": b.day, "start": b.start, "end": b.end
                })).collect::<Vec<_>>(),
                "after_school_buffer_min": plan_settings.after_school_buffer_min,
                "plan_in_school_gaps": plan_settings.plan_in_school_gaps,
            }),
            error: None,
        },
        "get_free_slots" => {
            let date_arg = args.get("date").and_then(|v| v.as_str()).unwrap_or("");
            let end_arg = args.get("end").and_then(|v| v.as_str()).unwrap_or("");
            let min_minutes = args.get("min_minutes").and_then(|v| v.as_i64()).unwrap_or(0).max(0);
            let start_day = match chrono::NaiveDate::parse_from_str(date_arg.get(0..10).unwrap_or(date_arg), "%Y-%m-%d") {
                Ok(d) => d,
                Err(_) => {
                    return tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(format!("Ongeldige datum '{}' (verwacht yyyy-MM-dd).", date_arg)),
                    };
                }
            };
            let end_day = if end_arg.is_empty() {
                start_day
            } else {
                match chrono::NaiveDate::parse_from_str(end_arg.get(0..10).unwrap_or(end_arg), "%Y-%m-%d") {
                    Ok(d) => d,
                    Err(_) => {
                        return tools::ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(format!("Ongeldige einddatum '{}' (verwacht yyyy-MM-dd).", end_arg)),
                        };
                    }
                }
            };
            if end_day < start_day {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Einddatum ligt voor startdatum. Wissel ze om.".to_string()),
                };
            }
            if (end_day - start_day).num_days() > tools::CALENDAR_MAX_SPAN_DAYS {
                return tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(format!(
                        "Bereik te groot (max {} dagen). Vernauw het bereik.",
                        tools::CALENDAR_MAX_SPAN_DAYS
                    )),
                };
            }
            let start_str = start_day.format("%Y-%m-%d").to_string();
            let end_str = end_day.format("%Y-%m-%d").to_string();
            let lessons = crate::commands::ai_schedule::fetch_magister_events_inner(
                (**client).clone(),
                person_id,
                &start_str,
                &end_str,
            )
            .await;
            let lessons_checked = lessons.is_ok();
            let lessons = lessons.unwrap_or_default();
            let items = schedule_state.items.read().await;
            let locked = crate::commands::ai_schedule::locked_items_in_window(&items, start_day, end_day);
            drop(items);
            let slots =
                crate::ai::schedule::compute_free_slots(start_day, end_day, &lessons, &locked, plan_settings);
            let all: Vec<Value> = slots
                .iter()
                .filter(|s| (s.end - s.start).num_minutes() >= min_minutes)
                .map(slot_json)
                .collect();
            let total = all.len();
            let shown: Vec<Value> = all.into_iter().take(60).collect();
            let truncated = total > shown.len();
            tools::ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({
                    "slots": shown,
                    "count": shown.len(),
                    "total": total,
                    "truncated": truncated,
                    "lessons_checked": lessons_checked,
                }),
                error: None,
            }
        }
        "undo_last_ai_plan_change" => {
            let entry = match schedule_state.undo.lock() {
                Ok(mut log) => log.pop(),
                Err(_) => None,
            };
            match entry {
                None => tools::ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Niets om ongedaan te maken.".to_string()),
                },
                Some(e) => {
                    let mut items = schedule_state.items.write().await;
                    if e.before.is_none() && e.after.is_some() {
                        // Was created: remove again.
                        items.retain(|i| i.id != e.item_id);
                    } else if let Some(before) = &e.before {
                        // Was deleted or modified: restore (re-insert if gone).
                        match items.iter().position(|i| i.id == e.item_id) {
                            Some(idx) => items[idx] = before.clone(),
                            None => items.push(before.clone()),
                        }
                    }
                    let snapshot = items.clone();
                    schedule_state.save(&snapshot);
                    drop(items);
                    emit_schedule_changed(app);
                    tools::ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({
                            "undone": { "op": e.op, "item_id": e.item_id },
                            "item": e.before.map(|b| serde_json::to_value(&b).unwrap_or(Value::Null)),
                        }),
                        error: None,
                    }
                }
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
    let system_prompt = crate::ai_client::build_school_context_system_prompt(
        Some(&page_context),
        None,
        None,
    );

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contains_status_needs_standalone_numbers() {
        assert!(contains_status("HTTP 503 Service Unavailable", "503"));
        assert!(contains_status("status: 429", "429"));
        assert!(!contains_status("lesson 1503 done", "503"));
        assert!(!contains_status("id 14290", "429"));
        assert!(!contains_status("all good", "503"));
    }

    #[test]
    fn retry_policy_matches_ts_taxonomy() {
        // Retryable: transient network + 408/429/502/503/504.
        for msg in [
            "HTTP 429 Too Many Requests",
            "request failed with HTTP 503",
            "HTTP 502 Bad Gateway",
            "HTTP 504",
            "HTTP 408 Request Timeout",
            "error sending request: connection closed",
            "operation timed out",
            "dns error: no such host",
        ] {
            assert!(provider_error_retryable(msg), "should retry: {}", msg);
        }
        // Fatal: auth, model, bad request.
        for msg in [
            "HTTP 401 Unauthorized",
            "HTTP 403 Forbidden",
            "HTTP 404 model not found: gpt-9",
            "HTTP 400 Bad request",
            "invalid_api_key: check your key",
            "model_not_found",
        ] {
            assert!(!provider_error_retryable(msg), "must not retry: {}", msg);
        }
    }

    #[test]
    fn overflow_detection() {
        assert!(is_context_overflow("This model's maximum context length is 128000 tokens"));
        assert!(is_context_overflow("context_length_exceeded"));
        assert!(!is_context_overflow("HTTP 503 Service Unavailable"));
        assert!(!is_context_overflow("all good"));
    }

    #[test]
    fn dedupe_key_ignores_key_order() {
        let a = serde_json::json!({"start": "2026-09-21", "end": "2026-09-27"});
        let b = serde_json::json!({"end": "2026-09-27", "start": "2026-09-21"});
        assert_eq!(dedupe_key("get_calendar_events", &a), dedupe_key("get_calendar_events", &b));
        assert_ne!(
            dedupe_key("get_calendar_events", &a),
            dedupe_key("get_calendar_events", &serde_json::json!({"start": "2026-09-22"}))
        );
        assert_ne!(
            dedupe_key("a", &a),
            dedupe_key("b", &a)
        );
    }

    #[test]
    fn trim_history_keeps_system_plus_tail() {
        let mut msgs: Vec<providers::AiMessage> = vec![providers::AiMessage::simple("system", "s")];
        for i in 0..10 {
            msgs.push(providers::AiMessage::simple("user", format!("old {}", i)));
        }
        trim_history(&mut msgs);
        assert_eq!(msgs.len(), 5);
        assert_eq!(msgs[0].content, "s");
        assert_eq!(msgs[4].content, "old 9");
    }

    struct ScriptProvider {
        calls: Mutex<usize>,
        fail_first: usize,
        fail_with: String,
    }

    #[async_trait::async_trait]
    impl providers::AiProvider for ScriptProvider {
        async fn chat(
            &self,
            _config: &AiConfig,
            _messages: &[providers::AiMessage],
            _tools: &[tools::ToolDef],
        ) -> Result<providers::AiChatResult, String> {
            let mut c = self.calls.lock().unwrap();
            *c += 1;
            if *c <= self.fail_first {
                return Err(self.fail_with.clone());
            }
            Ok(providers::AiChatResult {
                content: "ok".to_string(),
                tool_calls: vec![],
            })
        }

        async fn validate_key(&self, _config: &AiConfig) -> Result<bool, String> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn retry_429_then_success() {
        let provider = ScriptProvider {
            calls: Mutex::new(0),
            fail_first: 1,
            fail_with: "HTTP 429 Too Many Requests".to_string(),
        };
        let config = AiConfig::default();
        let out = chat_with_retry(&provider, &config, &[], &[]).await;
        assert!(out.is_ok());
        assert_eq!(*provider.calls.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn no_retry_on_401() {
        let provider = ScriptProvider {
            calls: Mutex::new(0),
            fail_first: 99,
            fail_with: "HTTP 401 Unauthorized".to_string(),
        };
        let config = AiConfig::default();
        let out = chat_with_retry(&provider, &config, &[], &[]).await;
        assert!(out.is_err());
        assert_eq!(*provider.calls.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn gives_up_after_3_attempts() {
        let provider = ScriptProvider {
            calls: Mutex::new(0),
            fail_first: 99,
            fail_with: "HTTP 503 Service Unavailable".to_string(),
        };
        let config = AiConfig::default();
        let out = chat_with_retry(&provider, &config, &[], &[]).await;
        assert!(out.is_err());
        assert_eq!(*provider.calls.lock().unwrap(), 3);
    }

    #[test]
    fn schedule_defs_cover_all_plan_tools() {
        let defs = tools::get_all_tool_defs();
        let names: Vec<&str> = defs.iter().map(|t| t.name.as_str()).collect();
        for needed in [
            "get_ai_schedule",
            "create_ai_schedule_item",
            "update_ai_schedule_item",
            "complete_ai_schedule_item",
            "dismiss_ai_schedule_item",
            "delete_ai_schedule_item",
            "move_ai_schedule_item",
            "get_plan_settings",
            "get_free_slots",
            "undo_last_ai_plan_change",
            "set_homework_duration",
            "run_update_ai_schedule",
        ] {
            assert!(names.contains(&needed), "missing tool def: {}", needed);
        }
    }

    #[test]
    fn parse_plan_settings_accepts_both_cases() {
        let camel = serde_json::json!({
            "bedtime": "22:30",
            "wakeTime": "06:30",
            "blockedTimes": [{ "day": "monday", "start": "18:00", "end": "19:00" }],
            "afterSchoolBufferMin": 45,
            "planInSchoolGaps": true,
        });
        let s = parse_plan_settings(&camel);
        assert_eq!(s.bedtime, "22:30");
        assert_eq!(s.wake_time, "06:30");
        assert_eq!(s.blocked_times.len(), 1);
        assert_eq!(s.after_school_buffer_min, 45);
        assert!(s.plan_in_school_gaps);
        let snake = serde_json::json!({ "wake_time": "08:00" });
        let s2 = parse_plan_settings(&snake);
        assert_eq!(s2.wake_time, "08:00");
        assert_eq!(s2.bedtime, "23:00");
        let empty = parse_plan_settings(&serde_json::json!({}));
        let def = crate::ai::schedule::ScheduleSettings::default();
        assert_eq!(empty.bedtime, def.bedtime);
        assert_eq!(empty.wake_time, def.wake_time);
        assert_eq!(empty.after_school_buffer_min, def.after_school_buffer_min);
        assert_eq!(empty.plan_in_school_gaps, def.plan_in_school_gaps);
    }

    #[test]
    fn lesson_overlap_skips_cancelled() {
        let mk = |status: i32, start: &str, einde: &str| {
            serde_json::from_value::<crate::models::calendar::CalendarEvent>(serde_json::json!({
                "Id": 1,
                "Start": start,
                "Einde": einde,
                "Status": status,
                "Omschrijving": "Wiskunde",
                "Type": 0,
                "InfoType": 0,
                "Afgerond": false,
                "DuurtHeleDag": false,
                "HeeftBijlagen": false,
            }))
            .expect("fixture parses")
        };
        let lessons = vec![mk(1, "2026-09-21T08:30:00", "2026-09-21T09:20:00")];
        assert_eq!(
            lesson_overlap(&lessons, "2026-09-21T08:45:00", "2026-09-21T09:30:00"),
            Some("Wiskunde".to_string())
        );
        assert_eq!(lesson_overlap(&lessons, "2026-09-21T10:00:00", "2026-09-21T11:00:00"), None);
        let cancelled = vec![mk(4, "2026-09-21T08:30:00", "2026-09-21T09:20:00")];
        assert_eq!(lesson_overlap(&cancelled, "2026-09-21T08:45:00", "2026-09-21T09:30:00"), None);
    }

    #[test]
    fn diag_error_classes_match_taxonomy() {
        assert_eq!(diag_error_class("HTTP 401 Unauthorized"), "invalid_key");
        assert_eq!(diag_error_class("HTTP 404 model not found"), "model_not_found");
        assert_eq!(diag_error_class("HTTP 429 slow down"), "rate_limited");
        assert_eq!(
            diag_error_class("maximum context length exceeded"),
            "context_too_long"
        );
        assert_eq!(diag_error_class("something bizarre"), "unknown");
    }

    #[test]
    fn diag_buffer_caps_at_fifty() {
        {
            let mut buf = AI_DIAGNOSTICS.lock().unwrap();
            buf.clear();
        }
        for i in 0..60 {
            record_ai_diag(AiDiagEntry {
                ts: i,
                platform: "desktop".to_string(),
                provider: "openai".to_string(),
                model: "m".to_string(),
                op: "chat".to_string(),
                status: "ok".to_string(),
                duration_ms: 1,
                error_class: None,
                tool_names: vec![],
            });
        }
        let listed = get_ai_diagnostics();
        assert_eq!(listed.len(), DIAG_LIMIT);
        assert_eq!(listed[0].ts, 59);
        assert!(clear_ai_diagnostics().is_ok());
        assert!(get_ai_diagnostics().is_empty());
    }
}
