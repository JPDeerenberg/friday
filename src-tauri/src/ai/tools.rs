use rand::RngExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Definition of a tool that the AI can call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value, // JSON Schema for parameters
}

impl ToolDef {
    /// OpenAI-compatible tool definition format.
    pub fn to_openai_tool(&self) -> Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            }
        })
    }

    /// Anthropic-compatible tool definition format.
    pub fn to_anthropic_tool(&self) -> Value {
        serde_json::json!({
            "name": self.name,
            "description": self.description,
            "input_schema": self.parameters,
        })
    }
}

/// Phase 2 data budget: max agenda span per `get_calendar_events` call
/// (clamped, never an error).
pub const CALENDAR_MAX_SPAN_DAYS: i64 = 62;
/// Default page size for range tools.
pub const CALENDAR_DEFAULT_LIMIT: usize = 60;
/// Hard cap per page.
pub const CALENDAR_MAX_LIMIT: usize = 200;

/// Resolved fetch range for `get_calendar_events`. Mirrors TS `CalendarRange`.
pub struct CalendarRange {
    pub start: String,
    pub end: String,
    pub effective_end: String,
    pub clamped: bool,
    pub window_start: String,
    pub window_end: String,
}

/// Resolve a (possibly partial) model-supplied range to the effective fetch
/// range. Omitted sides fall back to the 3-week default window; spans over 62
/// days are clamped, never rejected. Mirrors TS `resolveCalendarRange`.
pub fn resolve_calendar_range(start_arg: &str, end_arg: &str, today: &str) -> Result<CalendarRange, String> {
    let win = crate::ai::time::context_window(today);
    let start = if start_arg.is_empty() { win.start.clone() } else { start_arg.to_string() };
    let end = if end_arg.is_empty() { win.end.clone() } else { end_arg.to_string() };
    if !crate::ai::time::is_valid_date_str(&start) || !crate::ai::time::is_valid_date_str(&end) {
        return Err(format!(
            "Ongeldige datum (verwacht yyyy-MM-dd): '{}' t/m '{}'. Vraag get_current_time om 'vandaag'.",
            start_arg, end_arg
        ));
    }
    let span = crate::ai::time::diff_days_opt(&start, &end).unwrap_or(0);
    if span < 0 {
        return Err(format!("Einddatum {} ligt voor startdatum {}. Wissel ze om.", end, start));
    }
    let (effective_end, clamped) = if span > CALENDAR_MAX_SPAN_DAYS {
        (crate::ai::time::add_days(&start, CALENDAR_MAX_SPAN_DAYS), true)
    } else {
        (end.clone(), false)
    };
    Ok(CalendarRange {
        start,
        end,
        effective_end,
        clamped,
        window_start: win.start,
        window_end: win.end,
    })
}

/// Paginate a slice without consuming it. Returns (page, truncated, next_offset).
pub fn paginate_slice(items: &[Value], offset: usize, limit: usize) -> (Vec<Value>, bool, Option<usize>) {
    let limit = limit.clamp(1, CALENDAR_MAX_LIMIT);
    let page: Vec<Value> = items.iter().skip(offset).take(limit).cloned().collect();
    let truncated = offset + limit < items.len();
    let next_offset = if truncated { Some(offset + limit) } else { None };
    (page, truncated, next_offset)
}

pub fn int_arg(args: &Value, key: &str, fallback: i64) -> i64 {
    args.get(key)
        .and_then(|v| v.as_f64())
        .map(|f| f.trunc() as i64)
        .unwrap_or(fallback)
}

/// Cut to 120 chars on a char boundary (never splits UTF-8).
fn cut_120(s: &str) -> String {
    if s.chars().count() <= 120 {
        return s.to_string();
    }
    let mut out: String = s.chars().take(120).collect();
    out.push('…');
    out
}

fn insert_if_present(map: &mut serde_json::Map<String, Value>, key: &str, v: Value) {
    if v.is_null() {
        return;
    }
    if let Some(s) = v.as_str() {
        if s.is_empty() {
            return;
        }
    }
    map.insert(key.to_string(), v);
}

/// Slim one raw afspraak to the compact model shape. Nulls/empties are
/// dropped; teacher names stay redacted; the long homework text (`Inhoud`)
/// lives behind `get_calendar_event_detail`. Mirrors TS `slimCalendarEvent`.
pub fn slim_calendar_item(item: &Value) -> Value {
    let mut out = serde_json::Map::new();
    insert_if_present(&mut out, "id", item.get("Id").cloned().unwrap_or(Value::Null));
    let start = item.get("Start").and_then(|v| v.as_str()).unwrap_or("");
    let einde = item.get("Einde").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(date) = start.get(0..10) {
        if crate::ai::time::is_valid_date_str(date) {
            out.insert("date".to_string(), Value::String(date.to_string()));
        }
    }
    insert_if_present(&mut out, "start", Value::String(start.to_string()));
    insert_if_present(&mut out, "end", Value::String(einde.to_string()));
    let vak = item
        .get("Vakken")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.get("Naam"))
        .cloned()
        .unwrap_or(Value::Null);
    insert_if_present(&mut out, "vak", vak);
    if let Some(first) = item.get("Docenten").and_then(|v| v.as_array()).and_then(|a| a.first()) {
        let naam = redact_docent(first).get("naam").cloned().unwrap_or(Value::Null);
        insert_if_present(&mut out, "docent", naam);
    }
    let lokaal = item
        .get("Lokalen")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.get("Naam"))
        .cloned()
        .unwrap_or(Value::Null);
    insert_if_present(&mut out, "lokaal", lokaal);
    let omschrijving = item.get("Omschrijving").and_then(|v| v.as_str()).unwrap_or("");
    if !omschrijving.trim().is_empty() {
        out.insert("omschrijving".to_string(), Value::String(cut_120(omschrijving)));
    }
    let inhoud = item.get("Inhoud").and_then(|v| v.as_str()).unwrap_or("");
    out.insert("huiswerk".to_string(), Value::Bool(!inhoud.trim().is_empty()));
    insert_if_present(&mut out, "type", item.get("Type").cloned().unwrap_or(Value::Null));
    insert_if_present(&mut out, "afgerond", item.get("Afgerond").cloned().unwrap_or(Value::Null));
    // InfoType 2-5 = upcoming tests/exams (Proefwerk, Tentamen, schriftelijk/
    // mondeling overhoring); surfaced for planning.
    let is_test = matches!(
        item.get("InfoType").and_then(|v| v.as_i64()),
        Some(2) | Some(3) | Some(4) | Some(5)
    );
    out.insert("is_test".to_string(), Value::Bool(is_test));
    insert_if_present(&mut out, "aantekening", item.get("Aantekening").cloned().unwrap_or(Value::Null));
    Value::Object(out)
}

/// AI-Geheugen write tools (never offered when editing is disabled).
pub const NOTES_WRITE_TOOLS: &[&str] = &["append_note", "edit_note", "replace_notes"];
/// All AI-Geheugen tools (gated by the use-in-chats setting).
pub const NOTES_TOOLS: &[&str] = &["read_notes", "append_note", "edit_note", "replace_notes"];

/// All available tools the AI can use.
pub fn get_all_tool_defs() -> Vec<ToolDef> {
    // Single source of truth: shared/ai-spec/tools.json (see crate::ai::spec).
    // The desktop side cannot drift by construction; the web twin is pinned
    // by src/lib/ai-parity.test.ts.
    crate::ai::spec::tool_specs()
        .iter()
        .map(|t| ToolDef {
            name: t.name.clone(),
            description: t.description.clone(),
            parameters: t.parameters.clone(),
        })
        .collect()
}

/// Result of executing a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool: String,
    pub success: bool,
    pub data: Value,
    pub error: Option<String>,
}

/// A side-effecting action the AI wants to perform, staged until the user
/// explicitly confirms it via `confirm_pending_action`. Write tools never
/// execute directly — they store a `PendingAction` and return a
/// "pending_user_confirmation" payload through the normal tool-result channel.
#[derive(Debug, Clone)]
pub struct PendingAction {
    /// Tool name that staged the action ("send_message", "mark_messages_read", ...).
    pub action_type: String,
    /// Original tool arguments, replayed verbatim when the action is confirmed.
    pub args: Value,
    /// Unix timestamp (seconds) of when the action was staged, for expiry.
    pub created_at: u64,
}

/// In-memory store of pending actions awaiting user confirmation.
pub type PendingActionStore = Mutex<HashMap<String, PendingAction>>;

/// How long a pending action stays confirmable before it expires. A stale
/// "confirm" button from an old conversation can never fire after this window.
pub const PENDING_ACTION_TTL_SECS: u64 = 15 * 60;

/// Generate a unique id for a pending action.
pub fn generate_action_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let random: u64 = rand::rng().random();
    format!("act-{:016x}-{:016x}", nanos, random)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Privacy: redact a single Docent JSON object to only expose code or last-name.
/// Replaces the full display name with the existing `Docentcode` (short internal
/// code Magister already exposes). Falls back to last-name-only if no code is
/// present. The regular (non-AI) UI is unaffected — this only changes what goes
/// to the model.
fn redact_docent(v: &Value) -> Value {
    let code = v
        .get("Docentcode")
        .and_then(|c| c.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let naam = v.get("Naam").and_then(|c| c.as_str()).unwrap_or("").trim();
    let redacted_naam = if let Some(ref c) = code {
        c.clone()
    } else if !naam.is_empty() {
        // fallback: last whitespace token, stripped of parentheses/commas
        let last = naam.split_whitespace().last().unwrap_or(naam);
        let before_comma = last.split(',').next().unwrap_or(last);
        before_comma
            .trim_matches(|c| c == '(' || c == ')' || c == ',')
            .to_string()
    } else {
        String::new()
    };
    let id = v.get("Id").cloned().unwrap_or(Value::Null);
    match code {
        Some(c) => serde_json::json!({ "id": id, "code": c, "naam": redacted_naam }),
        None => serde_json::json!({ "id": id, "naam": redacted_naam }),
    }
}

fn redact_docenten_array(arr: Option<&Vec<Value>>) -> Value {
    match arr {
        Some(vec) => Value::Array(vec.iter().map(redact_docent).collect()),
        None => Value::Array(vec![]),
    }
}

/// Privacy: redact a plain teacher-name string (e.g. Grade `Docent` field)
/// to code (if parenthesised) or last-name-only.
fn redact_teacher_name_str(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Try extract code in parentheses like "Jansen (JNS)" -> use code
    if let Some(start) = trimmed.rfind('(') {
        if let Some(end) = trimmed.rfind(')') {
            if end > start + 1 {
                let code = trimmed[start + 1..end].trim();
                if !code.is_empty()
                    && code.len() <= 10
                    && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                {
                    return code.to_string();
                }
            }
        }
    }
    // Fallback last token
    trimmed
        .split_whitespace()
        .last()
        .unwrap_or(trimmed)
        .trim_matches(|c| c == '(' || c == ')' || c == ',')
        .to_string()
}

/// Compute (totalPoints, totalWeight, gradeCount) from a vak node of the
/// `cijferoverzichtvooraanmelding` response, using the same filter rules as
/// `getSubjects()` in `src/routes/grades/Grades.svelte`: only grades with a
/// CijferStr, that count (`TeltMee`), with a parseable value.
fn subject_totals_from_overview(vak: &Value) -> (f64, f64, usize) {
    let mut tp = 0.0;
    let mut tw = 0.0;
    let mut count = 0usize;
    if let Some(cijfers) = vak.get("Cijfers").and_then(|c| c.as_array()) {
        for c in cijfers {
            let str = c.get("CijferStr").and_then(|v| v.as_str()).unwrap_or("");
            if str.is_empty() {
                continue;
            }
            let telt_mee = c.get("TeltMee").and_then(|v| v.as_bool()).unwrap_or(true);
            if !telt_mee {
                continue;
            }
            let Some(val) = crate::ai::grade_calc::parse_dutch_grade(str) else {
                continue;
            };
            let w = c.get("Weging").and_then(|v| v.as_f64()).unwrap_or(1.0);
            tp += val * w;
            tw += w;
            count += 1;
        }
    }
    (tp, tw, count)
}

/// Resolve a subject's current grade totals for `calculate_grade_scenario`:
/// either from an explicit `grades` array in `args`, or by fetching the grade
/// overview for a schoolyear and matching the subject name/abbreviation.
/// Returns (total_points, total_weight, grade_count, subject_name,
/// all_subjects_averages).
async fn resolve_scenario_grades(
    client: &mut crate::client::MagisterClient,
    args: &Value,
    person_id: i64,
    peildatum: &str,
) -> Result<(f64, f64, usize, String, Vec<(String, f64)>), String> {
    use crate::ai::grade_calc::{weighted_sum, GradePoint};

    let mut subject_name = args
        .get("subject")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if let Some(grades_arr) = args.get("grades").and_then(|v| v.as_array()) {
        let points: Vec<GradePoint> = grades_arr
            .iter()
            .filter_map(|g| {
                // Accept both {value, weight} and the shape get_full_grade_overview
                // returns ({cijfer, weging}) so the model can pass data through as-is.
                let value = g
                    .get("value")
                    .and_then(|v| v.as_f64())
                    .or_else(|| g.get("cijfer").and_then(|v| v.as_f64()))
                    .or_else(|| {
                        g.get("cijfer")
                            .and_then(|v| v.as_str())
                            .and_then(crate::ai::grade_calc::parse_dutch_grade)
                    })?;
                let weight = g
                    .get("weight")
                    .and_then(|v| v.as_f64())
                    .or_else(|| g.get("weging").and_then(|v| v.as_f64()))
                    .unwrap_or(1.0);
                Some(GradePoint { value, weight })
            })
            .collect();
        let (tp, tw) = weighted_sum(&points);
        return Ok((tp, tw, points.len(), subject_name, Vec::new()));
    }

    let schoolyear_id = args.get("schoolyear_id").and_then(|v| v.as_i64()).unwrap_or(0);
    let subject_query = subject_name.trim().to_lowercase();
    if schoolyear_id == 0 || subject_query.is_empty() {
        return Err(
            "Geef `grades` (lijst van {value, weight}) óf `schoolyear_id` + `subject` op."
                .to_string(),
        );
    }

    let path = format!(
        "personen/{}/aanmeldingen/{}/cijfers/cijferoverzichtvooraanmelding?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum={}",
        person_id, schoolyear_id, peildatum
    );

    let data = client.get(&path).await.map_err(|e| e.to_string())?;

    let vakken = data
        .get("CijferVakken")
        .or_else(|| data.get("CijferOverzicht").and_then(|co| co.get("CijferVakken")))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let found = vakken.iter().find(|vak| {
        let name = vak
            .get("Vak")
            .and_then(|v| v.get("Omschrijving"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        let abbr = vak
            .get("Vak")
            .and_then(|v| v.get("Afkorting"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        name == subject_query
            || abbr == subject_query
            || (!name.is_empty() && name.contains(&subject_query))
            || (!subject_query.is_empty() && subject_query.contains(&name))
    });

    // Collect all subject averages for the overall-average effect.
    let mut all_subjects: Vec<(String, f64)> = Vec::new();
    for vak in &vakken {
        let name = vak
            .get("Vak")
            .and_then(|v| v.get("Omschrijving"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let (tp, tw, _) = subject_totals_from_overview(vak);
        if tw > 0.0 {
            all_subjects.push((name, tp / tw));
        }
    }

    let vak = found.ok_or_else(|| {
        let known: Vec<&str> = vakken
            .iter()
            .filter_map(|v| v.get("Vak").and_then(|v| v.get("Omschrijving")).and_then(|v| v.as_str()))
            .collect();
        format!(
            "Vak '{}' niet gevonden in het cijferoverzicht. Bekende vakken: {}",
            subject_query,
            known.join(", ")
        )
    })?;

    subject_name = vak
        .get("Vak")
        .and_then(|v| v.get("Omschrijving"))
        .and_then(|v| v.as_str())
        .unwrap_or(&subject_name)
        .to_string();
    let (tp, tw, count) = subject_totals_from_overview(vak);

    Ok((tp, tw, count, subject_name, all_subjects))
}

/// Endpoint of the current session (for same-host download validation).
fn api_endpoint_of(client: &crate::client::MagisterClient) -> Result<String, String> {
    client
        .token_set
        .as_ref()
        .map(|t| t.api_endpoint.clone())
        .ok_or_else(|| "Niet ingelogd.".to_string())
}

/// Resolve an indirection link and download with same-host-final enforcement
/// and the 15MB cap. Returns (bytes, content_type, name).
async fn download_attachment(
    client: &mut crate::client::MagisterClient,
    endpoint: &str,
    url: &str,
    filename: &str,
) -> Result<(Vec<u8>, String, String), String> {
    use crate::ai::attachment_reader as ar;
    // Magister's download/Self links are indirection links — resolve to the
    // real content URL first, without following redirects.
    let path = url.trim_start_matches("/api/");
    let resolved = client
        .get_redirect_location(path)
        .await
        .map_err(|e| format!("Kon download-link niet resolven: {}", e))?;
    let fetch_url = if resolved.trim().is_empty() {
        url.to_string()
    } else {
        // The resolved target must stay on our host (SSRF guard).
        ar::validate_attachment_url(&resolved, endpoint)?;
        resolved
    };
    let (bytes, content_type, final_url) = client
        .get_bytes_with_content_type(&fetch_url)
        .await
        .map_err(|e| e.to_string())?;
    ar::validate_final_url(&final_url, endpoint)?;
    if bytes.len() > ar::MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "Bestand te groot ({:.1} MB, max 15 MB).",
            bytes.len() as f64 / 1_048_576.0
        ));
    }
    Ok((bytes, content_type, filename.to_string()))
}

/// Subject name from a raw Vak value (string or {Omschrijving,...}).
fn subject_name(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(obj) if obj.is_object() => obj
            .get("Omschrijving")
            .or_else(|| obj.get("Afkorting"))
            .or_else(|| obj.get("Naam"))
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        _ => None,
    }
}

/// Default-folder message list link (same resolution as `get_messages`).
async fn inbox_message_link(
    client: &mut crate::client::MagisterClient,
    _person_id: i64,
) -> Result<String, String> {
    let folders_data = client
        .get("berichten/mappen/alle")
        .await
        .map_err(|e| e.to_string())?;
    let folders = folders_data
        .get("Items")
        .or_else(|| folders_data.get("items"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let f = folders.first().ok_or_else(|| "Geen mappen gevonden.".to_string())?;
    let link = f
        .get("Links")
        .and_then(|l| l.as_array())
        .and_then(|arr| arr.first())
        .and_then(|l| l.get("Href").or_else(|| l.get("href")))
        .and_then(|h| h.as_str())
        .or_else(|| {
            f.get("links")
                .and_then(|l| l.get("berichten"))
                .and_then(|b| b.get("href"))
                .and_then(|h| h.as_str())
        })
        .or_else(|| {
            f.get("Links")
                .and_then(|l| l.get("berichten"))
                .and_then(|b| b.get("href"))
                .and_then(|h| h.as_str())
        })
        .unwrap_or("");
    let link = if link.is_empty() {
        let fid = f
            .get("Id")
            .or_else(|| f.get("id"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if fid != 0 {
            format!("berichten/mappen/{}/berichten", fid)
        } else {
            return Err("Geen berichtenlink gevonden.".to_string());
        }
    } else {
        link.trim_start_matches("/api/").to_string()
    };
    Ok(link)
}

/// One attachment enumerated by `list_files`.
fn harvest_bijlage(
    out: &mut Vec<Value>,
    source: &str,
    parent_id: String,
    bijlage: &Value,
    index: usize,
    subject: Option<String>,
    title: Option<String>,
    due: Option<String>,
    date: Option<String>,
) {
    use crate::ai::attachment_reader as ar;
    let name = bijlage
        .get("Naam")
        .or_else(|| bijlage.get("naam"))
        .and_then(|v| v.as_str())
        .unwrap_or("bijlage")
        .to_string();
    let url = bijlage
        .get("Url")
        .or_else(|| bijlage.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if url.is_empty() {
        return;
    }
    let attachment_id = bijlage
        .get("Id")
        .or_else(|| bijlage.get("id"))
        .and_then(|v| v.as_i64())
        .map(|i| i.to_string())
        .unwrap_or_else(|| format!("idx{}", index));
    let file_id = format!("{}:{}:{}", &source[..1], parent_id, attachment_id);
    let extension = std::path::Path::new(&name.to_lowercase())
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let size_bytes = bijlage
        .get("Grootte")
        .or_else(|| bijlage.get("grootte"))
        .or_else(|| bijlage.get("GrootteBytes"))
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|i| i.max(0) as u64)));
    ar::registry_put(
        file_id.clone(),
        ar::FileRef {
            url: url.clone(),
            name: name.clone(),
            source: source.to_string(),
        },
    );
    out.push(serde_json::json!({
        "file_id": file_id,
        "name": name,
        "extension": extension,
        "size_bytes": size_bytes,
        "source": source,
        "context": {
            "subject": subject,
            "title": title,
            "due": due,
            "date": date,
        },
        "readable": ar::is_readable_extension(&name, true),
    }));
}

/// Execute an AI tool call and return the result.
/// `client` must be locked before calling.
/// Write tools (send_message, mark_messages_read, ...) do NOT perform their
/// side effect here — they stage a [`PendingAction`] in `pending_actions` and
/// return a "pending_user_confirmation" payload that the user must confirm
/// before anything is actually sent. Read-only tools execute immediately.
pub async fn execute_tool(
    client: &mut crate::client::MagisterClient,
    tool_name: &str,
    args: &Value,
    person_id: i64,
    pending_actions: &PendingActionStore,
) -> ToolResult {
    match tool_name {
        "get_calendar_events" => {
            let start_arg = args.get("start").and_then(|v| v.as_str()).unwrap_or("");
            let end_arg = args.get("end").and_then(|v| v.as_str()).unwrap_or("");
            let start_arg = start_arg.get(0..10).unwrap_or(start_arg);
            let end_arg = end_arg.get(0..10).unwrap_or(end_arg);
            let offset = int_arg(args, "offset", 0).max(0) as usize;
            let limit = int_arg(args, "limit", CALENDAR_DEFAULT_LIMIT as i64);
            let limit = (limit.max(1).min(CALENDAR_MAX_LIMIT as i64)) as usize;
            let range = match resolve_calendar_range(start_arg, end_arg, &crate::ai::time::today_amsterdam()) {
                Ok(r) => r,
                Err(e) => {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(e),
                    }
                }
            };
            match client
                .get(&format!(
                    "personen/{}/afspraken?tot={}&van={}",
                    person_id, range.effective_end, range.start
                ))
                .await
            {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let mut slimmed: Vec<Value> = items
                        .as_array()
                        .map(|arr| arr.iter().map(slim_calendar_item).collect())
                        .unwrap_or_default();
                    slimmed.sort_by(|a, b| {
                        let sa = a.get("start").and_then(|v| v.as_str()).unwrap_or("");
                        let sb = b.get("start").and_then(|v| v.as_str()).unwrap_or("");
                        sa.cmp(sb)
                    });
                    let total = slimmed.len();
                    let (page, truncated, next_offset) = paginate_slice(&slimmed, offset, limit);
                    let mut days: Vec<Value> = Vec::new();
                    for item in &page {
                        if let Some(d) = item.get("date").and_then(|v| v.as_str()) {
                            let bump = days.last_mut().and_then(|l| {
                                if l.get("date").and_then(|v| v.as_str()) == Some(d) {
                                    Some(l)
                                } else {
                                    None
                                }
                            });
                            match bump {
                                Some(last) => {
                                    let c = last.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
                                    last["count"] = Value::Number(c.saturating_add(1).into());
                                }
                                None => days.push(serde_json::json!({ "date": d, "count": 1 })),
                            }
                        }
                    }
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({
                            "items": page,
                            "count": page.len(),
                            "days": days,
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
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_calendar_event_detail" => {
            let id = args.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            if id == 0 {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Geen geldig agenda-item ID opgegeven.".to_string()),
                };
            }
            let date_arg = args.get("date").and_then(|v| v.as_str()).unwrap_or("");
            let date_arg = date_arg.get(0..10).unwrap_or(date_arg);
            let date = if date_arg.is_empty() {
                crate::ai::time::today_amsterdam()
            } else {
                date_arg.to_string()
            };
            if !crate::ai::time::is_valid_date_str(&date) {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(format!("Ongeldige datum '{}' (verwacht yyyy-MM-dd).", date)),
                };
            }
            match client
                .get(&format!("personen/{}/afspraken?tot={}&van={}", person_id, date, date))
                .await
            {
                Ok(data) => {
                    let found = data
                        .get("Items")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| {
                            arr.iter().find(|item| item.get("Id").and_then(|v| v.as_i64()) == Some(id))
                        })
                        .cloned();
                    match found {
                        Some(item) => {
                            let docenten = item
                                .get("Docenten")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter().map(redact_docent).collect::<Vec<Value>>())
                                .unwrap_or_default();
                            let inhoud = item.get("Inhoud").and_then(|v| v.as_str()).unwrap_or("");
                            ToolResult {
                                tool: tool_name.to_string(),
                                success: true,
                                data: serde_json::json!({
                                    "id": item.get("Id"),
                                    "date": date,
                                    "start": item.get("Start"),
                                    "end": item.get("Einde"),
                                    "vak": item.get("Vakken").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|v| v.get("Naam")),
                                    "docent": docenten,
                                    "lokaal": item.get("Lokalen").and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|v| v.get("Naam")),
                                    "lesuur": item.get("LesuurVan"),
                                    "omschrijving": item.get("Omschrijving"),
                                    "inhoud": if inhoud.is_empty() { Value::Null } else { Value::String(inhoud.to_string()) },
                                    "huiswerk": !inhoud.trim().is_empty(),
                                    "afgerond": item.get("Afgerond"),
                                    "type": item.get("Type"),
                                    "status": item.get("Status"),
                                }),
                                error: None,
                            }
                        }
                        None => ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(format!(
                                "Agenda-item {} niet gevonden op {}. Roep get_calendar_events aan voor het juiste bereik en probeer opnieuw.",
                                id, date
                            )),
                        },
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_grades" => {
            let top = args.get("top").and_then(|v| v.as_i64()).unwrap_or(10).min(20) as usize;
            match client
                .get(&format!("personen/{}/cijfers/laatste?top={}&skip=0", person_id, top))
                .await
            {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .map(|item| {
                                    let docent_val = item.get("Docent");
                                    let redacted_docent = match docent_val {
                                        Some(v) if v.is_string() => {
                                            let s = v.as_str().unwrap_or("");
                                            Value::String(redact_teacher_name_str(s))
                                        }
                                        Some(v) if v.is_object() => redact_docent(v)
                                            .get("naam")
                                            .cloned()
                                            .unwrap_or(Value::Null),
                                        _ => Value::Null,
                                    };
                                    serde_json::json!({
                                        "id": item.get("Id"),
                                        "vak": item.get("Vak").and_then(|v| v.get("Omschrijving")),
                                        "cijfer": item.get("CijferStr"),
                                        "datum": item.get("DatumIngevoerd"),
                                        "weging": item.get("CijferKolom").and_then(|c| c.get("Weging")),
                                        "docent": redacted_docent,
                                        "titel": item.get("CijferKolom").and_then(|c| c.get("Titel")),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    // Magister exposes no list total here; total == returned (bound by top).
                    let total = simplified.len();
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "items": simplified, "count": total, "total": total }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_full_grade_overview" => {
            let schoolyear_id = args.get("schoolyear_id").and_then(|v| v.as_i64()).unwrap_or(0);
            let einde = args.get("einde").and_then(|v| v.as_str()).unwrap_or("");
            let peildatum = if einde.len() > 10 { einde.get(0..10).unwrap_or(einde) } else { einde };

            let path = format!(
                "personen/{}/aanmeldingen/{}/cijfers/cijferoverzichtvooraanmelding?actievePerioden=false&alleenBerekendeKolommen=false&alleenPTAKolommen=false&peildatum={}",
                person_id, schoolyear_id, peildatum
            );

            match client.get(&path).await {
                Ok(data) => {
                    let vakken = data
                        .get("CijferVakken")
                        .or_else(|| data.get("CijferOverzicht").and_then(|co| co.get("CijferVakken")))
                        .and_then(|v| v.as_array());

                    let simplified: Vec<Value> = vakken
                        .map(|vakken| {
                            vakken.iter().map(|vak| {
                                let cijfers: Vec<Value> = vak.get("Cijfers")
                                    .and_then(|c| c.as_array())
                                    .map(|arr| {
                                        arr.iter().map(|c| {
                                            serde_json::json!({
                                                "cijfer": c.get("CijferStr"),
                                                "datum": c.get("DatumIngevoerd"),
                                                "weging": c.get("Weging"),
                                                "titel": c.get("CijferKolom").and_then(|k| k.get("Titel")),
                                            })
                                        }).collect()
                                    })
                                    .unwrap_or_default();

                                serde_json::json!({
                                    "vak": vak.get("Vak").and_then(|v| v.get("Omschrijving")).or_else(|| vak.get("Vak").and_then(|v| v.get("Afkorting"))),
                                    "gemiddelde": vak.get("Gemiddelde"),
                                    "cijfers": cijfers,
                                })
                            }).collect()
                        })
                        .unwrap_or_default();

                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "vakken": simplified, "count": simplified.len(), "peildatum": peildatum }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_schoolyears" => {
            let today = crate::ai::time::today_amsterdam();
            match client
                .get(&format!(
                    "leerlingen/{}/aanmeldingen?begin=2013-01-01&einde={}",
                    person_id, today
                ))
                .await
            {
                Ok(data) => {
                    let items: Vec<Value> = data["Items"]
                        .as_array()
                        .or_else(|| data["items"].as_array())
                        .or_else(|| data.as_array())
                        .map(|arr| {
                            arr.iter().map(|item| {
                                serde_json::json!({
                                    "id": item.get("Id"),
                                    "naam": item.get("Naam"),
                                    "van": item.get("Van"),
                                    "tot": item.get("Tot"),
                                    "is_actief": item.get("IsActief"),
                                })
                            }).collect()
                        })
                        .unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "items": items, "count": items.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_assignments" => {
            let start = args.get("start").and_then(|v| v.as_str()).unwrap_or("");
            let end = args.get("end").and_then(|v| v.as_str()).unwrap_or("");
            match client
                .get(&format!(
                    "personen/{}/opdrachten?van={}&tot={}",
                    person_id, start, end
                ))
                .await
            {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .map(|item| {
                                    // Attachment names only (no contents): awareness without cost.
                                    let bijlagen: Vec<Value> = item
                                        .get("Bijlagen")
                                        .and_then(|v| v.as_array())
                                        .map(|a| {
                                            a.iter()
                                                .filter_map(|b| {
                                                    b.get("Naam").and_then(|n| n.as_str()).map(|s| {
                                                        Value::String(s.to_string())
                                                    })
                                                })
                                                .collect()
                                        })
                                        .unwrap_or_default();
                                    serde_json::json!({
                                        "id": item.get("Id"),
                                        "titel": item.get("Titel"),
                                        "vak": item.get("Vak"),
                                        "inleveren_voor": item.get("InleverenVoor"),
                                        "ingeleverd_op": item.get("IngeleverdOp"),
                                        "afgesloten": item.get("Afgesloten"),
                                        "omschrijving": item.get("Omschrijving"),
                                        "type": item.get("Type"),
                                        "bijlagen": bijlagen,
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_messages" => {
            let folder_arg = args
                .get("folder")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let top = args.get("top").and_then(|v| v.as_i64()).unwrap_or(10);
            match client.get("berichten/mappen/alle").await {
                Ok(folders_data) => {
                    let folders = folders_data
                        .get("Items")
                        .or_else(|| folders_data.get("items"))
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    if folders.is_empty() {
                        return ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some("Geen mappen gevonden.".to_string()),
                        };
                    }
                    // Default to the first folder (same logic Messages.svelte already uses) unless
                    // the model explicitly names one. Matching is case-insensitive and tries both
                    // Dutch names ("Postvak IN") and legacy English aliases.
                    let folder_item = if let Some(ref name) = folder_arg {
                        folders
                            .iter()
                            .find(|f| {
                                f.get("Naam")
                                    .or_else(|| f.get("naam"))
                                    .and_then(|v| v.as_str())
                                    .map(|n| n.eq_ignore_ascii_case(name))
                                    .unwrap_or(false)
                            })
                            .or_else(|| folders.first())
                    } else {
                        folders.first()
                    };
                    if let Some(f) = folder_item {
                        let folder_name = f
                            .get("Naam")
                            .or_else(|| f.get("naam"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // Robustly extract the berichten link: handle both array-Links and object-links shapes.
                        let link = f
                            .get("Links")
                            .and_then(|l| l.as_array())
                            .and_then(|arr| arr.first())
                            .and_then(|l| l.get("Href").or_else(|| l.get("href")))
                            .and_then(|h| h.as_str())
                            .or_else(|| {
                                f.get("links")
                                    .and_then(|l| l.get("berichten"))
                                    .and_then(|b| b.get("href"))
                                    .and_then(|h| h.as_str())
                            })
                            .or_else(|| {
                                f.get("Links")
                                    .and_then(|l| l.get("berichten"))
                                    .and_then(|b| b.get("href"))
                                    .and_then(|h| h.as_str())
                            })
                            .unwrap_or("");
                        let link = if link.is_empty() {
                            // Fallback: construct via folder id if link missing
                            let fid = f
                                .get("Id")
                                .or_else(|| f.get("id"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            if fid != 0 {
                                format!("berichten/mappen/{}/berichten", fid)
                            } else {
                                link.to_string()
                            }
                        } else {
                            link.trim_start_matches("/api/").to_string()
                        };
                        match client.get(&format!("{}/berichten?top={}", link.trim_start_matches('/'), top)).await {
                            Ok(msgs) => {
                                let items = msgs
                                    .get("Items")
                                    .or_else(|| msgs.get("items"))
                                    .cloned()
                                    .unwrap_or(Value::Array(vec![]));
                                let simplified: Vec<Value> = items
                                    .as_array()
                                    .map(|arr| {
                                        arr.iter()
                                            .map(|item| {
                                                serde_json::json!({
                                                    "id": item.get("Id").or_else(|| item.get("id")),
                                                    "onderwerp": item.get("Onderwerp").or_else(|| item.get("onderwerp")),
                                                    "afzender": item.get("Afzender").and_then(|a| a.get("Naam")).or_else(|| item.get("afzender").and_then(|a| a.get("naam"))),
                                                    "datum": item.get("DatumVerzonden").or_else(|| item.get("verzondenOp")).or_else(|| item.get("VerzondenOp")),
                                                    "gelezen": item.get("IsGelezen").or_else(|| item.get("isGelezen")),
                                                    "prioriteit": item.get("Prioriteit").or_else(|| item.get("heeftPrioriteit")),
                                                })
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                ToolResult {
                                    tool: tool_name.to_string(),
                                    success: true,
                                    // The folder endpoint exposes no message total; total == returned.
                                    data: serde_json::json!({ "items": simplified, "count": simplified.len(), "total": simplified.len(), "folder": folder_name }),
                                    error: None,
                                }
                            }
                            Err(e) => ToolResult {
                                tool: tool_name.to_string(),
                                success: false,
                                data: Value::Null,
                                error: Some(e.to_string()),
                            },
                        }
                    } else {
                        ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some("Geen map gevonden.".to_string()),
                        }
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }
        "get_message_content" => {
            let message_id = args.get("message_id").and_then(|v| v.as_i64()).unwrap_or(0);
            match client.get(&format!("berichten/{}", message_id)).await {
                Ok(data) => {
                    let simplified = serde_json::json!({
                        "id": data.get("Id"),
                        "onderwerp": data.get("Onderwerp"),
                        "afzender": data.get("Afzender").and_then(|a| a.get("Naam")),
                        "datum": data.get("DatumVerzonden"),
                        "inhoud": data.get("Inhoud"),
                        "bijlagen": data.get("Bijlagen"),
                        "is_gelezen": data.get("IsGelezen"),
                    });
                    ToolResult {
                        tool: tool_name.to_string(), success: true, data: simplified, error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_absences" => {
            let start = args.get("start").and_then(|v| v.as_str()).unwrap_or("");
            let end = args.get("end").and_then(|v| v.as_str()).unwrap_or("");
            match client
                .get(&format!("personen/{}/absenties?tot={}&van={}", person_id, end, start))
                .await
            {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    ToolResult {
                        tool: tool_name.to_string(), success: true,
                        data: serde_json::json!({ "items": items, "count": items.as_array().map(|a| a.len()).unwrap_or(0) }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_studiewijzers" => {
            match client.get(&format!("personen/{}/studiewijzers", person_id)).await {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items.as_array().map(|arr| {
                        arr.iter().map(|item| {
                            serde_json::json!({
                                "id": item.get("Id"), "naam": item.get("Naam"),
                                "vak": item.get("VakNaam"),
                                "geldig_vanaf": item.get("GeldigVanaf"), "geldig_tot": item.get("GeldigTot"),
                            })
                        }).collect()
                    }).unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(), success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_activities" => {
            match client.get(&format!("personen/{}/activiteiten", person_id)).await {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items.as_array().map(|arr| {
                        arr.iter().map(|item| {
                            serde_json::json!({
                                "id": item.get("Id"), "naam": item.get("Naam"),
                                "categorie": item.get("Categorie"),
                                "begin": item.get("Begin"), "einde": item.get("Einde"),
                                "status": item.get("Status"),
                            })
                        }).collect()
                    }).unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(), success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_bronnen" => {
            match client.get(&format!("personen/{}/bronnen?soort=0", person_id)).await {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items.as_array().map(|arr| {
                        arr.iter().map(|item| {
                            serde_json::json!({
                                "id": item.get("Id"), "naam": item.get("Naam"),
                                "bron_soort": item.get("BronSoort"),
                                "url": item.get("Url"),
                                "is_favoriet": item.get("IsFavoriet"),
                            })
                        }).collect()
                    }).unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(), success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_leermiddelen" => {
            match client.get(&format!("personen/{}/lesmateriaal", person_id)).await {
                Ok(data) => {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    let simplified: Vec<Value> = items.as_array().map(|arr| {
                        arr.iter().map(|item| {
                            serde_json::json!({
                                "id": item.get("Id"), "titel": item.get("Titel"),
                                "vak": item.get("VakNaam"),
                                "uitgever": item.get("Uitgever"),
                                "type": item.get("Type"),
                            })
                        }).collect()
                    }).unwrap_or_default();
                    ToolResult {
                        tool: tool_name.to_string(), success: true,
                        data: serde_json::json!({ "items": simplified, "count": simplified.len() }),
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(), success: false, data: Value::Null, error: Some(e.to_string()),
                },
            }
        }
        "get_profile_info" => {
            let mut results = serde_json::Map::new();

            // Privacy: do NOT send account, adressen, or geboortedatum to the LLM.
            // Only roepnaam (explicitly OK'd) and academic/class info.
            if let Ok(profile) = client.get(&format!("personen/{}", person_id)).await {
                let simplified = serde_json::json!({
                    "roepnaam": profile.get("Roepnaam"),
                    "voorletter": profile.get("Voorletter"),
                    "achternaam": profile.get("Achternaam"),
                    "klas": profile.get("Groep"),
                });
                results.insert("persoon".to_string(), simplified);
            }

            if let Ok(career) = client.get(&format!("personen/{}/opleidinggegevensprofiel", person_id)).await {
                // `opleiding` may contain mentor / klas info which is needed for context;
                // redact any embedded Docent names to code/last-name only.
                let mut opleiding_val = career;
                if let Some(obj) = opleiding_val.as_object_mut() {
                    for key in ["Mentor", "mentor", "Docent", "docent", "Docenten"] {
                        if let Some(doc) = obj.get(key).cloned() {
                            if doc.is_object() {
                                obj.insert(key.to_string(), redact_docent(&doc));
                            } else if doc.is_array() {
                                if let Some(arr) = doc.as_array() {
                                    obj.insert(key.to_string(), redact_docenten_array(Some(arr)));
                                }
                            }
                        }
                    }
                }
                results.insert("opleiding".to_string(), opleiding_val);
            }

            ToolResult {
                tool: tool_name.to_string(), success: true,
                data: serde_json::Value::Object(results),
                error: None,
            }
        }
        "get_current_time" => ToolResult {
            tool: tool_name.to_string(),
            success: true,
            data: crate::ai::time::current_time_json(),
            error: None,
        },
        "get_today_summary" => {
            let today = crate::ai::time::today_amsterdam();
            let next_week = crate::ai::time::add_days(&today, 7);

            let mut summary = serde_json::Map::new();

            if let Ok(events) = client
                .get(&format!("personen/{}/afspraken?tot={}&van={}", person_id, today, today))
                .await
            {
                let mut items = events.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                // Privacy: redact teacher names in today's lessons
                if let Some(arr) = items.as_array_mut() {
                    for item in arr.iter_mut() {
                        if let Some(docenten) = item.get("Docenten").and_then(|v| v.as_array()).cloned() {
                            if let Some(obj) = item.as_object_mut() {
                                obj.insert("Docenten".to_string(), redact_docenten_array(Some(&docenten)));
                            }
                        }
                    }
                }
                summary.insert("vandaag_lessen".to_string(), items);
            }

            if let Ok(grades) = client
                .get(&format!("personen/{}/cijfers/laatste?top=5&skip=0", person_id))
                .await
            {
                let mut items = grades.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                // Privacy: redact teacher names in grades (string field)
                if let Some(arr) = items.as_array_mut() {
                    for item in arr.iter_mut() {
                        if let Some(name) = item.get("Docent").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                            let redacted = redact_teacher_name_str(&name);
                            if let Some(obj) = item.as_object_mut() {
                                obj.insert("Docent".to_string(), Value::String(redacted));
                            }
                        }
                    }
                }
                summary.insert("recente_cijfers".to_string(), items);
            }

            if let Ok(assignments) = client
                .get(&format!("personen/{}/opdrachten?van={}&tot={}", person_id, today, next_week))
                .await
            {
                let mut items = assignments.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                if let Some(arr) = items.as_array_mut() {
                    for item in arr.iter_mut() {
                        if let Some(docenten) = item.get("Docenten").and_then(|v| v.as_array()).cloned() {
                            if let Some(obj) = item.as_object_mut() {
                                obj.insert("Docenten".to_string(), redact_docenten_array(Some(&docenten)));
                            }
                        }
                    }
                }
                summary.insert("aankomende_opdrachten".to_string(), items);
            }

            if let Ok(folders) = client.get("berichten/mappen/alle").await {
                let unread = folders
                    .get("Items")
                    .or_else(|| folders.get("items"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|f| {
                                f.get("aantalOngelezen")
                                    .or_else(|| f.get("AantalOngelezen"))
                                    .or_else(|| f.get("aantal_ongelezen"))
                                    .and_then(|v| v.as_i64())
                            })
                            .sum::<i64>()
                    })
                    .unwrap_or(0);
                summary.insert("ongelezen_berichten".to_string(), Value::Number(unread.into()));
            }

            if let Ok(absences) = client
                .get(&format!("personen/{}/absenties?tot={}&van={}", person_id, today, today))
                .await
            {
                let items = absences.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                summary.insert("vandaag_absenties".to_string(), items);
            }

            ToolResult {
                tool: tool_name.to_string(), success: true,
                data: serde_json::Value::Object(summary),
                error: None,
            }
        }

        // Write tool: never send directly. Stage the message for explicit user
        // confirmation; the real POST only happens via confirm_pending_action.
        "send_message" => {
            let subject = args.get("subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let recipients: Vec<Value> = args.get("recipients").and_then(|v| v.as_array()).cloned().unwrap_or_default();

            if subject.trim().is_empty() || body.trim().is_empty() || recipients.is_empty() {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Bericht ontbreekt: onderwerp, inhoud en minstens één ontvanger zijn verplicht.".to_string()),
                };
            }

            let action_id = generate_action_id();
            let action = PendingAction {
                action_type: "send_message".to_string(),
                args: args.clone(),
                created_at: now_secs(),
            };
            if let Ok(mut store) = pending_actions.lock() {
                store.insert(action_id.clone(), action);
            }

            ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({
                    "status": "pending_user_confirmation",
                    "action_id": action_id,
                    "action_type": "send_message",
                    "recipients": recipients,
                    "subject": subject,
                    "body": body,
                    "message": format!(
                        "Het bericht '{}' is klaargezet en wacht op bevestiging door de gebruiker. Er is nog NIETS verzonden. Vertel de gebruiker dat het bericht klaarstaat en dat hij/zij het expliciet moet bevestigen voordat het daadwerkelijk wordt verstuurd.",
                        subject
                    )
                }),
                error: None,
            }
        }

        // Write tool: never mark directly. Stage the action for explicit user
        // confirmation; the real PUT only happens via confirm_pending_action.
        "mark_messages_read" => {
            let message_ids = args.get("message_ids")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect::<Vec<i64>>())
                .unwrap_or_default();

            if message_ids.is_empty() {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Geen geldige bericht-ID's opgegeven.".to_string()),
                };
            }

            let action_id = generate_action_id();
            let action = PendingAction {
                action_type: "mark_messages_read".to_string(),
                args: args.clone(),
                created_at: now_secs(),
            };
            if let Ok(mut store) = pending_actions.lock() {
                store.insert(action_id.clone(), action);
            }

            ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({
                    "status": "pending_user_confirmation",
                    "action_id": action_id,
                    "action_type": "mark_messages_read",
                    "message_ids": message_ids,
                    "message": "De berichten zijn klaargezet om als gelezen te markeren en wachten op bevestiging door de gebruiker. Er is nog NIETS gemarkeerd. Vertel de gebruiker dat er bevestiging nodig is."
                }),
                error: None,
            }
        }

        "get_assignment_detail" => {
            let assignment_id = args.get("assignment_id").and_then(|v| v.as_i64()).unwrap_or(0);

            match client.get(&format!("personen/{}/opdrachten/{}", person_id, assignment_id)).await {
                Ok(data) => {
                    let docenten_raw = data.get("Docenten").and_then(|v| v.as_array()).cloned();
                    let redacted_docenten = redact_docenten_array(docenten_raw.as_ref());
                    let simplified = serde_json::json!({
                        "id": data.get("Id"),
                        "titel": data.get("Titel"),
                        "vak": data.get("Vak"),
                        "inleveren_voor": data.get("InleverenVoor"),
                        "ingeleverd_op": data.get("IngeleverdOp"),
                        "omschrijving": data.get("Omschrijving"),
                        "bijlagen": data.get("Bijlagen").and_then(|b| b.as_array()).map(|arr| {
                            arr.iter().map(|a| serde_json::json!({
                                "id": a.get("Id"),
                                "naam": a.get("Naam"),
                                "url": a.get("Url"),
                                "grootte": a.get("Grootte"),
                                "content_type": a.get("ContentType"),
                            })).collect::<Vec<_>>()
                        }),
                        "docenten": redacted_docenten,
                        "beoordeling": data.get("Beoordeling"),
                        "beoordeeld_op": data.get("BeoordeeldOp"),
                        "status_laatste_opdracht_versie": data.get("StatusLaatsteOpdrachtVersie"),
                    });
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data: simplified,
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }

        "list_files" => {
            let scope = args.get("scope").and_then(|v| v.as_str()).unwrap_or("all").to_string();
            let scope = match scope.as_str() {
                "assignment" | "message" | "lesson" => scope,
                _ => "all".to_string(),
            };
            let subject_filter = args
                .get("subject")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty());
            let start_arg = args.get("start").and_then(|v| v.as_str()).unwrap_or("");
            let end_arg = args.get("end").and_then(|v| v.as_str()).unwrap_or("");
            let start_arg = start_arg.get(0..10).unwrap_or(start_arg);
            let end_arg = end_arg.get(0..10).unwrap_or(end_arg);
            let range = match resolve_calendar_range(start_arg, end_arg, &crate::ai::time::today_amsterdam()) {
                Ok(r) => r,
                Err(e) => {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(e),
                    }
                }
            };
            let subject_matches = |subject: &Option<String>| -> bool {
                match (&subject_filter, subject) {
                    (None, _) => true,
                    (Some(f), Some(s)) => s.to_lowercase().contains(f),
                    (Some(_), None) => false,
                }
            };
            let mut files: Vec<Value> = Vec::new();

            // Assignments: raw list Bijlagen first, detail fallback per item.
            if scope == "all" || scope == "assignment" {
                if let Ok(data) = client
                    .get(&format!(
                        "personen/{}/opdrachten?van={}&tot={}",
                        person_id, range.start, range.effective_end
                    ))
                    .await
                {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    if let Some(arr) = items.as_array() {
                        for item in arr {
                            let aid = item.get("Id").and_then(|v| v.as_i64()).unwrap_or(0);
                            if aid == 0 {
                                continue;
                            }
                            let raw_bijlagen = item
                                .get("Bijlagen")
                                .and_then(|v| v.as_array())
                                .cloned()
                                .unwrap_or_default();
                            // Detail fetch only when the list omits Bijlagen.
                            let detail = if raw_bijlagen.is_empty() {
                                client
                                    .get(&format!("personen/{}/opdrachten/{}", person_id, aid))
                                    .await
                                    .ok()
                            } else {
                                None
                            };
                            let src = detail.as_ref().unwrap_or(item);
                            let vak = subject_name(
                                src.get("Vak").or_else(|| item.get("Vak")),
                            );
                            if !subject_matches(&vak) {
                                continue;
                            }
                            let titel = src
                                .get("Titel")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let due = src
                                .get("InleverenVoor")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let bijlagen = src
                                .get("Bijlagen")
                                .and_then(|v| v.as_array())
                                .cloned()
                                .unwrap_or_default();
                            for (idx, b) in bijlagen.iter().enumerate() {
                                harvest_bijlage(
                                    &mut files,
                                    "assignment",
                                    aid.to_string(),
                                    b,
                                    idx,
                                    vak.clone(),
                                    titel.clone(),
                                    due.clone(),
                                    None,
                                );
                            }
                        }
                    }
                }
            }

            // Messages: default folder, top 10, content fetch for details.
            if scope == "all" || scope == "message" {
                if let Ok(link) = inbox_message_link(client, person_id).await {
                    if let Ok(msgs) = client.get(&format!("{}/berichten?top=10", link.trim_start_matches('/'))).await {
                        let items = msgs
                            .get("Items")
                            .or_else(|| msgs.get("items"))
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        for item in items.iter().take(10) {
                            let mid = item.get("Id").or_else(|| item.get("id")).and_then(|v| v.as_i64()).unwrap_or(0);
                            if mid == 0 {
                                continue;
                            }
                            let raw_bijlagen = item
                                .get("Bijlagen")
                                .or_else(|| item.get("bijlagen"))
                                .and_then(|v| v.as_array())
                                .cloned()
                                .unwrap_or_default();
                            let detail = if raw_bijlagen.is_empty() {
                                client.get(&format!("berichten/{}", mid)).await.ok()
                            } else {
                                None
                            };
                            let src = detail.as_ref().unwrap_or(item);
                            let bijlagen = src
                                .get("Bijlagen")
                                .or_else(|| src.get("bijlagen"))
                                .and_then(|v| v.as_array())
                                .cloned()
                                .unwrap_or_default();
                            if bijlagen.is_empty() {
                                continue;
                            }
                            // Messages carry no subject; a subject filter excludes them.
                            if subject_filter.is_some() {
                                continue;
                            }
                            let title = src
                                .get("Onderwerp")
                                .or_else(|| src.get("onderwerp"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let date = src
                                .get("DatumVerzonden")
                                .or_else(|| src.get("verzondenOp"))
                                .or_else(|| src.get("VerzondenOp"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            for (idx, b) in bijlagen.iter().enumerate() {
                                harvest_bijlage(
                                    &mut files,
                                    "message",
                                    mid.to_string(),
                                    b,
                                    idx,
                                    None,
                                    title.clone(),
                                    None,
                                    date.clone(),
                                );
                            }
                        }
                    }
                }
            }

            // Lessons: raw agenda items carry their Bijlagen directly.
            if scope == "all" || scope == "lesson" {
                if let Ok(data) = client
                    .get(&format!(
                        "personen/{}/afspraken?tot={}&van={}",
                        person_id, range.effective_end, range.start
                    ))
                    .await
                {
                    let items = data.get("Items").cloned().unwrap_or(Value::Array(vec![]));
                    if let Some(arr) = items.as_array() {
                        for item in arr {
                            let bijlagen = item
                                .get("Bijlagen")
                                .or_else(|| item.get("bijlagen"))
                                .and_then(|v| v.as_array())
                                .cloned()
                                .unwrap_or_default();
                            if bijlagen.is_empty() {
                                continue;
                            }
                            let eid = item.get("Id").and_then(|v| v.as_i64()).unwrap_or(0);
                            let vak = item
                                .get("Vakken")
                                .and_then(|v| v.as_array())
                                .and_then(|a| a.first())
                                .and_then(|v| v.get("Naam"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            if !subject_matches(&vak) {
                                continue;
                            }
                            let title = item.get("Omschrijving").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let date = item
                                .get("Start")
                                .and_then(|v| v.as_str())
                                .map(|s| s.get(0..10).unwrap_or(s).to_string());
                            for (idx, b) in bijlagen.iter().enumerate() {
                                harvest_bijlage(
                                    &mut files,
                                    "lesson",
                                    eid.to_string(),
                                    b,
                                    idx,
                                    vak.clone(),
                                    title.clone(),
                                    None,
                                    date.clone(),
                                );
                            }
                        }
                    }
                }
            }

            let total = files.len();
            let truncated = total > 100;
            if truncated {
                files.truncate(100);
            }
            ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({
                    "files": files,
                    "count": files.len(),
                    "total": total,
                    "truncated": truncated,
                    "scope": scope,
                    "window_default": { "start": range.window_start, "end": range.window_end },
                }),
                error: None,
            }
        }

        "read_attachment_text" => {
            use crate::ai::attachment_reader as ar;
            let file_id = args.get("file_id").and_then(|v| v.as_str()).unwrap_or("");
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let filename = args
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let offset = args.get("offset").and_then(|v| v.as_i64()).unwrap_or(0).max(0) as usize;
            let max_chars = args
                .get("max_chars")
                .and_then(|v| v.as_i64())
                .unwrap_or(ar::DEFAULT_PAGE_CHARS as i64)
                .clamp(1, ar::DEFAULT_PAGE_CHARS as i64) as usize;

            let endpoint = match api_endpoint_of(client) {
                Ok(e) => e,
                Err(e) => {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(e),
                    }
                }
            };
            let cache_key = if !file_id.is_empty() {
                format!("id:{}", file_id)
            } else {
                format!("url:{}", url)
            };

            // Resolve to (url, name): registry id or validated model URL.
            let (target_url, name) = if !file_id.is_empty() {
                match ar::registry_get(file_id) {
                    Some(r) => (r.url, r.name),
                    None => {
                        return ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some("Onbekend file_id. Roep eerst list_files aan.".to_string()),
                        }
                    }
                }
            } else {
                if url.is_empty() {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some("Geen file_id of URL opgegeven.".to_string()),
                    };
                }
                if let Err(e) = ar::validate_attachment_url(url, &endpoint) {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(e),
                    };
                }
                let name = if filename.is_empty() {
                    url.split('?')
                        .next()
                        .unwrap_or(url)
                        .rsplit('/')
                        .next()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("bijlage")
                        .to_string()
                } else {
                    filename
                };
                (url.to_string(), name)
            };

            // Serve from cache when the same source was already extracted.
            if let Some(cached) = ar::cache_get(&cache_key, &target_url) {
                if offset > cached.total_chars {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(format!(
                            "Offset {} voorbij het einde ({} tekens).",
                            offset, cached.total_chars
                        )),
                    };
                }
                let (page, next_offset, total) = ar::page_text(&cached.text, offset, max_chars);
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: true,
                    data: serde_json::json!({
                        "name": cached.name,
                        "total_chars": total,
                        "offset": offset.min(total),
                        "next_offset": next_offset,
                        "text": page,
                        "truncated": cached.truncated,
                        "cached": true,
                    }),
                    error: None,
                };
            }

            // Pre-check by name: don't download what we can't read anyway.
            if let Some(reason) = ar::unsupported_reason(&name, "", true) {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: serde_json::json!({ "readable": false, "reason": reason }),
                    error: Some(reason),
                };
            }

            let (bytes, content_type, name) =
                match download_attachment(client, &endpoint, &target_url, &name).await {
                    Ok(v) => v,
                    Err(e) => {
                        return ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(e),
                        }
                    }
                };

            // Post-check with the real content type.
            if let Some(reason) = ar::unsupported_reason(&name, &content_type, true) {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: serde_json::json!({ "readable": false, "reason": reason }),
                    error: Some(reason),
                };
            }

            let raw = match ar::extract_text(&bytes, &name, &content_type) {
                Ok(t) => t,
                Err(e) => {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(e),
                    }
                }
            };
            if ar::is_empty_text(&raw) {
                let reason = "geen tekstlaag (gescand)".to_string();
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: serde_json::json!({ "readable": false, "reason": reason }),
                    error: Some(reason),
                };
            }
            let (capped, truncated) = ar::cap_extracted(raw);
            let total = capped.chars().count();
            if offset > total {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(format!(
                        "Offset {} voorbij het einde ({} tekens).",
                        offset, total
                    )),
                };
            }
            ar::cache_put(
                cache_key,
                ar::CachedText {
                    url: target_url,
                    name: name.clone(),
                    text: capped.clone(),
                    total_chars: total,
                    size_bytes: bytes.len(),
                    truncated,
                },
            );
            let (page, next_offset, _) = ar::page_text(&capped, offset, max_chars);
            ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({
                    "name": name,
                    "total_chars": total,
                    "offset": offset,
                    "next_offset": next_offset,
                    "text": page,
                    "truncated": truncated,
                }),
                error: None,
            }
        }

        "calculate_grade_scenario" => {
            use crate::ai::grade_calc::{
                average_for_grade, min_grade_for_pass, new_overall_average, predicted_average,
                predicted_end, required_grade, GradePoint, MinGradeForPass,
            };

            let decimal_points = args
                .get("decimal_points")
                .and_then(|v| v.as_i64())
                .unwrap_or(2)
                .max(0) as usize;

            let peildatum = args.get("peildatum").and_then(|v| v.as_str()).unwrap_or("");
            let today = crate::ai::time::today_amsterdam();
            let peil = if peildatum.len() >= 10 { &peildatum[0..10] } else { &today };

            // 1. Resolve the subject's current grades: explicit `grades` array,
            //    or fetched internally from the grade overview via schoolyear_id+subject.
            let (total_points, total_weight, grade_count, subject_name, all_subjects) =
                match resolve_scenario_grades(client, args, person_id, peil).await {
                    Ok(v) => v,
                    Err(e) => {
                        return ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(e),
                        };
                    }
                };

            // 2. Compute the requested scenario(s) with the same rules as the
            //    in-app calculator (grade_calc.rs is a port of predictor.ts).
            let target_average = args.get("target_average").and_then(|v| v.as_f64());
            let next_grade = args.get("next_grade").and_then(|v| v.as_f64());
            let next_grade_weight = args
                .get("next_grade_weight")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0);
            let remaining_tests = args.get("remaining_tests").and_then(|v| v.as_i64());
            let threshold = args.get("threshold").and_then(|v| v.as_f64());
            let simulation: Vec<GradePoint> = args
                .get("simulation_grades")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|g| {
                            let value = g
                                .get("value")
                                .and_then(|v| v.as_f64())
                                .or_else(|| g.get("cijfer").and_then(|v| v.as_f64()))
                                .or_else(|| {
                                    g.get("cijfer")
                                        .and_then(|v| v.as_str())
                                        .and_then(crate::ai::grade_calc::parse_dutch_grade)
                                })?;
                            let weight = g
                                .get("weight")
                                .and_then(|v| v.as_f64())
                                .or_else(|| g.get("weging").and_then(|v| v.as_f64()))
                                .unwrap_or(1.0);
                            Some(GradePoint { value, weight })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let include_simulation = args
                .get("include_simulation")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            let current_avg = if total_weight > 0.0 {
                total_points / total_weight
            } else {
                0.0
            };
            let num = |v: f64| -> Value {
                serde_json::Number::from_f64(v)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            };

            let mut result = serde_json::Map::new();
            result.insert("subject".to_string(), Value::String(subject_name.clone()));
            result.insert(
                "current_average".to_string(),
                Value::String(format!("{:.*}", decimal_points, current_avg)),
            );
            result.insert("current_average_numeric".to_string(), num(current_avg));
            result.insert("total_points".to_string(), num(total_points));
            result.insert("total_weight".to_string(), num(total_weight));
            result.insert("grade_count".to_string(), Value::Number(grade_count.into()));
            result.insert("peildatum".to_string(), Value::String(peil.to_string()));

            if let Some(target) = target_average {
                let req = required_grade(
                    total_points,
                    total_weight,
                    target,
                    next_grade_weight,
                    &simulation,
                    decimal_points,
                );
                result.insert("required_grade".to_string(), Value::String(req.clone()));
                if let Some(n) = req.parse::<f64>().ok() {
                    result.insert("required_grade_numeric".to_string(), num(n));
                }
                result.insert("target_average".to_string(), num(target));
                result.insert("required_grade_grade_weight".to_string(), num(next_grade_weight));
            }

            if let Some(ng) = next_grade {
                let mut sim_with_next = simulation.clone();
                sim_with_next.push(GradePoint { value: ng, weight: next_grade_weight });
                let pa = predicted_average(
                    total_points,
                    total_weight,
                    &sim_with_next,
                    include_simulation,
                    decimal_points,
                );
                result.insert("predicted_average".to_string(), Value::String(pa.clone()));
                if let Some(n) = pa.parse::<f64>().ok() {
                    result.insert("predicted_average_numeric".to_string(), num(n));
                }
                result.insert(
                    "average_for_grade".to_string(),
                    Value::String(average_for_grade(
                        total_points,
                        total_weight,
                        ng,
                        next_grade_weight,
                        decimal_points,
                    )),
                );
                result.insert("next_grade".to_string(), num(ng));
                result.insert("next_grade_weight".to_string(), num(next_grade_weight));

                if let Some(rt) = remaining_tests {
                    let rt_u = rt.max(0) as usize;
                    let pe = predicted_end(total_points, total_weight, rt_u, ng);
                    result.insert(
                        "predicted_end".to_string(),
                        Value::String(format!("{:.*}", decimal_points, pe)),
                    );
                    result.insert(
                        "predicted_end_remaining_tests".to_string(),
                        Value::Number(rt.into()),
                    );
                }

                if !all_subjects.is_empty() {
                    let replacement = pa.parse::<f64>().unwrap_or(current_avg);
                    let na = new_overall_average(
                        &all_subjects,
                        &subject_name,
                        replacement,
                        decimal_points,
                    );
                    result.insert("new_overall_average".to_string(), Value::String(na));
                }
            }

            if let Some(thr) = threshold {
                result.insert("threshold".to_string(), num(thr));
                let pass = min_grade_for_pass(total_points, total_weight, thr);
                let label = match pass {
                    MinGradeForPass::Needed(v) => v,
                    MinGradeForPass::AlreadyPassing => "already_passing".to_string(),
                    MinGradeForPass::Impossible => "impossible".to_string(),
                };
                result.insert("min_grade_for_pass".to_string(), Value::String(label));
            }

            ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: Value::Object(result),
                error: None,
            }
        }

        // Write tool: never create directly. Stage the action for explicit user
        // confirmation; the real POST only happens via confirm_pending_action.
        "create_calendar_event" => {
            let start = args.get("start").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let einde = args.get("einde").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let omschrijving = args
                .get("omschrijving")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if start.is_empty() || einde.is_empty() || omschrijving.is_empty() {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Start, einde en omschrijving zijn verplicht.".to_string()),
                };
            }

            let action_id = generate_action_id();
            let action = PendingAction {
                action_type: "create_calendar_event".to_string(),
                args: args.clone(),
                created_at: now_secs(),
            };
            if let Ok(mut store) = pending_actions.lock() {
                store.insert(action_id.clone(), action);
            }

            ToolResult {
                tool: tool_name.to_string(),
                success: true,
                data: serde_json::json!({
                    "status": "pending_user_confirmation",
                    "action_id": action_id,
                    "action_type": "create_calendar_event",
                    "start": start,
                    "einde": einde,
                    "omschrijving": omschrijving,
                    "message": "De agenda-afspraak is klaargezet en wacht op bevestiging door de gebruiker. Er is nog NIETS aangemaakt. Vertel de gebruiker dat er bevestiging nodig is."
                }),
                error: None,
            }
        }

        "download_file" => {
            use crate::ai::attachment_reader as ar;
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");

            if url.is_empty() {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some("Geen URL opgegeven.".to_string()),
                };
            }

            let endpoint = match api_endpoint_of(client) {
                Ok(e) => e,
                Err(e) => {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(e),
                    }
                }
            };
            if let Err(e) = ar::validate_attachment_url(url, &endpoint) {
                return ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e),
                };
            }

            // Magister's download/Self links are indirection links — resolve to the
            // real content URL first (same two-call sequence as before).
            let path = url.trim_start_matches("/api/");
            let resolved = match client.get_redirect_location(path).await {
                Ok(resolved) => resolved,
                Err(e) => {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(format!("Kon download-link niet resolven: {}", e)),
                    };
                }
            };
            let fetch_url = if resolved.trim().is_empty() {
                url.to_string()
            } else {
                if let Err(e) = ar::validate_attachment_url(&resolved, &endpoint) {
                    return ToolResult {
                        tool: tool_name.to_string(),
                        success: false,
                        data: Value::Null,
                        error: Some(e),
                    };
                }
                resolved
            };

            match client.get_bytes_with_content_type(&fetch_url).await {
                Ok((bytes, content_type, final_url)) => {
                    if let Err(e) = ar::validate_final_url(&final_url, &endpoint) {
                        return ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(e),
                        };
                    }
                    if bytes.len() > ar::MAX_DOWNLOAD_BYTES {
                        return ToolResult {
                            tool: tool_name.to_string(),
                            success: false,
                            data: Value::Null,
                            error: Some(format!(
                                "Bestand te groot ({:.1} MB, max 15 MB).",
                                bytes.len() as f64 / 1_048_576.0
                            )),
                        };
                    }
                    let size = bytes.len();
                    let data = serde_json::json!({
                        "url": url,
                        "size_bytes": size,
                        "size_mb": (size as f64) / 1_048_576.0,
                        "mime_type": content_type,
                        "capped": false,
                        "message": "Het bestand is gedownload. De AI kan de inhoud niet lezen, maar je kunt het openen via de link."
                    });
                    ToolResult {
                        tool: tool_name.to_string(),
                        success: true,
                        data,
                        error: None,
                    }
                }
                Err(e) => ToolResult {
                    tool: tool_name.to_string(),
                    success: false,
                    data: Value::Null,
                    error: Some(e.to_string()),
                },
            }
        }

        _ => ToolResult {
            tool: tool_name.to_string(), success: false, data: Value::Null,
            error: Some(format!("Onbekende tool: {}", tool_name)),
        },
    }
}

/// Execute a previously-staged action after the user confirmed it.
///
/// This is the ONLY path that performs real write operations on the user's
/// behalf (e.g. the Magister send-message endpoint). `execute_tool` only
/// stages actions; nothing with a real side effect ever runs without the user
/// tapping confirm on a pending action.
pub async fn execute_pending_action(
    client: &mut crate::client::MagisterClient,
    action: &PendingAction,
) -> Result<Value, String> {
    match action.action_type.as_str() {
        "send_message" => {
            let subject = action.args.get("subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let body = action.args.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let recipients = action.args.get("recipients").and_then(|v| v.as_array()).cloned().unwrap_or_default();

            let ontvangers: Vec<serde_json::Value> = recipients.iter().map(|r| {
                serde_json::json!({
                    "id": r.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                    "type": r.get("type").and_then(|v| v.as_str()).unwrap_or("leerling")
                })
            }).collect();

            let req_body = serde_json::json!({
                "ontvangers": ontvangers,
                "kopieOntvangers": [],
                "blindeKopieOntvangers": [],
                "heeftPrioriteit": false,
                "inhoud": body,
                "onderwerp": subject,
                "verzendOptie": "standaard",
                "bijlagen": []
            });

            client.post("berichten/verzenden", &req_body).await.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "status": "verzonden", "subject": subject }))
        }
        "mark_messages_read" => {
            let message_ids = action.args.get("message_ids")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect::<Vec<i64>>())
                .unwrap_or_default();

            let body = serde_json::json!({"BerichtIds": message_ids});
            client.put("berichten/gelezen", &body).await.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "status": "gemarkeerd", "aantal": message_ids.len() }))
        }
        "create_calendar_event" => {
            let person_id = client
                .token_set
                .as_ref()
                .and_then(|t| t.person_id)
                .ok_or_else(|| "Niet geauthenticeerd.".to_string())?;

            let start = action.args.get("start").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let einde = action.args.get("einde").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let duurt_hele_dag = action.args.get("duurt_hele_dag").and_then(|v| v.as_bool()).unwrap_or(false);
            let omschrijving = action.args.get("omschrijving").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let lokatie = action.args
                .get("lokatie")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let inhoud = action.args
                .get("inhoud")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            // Same Inhoud ↔ InfoType coherence rule as commands/calendar.rs:
            // live-probed 2026-09, content on Type 1 needs 6 (Informatie),
            // 0 when empty.
            let info_type = if inhoud.is_some() { 6 } else { 0 };

            let mut body = serde_json::json!({
                "Start": start,
                "Einde": einde,
                "DuurtHeleDag": duurt_hele_dag,
                "Omschrijving": omschrijving,
                "Type": 1,
                "Status": 2,
                "InfoType": info_type
            });
            // Omit (don't null) empty optionals — Magister validates
            // Inhoud/InfoType coherence on what is actually present.
            if let Some(ref l) = lokatie {
                body["Lokatie"] = serde_json::json!(l);
            }
            if let Some(ref i) = inhoud {
                body["Inhoud"] = serde_json::json!(i);
            }
            log::debug!("AI creating calendar event: {}", body);

            client.post(&format!("personen/{}/afspraken", person_id), &body)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "status": "aangemaakt", "omschrijving": omschrijving }))
        }
        _ => Err(format!("Onbekende actie: {}", action.action_type)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::MagisterClient;
    use chrono::Utc;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn mock_token_set(endpoint: &str) -> crate::client::TokenSet {
        crate::client::TokenSet {
            access_token: "mock_access_token".to_string(),
            id_token: "mock_id_token".to_string(),
            refresh_token: "mock_refresh_token".to_string(),
            expires_at: Utc::now() + chrono::Duration::seconds(3600),
            api_endpoint: endpoint.to_string(),
            person_id: Some(123),
            account_uuid: None,
        }
    }

    fn client_with_token(endpoint: &str) -> MagisterClient {
        let mut client = MagisterClient::new();
        client.token_set = Some(mock_token_set(endpoint));
        client
    }

    fn send_message_args() -> Value {
        serde_json::json!({
            "subject": "Vraag over huiswerk",
            "body": "Hallo! Wanneer moet het verslag ingeleverd worden?",
            "recipients": [
                { "id": 456, "type": "docent" }
            ]
        })
    }

    #[tokio::test]
    async fn send_message_stages_pending_action_without_sending() {
        let store: PendingActionStore = Mutex::new(HashMap::new());
        // No network configured at all — if execute_tool tried to POST, it
        // would fail (no token set), so success proves nothing was sent.
        let mut client = MagisterClient::new();

        let result = execute_tool(&mut client, "send_message", &send_message_args(), 123, &store).await;

        assert!(result.success, "expected pending result, got error: {:?}", result.error);
        assert_eq!(result.data["status"], "pending_user_confirmation");
        assert_eq!(result.data["action_type"], "send_message");
        assert_eq!(result.data["subject"], "Vraag over huiswerk");
        assert_eq!(result.data["body"], "Hallo! Wanneer moet het verslag ingeleverd worden?");

        // The staged action must be stored so confirm_pending_action can run it.
        let action_id = result.data["action_id"].as_str().expect("action_id present");
        let stored = store.lock().unwrap();
        let action = stored.get(action_id).expect("pending action stored");
        assert_eq!(action.action_type, "send_message");
    }

    #[tokio::test]
    async fn mark_messages_read_stages_pending_action_without_marking() {
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = MagisterClient::new();

        let args = serde_json::json!({ "message_ids": [10, 11] });
        let result = execute_tool(&mut client, "mark_messages_read", &args, 123, &store).await;

        assert!(result.success, "expected pending result, got error: {:?}", result.error);
        assert_eq!(result.data["status"], "pending_user_confirmation");
        assert_eq!(result.data["action_type"], "mark_messages_read");

        let action_id = result.data["action_id"].as_str().expect("action_id present");
        assert!(store.lock().unwrap().contains_key(action_id));
    }

    #[tokio::test]
    async fn confirm_send_message_posts_to_magister() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/berichten/verzenden"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());

        // Stage the action exactly like execute_tool would.
        let result = execute_tool(&mut client, "send_message", &send_message_args(), 123, &store).await;
        assert!(result.success);
        let action_id = result.data["action_id"].as_str().unwrap().to_string();

        let action = store.lock().unwrap().remove(&action_id).unwrap();
        let outcome = execute_pending_action(&mut client, &action).await.expect("send succeeds");
        assert_eq!(outcome["status"], "verzonden");
        assert_eq!(outcome["subject"], "Vraag over huiswerk");
    }

    #[tokio::test]
    async fn unknown_action_is_rejected() {
        let mut client = MagisterClient::new();
        let action = PendingAction {
            action_type: "nope".to_string(),
            args: serde_json::json!({}),
            created_at: now_secs(),
        };
        let outcome = execute_pending_action(&mut client, &action).await;
        assert!(outcome.is_err());
    }

    #[tokio::test]
    async fn read_attachment_text_returns_plain_text() {
        let mock_server = MockServer::start().await;
        let content_url = format!("{}/contents/opdracht", mock_server.uri());

        // Step 1: the attachment's indirection link resolves to the content URL.
        Mock::given(method("GET"))
            .and(path("/opdrachten/1/bijlagen/2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "location": content_url,
            })))
            .mount(&mock_server)
            .await;

        // Step 2: the resolved URL returns the file bytes.
        Mock::given(method("GET"))
            .and(path("/contents/opdracht"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(
                        "De opdracht is om een verslag te schrijven over de Tweede Wereldoorlog.",
                    )
                    .insert_header("Content-Type", "text/plain"),
            )
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());

        let args = serde_json::json!({
            "url": format!("{}/opdrachten/1/bijlagen/2", mock_server.uri()),
            "filename": "opdracht.txt"
        });
        let result = execute_tool(&mut client, "read_attachment_text", &args, 123, &store).await;

        assert!(result.success, "got error: {:?}", result.error);
        assert!(result.data["text"]
            .as_str()
            .unwrap()
            .contains("Tweede Wereldoorlog"));
    }

    #[tokio::test]
    async fn calculate_grade_scenario_with_explicit_grades() {
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = MagisterClient::new();

        let args = serde_json::json!({
            "grades": [
                { "value": 6.0, "weight": 1.0 },
                { "value": 7.0, "weight": 2.0 },
                { "value": 5.0, "weight": 1.0 }
            ],
            "target_average": 6.0,
            "next_grade": 8.0,
            "next_grade_weight": 1.0,
            "threshold": 5.5,
            "decimal_points": 2
        });
        let result = execute_tool(&mut client, "calculate_grade_scenario", &args, 123, &store).await;

        assert!(result.success, "got error: {:?}", result.error);
        // 6*1 + 7*2 + 5*1 = 25 points over weight 4 → avg 6.25
        assert_eq!(result.data["total_points"], 25.0);
        assert_eq!(result.data["total_weight"], 4.0);
        assert_eq!(result.data["current_average"], "6.25");
        // required for target 6.0 (next weight 1): (6.0*5 - 25)/1 = 5.00
        assert_eq!(result.data["required_grade"], "5.00");
        // predicted avg with next 8.0: (25 + 8)/5 = 6.60
        assert_eq!(result.data["predicted_average"], "6.60");
        // min grade to pass (threshold 5.5): (5.5*5 - 25)/1 = 2.5
        assert_eq!(result.data["min_grade_for_pass"], "2.5");
    }

    #[tokio::test]
    async fn calculate_grade_scenario_requires_grades_or_schoolyear() {
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = MagisterClient::new();
        let args = serde_json::json!({ "target_average": 6.0 });
        let result = execute_tool(&mut client, "calculate_grade_scenario", &args, 123, &store).await;
        assert!(!result.success);
        assert!(result.error.as_deref().unwrap().contains("grades"));
    }

    #[tokio::test]
    async fn create_calendar_event_stages_pending_action() {
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = MagisterClient::new();

        let args = serde_json::json!({
            "start": "2026-09-01T15:00:00",
            "einde": "2026-09-01T16:00:00",
            "omschrijving": "Werken aan verslag",
            "inhoud": "Hoofdstuk 3 afmaken"
        });
        let result = execute_tool(&mut client, "create_calendar_event", &args, 123, &store).await;

        assert!(result.success, "expected pending result, got error: {:?}", result.error);
        assert_eq!(result.data["status"], "pending_user_confirmation");
        assert_eq!(result.data["action_type"], "create_calendar_event");
        assert_eq!(result.data["omschrijving"], "Werken aan verslag");

        let action_id = result.data["action_id"].as_str().expect("action_id present");
        let stored = store.lock().unwrap();
        assert!(stored.contains_key(action_id));
    }

    #[tokio::test]
    async fn confirm_create_calendar_event_posts_to_magister() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/personen/123/afspraken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());

        let args = serde_json::json!({
            "start": "2026-09-01T15:00:00",
            "einde": "2026-09-01T16:00:00",
            "omschrijving": "Werken aan verslag"
        });
        let result = execute_tool(&mut client, "create_calendar_event", &args, 123, &store).await;
        assert!(result.success);

        let action_id = result.data["action_id"].as_str().unwrap().to_string();
        let action = store.lock().unwrap().remove(&action_id).unwrap();
        let outcome = execute_pending_action(&mut client, &action).await.expect("create succeeds");
        assert_eq!(outcome["status"], "aangemaakt");
        assert_eq!(outcome["omschrijving"], "Werken aan verslag");
    }

    #[tokio::test]
    async fn confirm_create_calendar_event_with_inhoud_uses_notitie_infotype() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/personen/123/afspraken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());

        let args = serde_json::json!({
            "start": "2026-09-01T15:00:00",
            "einde": "2026-09-01T16:00:00",
            "omschrijving": "Werken aan verslag",
            "inhoud": "Hoofdstuk 3 afmaken",
            "lokatie": "Thuis"
        });
        let result = execute_tool(&mut client, "create_calendar_event", &args, 123, &store).await;
        assert!(result.success);

        let action_id = result.data["action_id"].as_str().unwrap().to_string();
        let action = store.lock().unwrap().remove(&action_id).unwrap();
        execute_pending_action(&mut client, &action).await.expect("create succeeds");

        let requests = mock_server.received_requests().await.expect("requests recorded");
        assert_eq!(requests.len(), 1);
        let posted: serde_json::Value =
            serde_json::from_slice(&requests[0].body).expect("posted valid json");
        // Regression test for the 400 "ongeldig infotype": a content-bearing
        // personal appointment must use InfoType 6 (Informatie) — live-probed
        // 2026-09, every other value 400s.
        assert_eq!(posted["InfoType"], 6);
        assert_eq!(posted["Inhoud"], "Hoofdstuk 3 afmaken");
        assert_eq!(posted["Lokatie"], "Thuis");
    }

    #[tokio::test]
    async fn confirm_create_calendar_event_without_inhoud_omits_optional_fields() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/personen/123/afspraken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());

        let args = serde_json::json!({
            "start": "2026-09-01T15:00:00",
            "einde": "2026-09-01T16:00:00",
            "omschrijving": "Werken aan verslag",
            "inhoud": "   ",
            "lokatie": ""
        });
        let result = execute_tool(&mut client, "create_calendar_event", &args, 123, &store).await;
        assert!(result.success);

        let action_id = result.data["action_id"].as_str().unwrap().to_string();
        let action = store.lock().unwrap().remove(&action_id).unwrap();
        execute_pending_action(&mut client, &action).await.expect("create succeeds");

        let requests = mock_server.received_requests().await.expect("requests recorded");
        assert_eq!(requests.len(), 1);
        let posted: serde_json::Value =
            serde_json::from_slice(&requests[0].body).expect("posted valid json");
        assert_eq!(posted["InfoType"], 0);
        assert!(posted.get("Inhoud").is_none(), "blank Inhoud must be omitted, got {}", posted);
        assert!(posted.get("Lokatie").is_none(), "blank Lokatie must be omitted, got {}", posted);
    }

    // ─── Phase 2: windowing, pagination, budget ──────────────────────────

    fn lesson(id: i64, start: &str) -> Value {
        serde_json::json!({
            "Id": id,
            "Start": start,
            "Einde": "2026-09-21T09:20:00",
            "Type": 13,
            "Status": 2,
            "Vakken": [{"Naam": "Wiskunde"}],
            "Docenten": [{"Id": 9, "Docentcode": "JNS", "Naam": "Jan Jansen"}],
            "Lokalen": [{"Naam": "A101"}],
            "LesuurVan": 1,
            "Omschrijving": "Paragraaf 3.4",
            "Inhoud": null,
            "Afgerond": false,
        })
    }

    #[test]
    fn resolve_calendar_range_defaults_and_clamps() {
        let win = crate::ai::time::context_window("2026-10-02");
        let def = resolve_calendar_range("", "", "2026-10-02").expect("defaults resolve");
        assert_eq!(def.start, win.start);
        assert_eq!(def.effective_end, win.end);
        assert!(!def.clamped);

        let wide = resolve_calendar_range("2026-01-01", "2026-06-01", "2026-02-01").expect("wide resolves");
        assert!(wide.clamped);
        assert_eq!(wide.effective_end, "2026-03-04"); // Jan 1 + 62 days
        assert_eq!(wide.start, "2026-01-01");

        let exact = resolve_calendar_range("2026-01-01", "2026-03-04", "2026-02-01").expect("exact resolves");
        assert!(!exact.clamped);

        assert!(resolve_calendar_range("volgende week", "2026-09-27", "2026-09-21").is_err());
        assert!(resolve_calendar_range("2026-09-27", "2026-09-21", "2026-09-21").is_err());
    }

    #[test]
    fn paginate_slice_pages() {
        let items: Vec<Value> = (1..=5).map(|i| serde_json::json!(i)).collect();
        let (page, truncated, next) = paginate_slice(&items, 0, 2);
        assert_eq!(page, vec![serde_json::json!(1), serde_json::json!(2)]);
        assert!(truncated);
        assert_eq!(next, Some(2));
        let (last, truncated, next) = paginate_slice(&items, 4, 2);
        assert_eq!(last.len(), 1);
        assert!(!truncated);
        assert_eq!(next, None);
    }

    #[test]
    fn slim_calendar_item_shape() {
        let mut raw = lesson(7, "2026-09-21T08:30:00");
        raw["Omschrijving"] = Value::String("x".repeat(200));
        raw["Inhoud"] = Value::String("Maak opgave 1 t/m 10".to_string());
        let slim = slim_calendar_item(&raw);
        assert_eq!(slim["omschrijving"].as_str().unwrap().chars().count(), 121); // 120 + …
        assert_eq!(slim["huiswerk"], Value::Bool(true));
        assert!(slim.get("inhoud").is_none(), "inhoud lives behind the detail tool");
        assert_eq!(slim["docent"], Value::String("JNS".to_string()));
        assert_eq!(slim["date"], Value::String("2026-09-21".to_string()));

        let mut bare = lesson(8, "2026-09-21T08:30:00");
        bare["Afgerond"] = Value::Null;
        bare["Lokalen"] = Value::Array(vec![]);
        let slim_bare = slim_calendar_item(&bare);
        assert!(slim_bare.get("afgerond").is_none(), "nulls dropped");
        assert!(slim_bare.get("lokaal").is_none(), "empty lokalen dropped");
        assert_eq!(slim_bare["huiswerk"], Value::Bool(false));
    }

    #[test]
    fn cut_120_is_char_boundary_safe() {
        let emoji = "🎓".repeat(200);
        let cut = cut_120(&emoji);
        assert_eq!(cut.chars().count(), 121);
        assert!(cut.is_ascii() == false);
        assert_eq!(cut_120("kort"), "kort");
    }

    #[tokio::test]
    async fn calendar_events_default_window_requests_window() {
        let mock_server = MockServer::start().await;
        let today = crate::ai::time::today_amsterdam();
        let win = crate::ai::time::context_window(&today);

        Mock::given(method("GET"))
            .and(path("/personen/123/afspraken"))
            .and(query_param("van", win.start.as_str()))
            .and(query_param("tot", win.end.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "Items": [lesson(1, "2026-09-21T08:30:00")]
            })))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());
        // Empty args: the mock only matches the default-window query, so a
        // wrong range would 404 and fail the tool.
        let result = execute_tool(&mut client, "get_calendar_events", &serde_json::json!({}), 123, &store).await;
        assert!(result.success, "got error: {:?}", result.error);
        assert_eq!(result.data["items"][0]["docent"], "JNS");
        assert!(result.data["items"][0].get("inhoud").is_none());
        assert_eq!(result.data["meta"]["clamped"], false);
        assert_eq!(result.data["meta"]["total"], 1);
        assert_eq!(result.data["meta"]["window_default"]["start"], win.start.as_str());
    }

    #[tokio::test]
    async fn calendar_events_clamp_and_paginate_round_trip() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/personen/123/afspraken"))
            .and(query_param("van", "2026-01-01"))
            .and(query_param("tot", "2026-03-04"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "Items": [
                    lesson(1, "2026-01-06T08:30:00"),
                    lesson(2, "2026-01-05T08:30:00"),
                    lesson(3, "2026-01-07T08:30:00"),
                    lesson(4, "2026-01-05T10:30:00"),
                    lesson(5, "2026-01-06T10:30:00"),
                ]
            })))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());
        let mut seen: Vec<i64> = vec![];
        let mut offset: Option<i64> = Some(0);
        while let Some(off) = offset {
            let args = serde_json::json!({
                "start": "2026-01-01", "end": "2026-06-01", "offset": off, "limit": 2
            });
            let result = execute_tool(&mut client, "get_calendar_events", &args, 123, &store).await;
            assert!(result.success, "got error: {:?}", result.error);
            assert_eq!(result.data["meta"]["clamped"], true);
            assert_eq!(result.data["meta"]["effective"]["end"], "2026-03-04");
            for item in result.data["items"].as_array().unwrap() {
                seen.push(item["id"].as_i64().unwrap());
            }
            offset = result.data["meta"]["next_offset"].as_i64();
        }
        // Sorted by start despite storage order.
        assert_eq!(seen, vec![2, 4, 1, 5, 3]);
    }

    #[tokio::test]
    async fn calendar_event_detail_found_and_missing() {
        let mock_server = MockServer::start().await;
        let mut with_text = lesson(42, "2026-09-21T08:30:00");
        with_text["Inhoud"] = Value::String("Lees bladzijde 10 t/m 15".to_string());
        Mock::given(method("GET"))
            .and(path("/personen/123/afspraken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "Items": [with_text, lesson(43, "2026-09-21T10:30:00")]
            })))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());
        let result = execute_tool(
            &mut client,
            "get_calendar_event_detail",
            &serde_json::json!({ "id": 42, "date": "2026-09-21" }),
            123,
            &store,
        )
        .await;
        assert!(result.success, "got error: {:?}", result.error);
        assert_eq!(result.data["id"], 42);
        assert_eq!(result.data["inhoud"], "Lees bladzijde 10 t/m 15");
        assert_eq!(result.data["huiswerk"], Value::Bool(true));
        // Teacher names stay redacted in the detail view too.
        assert_eq!(result.data["docent"][0]["naam"], "JNS");

        let missing = execute_tool(
            &mut client,
            "get_calendar_event_detail",
            &serde_json::json!({ "id": 999, "date": "2026-09-21" }),
            123,
            &store,
        )
        .await;
        assert!(!missing.success);
        assert!(missing.error.unwrap().contains("niet gevonden op 2026-09-21"));
    }

    #[tokio::test]
    async fn calendar_page_stays_bounded() {
        let mock_server = MockServer::start().await;
        let lessons: Vec<Value> = (0..100)
            .map(|i| {
                let day = 21 + (i % 21);
                let mut l = lesson(1000 + i, &format!("2026-09-{:02}T08:30:00", day.min(30)));
                l["Omschrijving"] = Value::String(
                    "Paragraaf 3.4 opgaven 12 t/m 28 maken en leren voor het schriftelijk van volgende week".to_string(),
                );
                l["Inhoud"] = Value::String("Huiswerktekst die nooit in de lijst mag belanden. ".repeat(25));
                l
            })
            .collect();
        Mock::given(method("GET"))
            .and(path("/personen/123/afspraken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "Items": lessons })))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());
        let result = execute_tool(&mut client, "get_calendar_events", &serde_json::json!({}), 123, &store).await;
        assert!(result.success, "got error: {:?}", result.error);
        assert_eq!(result.data["items"].as_array().unwrap().len(), 60);
        assert_eq!(result.data["meta"]["total"], 100);
        assert_eq!(result.data["meta"]["next_offset"], 60);
        let bytes = serde_json::to_string(&result.data).unwrap().len();
        assert!(bytes < 20000, "bounded page, got {} bytes", bytes);
    }

    #[tokio::test]
    async fn grades_and_messages_report_total() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/personen/123/cijfers/laatste"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "Items": [{"Id": 1}] })))
            .mount(&mock_server)
            .await;
        Mock::given(method("GET"))
            .and(path("/berichten/mappen/alle"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "Items": [{"Id": 1, "Naam": "Postvak IN", "Links": [{"Href": "berichten/mappen/1/berichten"}]}]
            })))
            .mount(&mock_server)
            .await;
        Mock::given(method("GET"))
            .and(path("/berichten/mappen/1/berichten/berichten"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "Items": [{"Id": 2}] })))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());
        let grades = execute_tool(&mut client, "get_grades", &serde_json::json!({"top": 5}), 123, &store).await;
        assert!(grades.success);
        assert_eq!(grades.data["total"], 1);
        let msgs = execute_tool(&mut client, "get_messages", &serde_json::json!({}), 123, &store).await;
        assert!(msgs.success, "got error: {:?}", msgs.error);
        assert_eq!(msgs.data["total"], 1);
    }


    async fn mount_download_pair(server: &MockServer, indirection: &str, content_path: &str, body: &str) {
        let content_url = format!("{}{}", server.uri(), content_path);
        Mock::given(method("GET"))
            .and(path(indirection))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "location": content_url,
            })))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path(content_path))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(body)
                    .insert_header("Content-Type", "text/plain"),
            )
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn list_files_enumerates_three_sources_and_registers() {
        let mock_server = MockServer::start().await;

        // Assignments with raw Bijlagen (no detail fetch needed).
        Mock::given(method("GET"))
            .and(path("/personen/123/opdrachten"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "Items": [{
                    "Id": 7, "Titel": "Verslag", "Vak": "Nederlands",
                    "InleverenVoor": "2026-10-01",
                    "Bijlagen": [{ "Id": 9, "Naam": "opdracht.docx", "Url": "bijlagen/9", "Grootte": 1234 }],
                }]
            })))
            .mount(&mock_server)
            .await;
        // Messages: folder + top list with raw Bijlagen.
        Mock::given(method("GET"))
            .and(path("/berichten/mappen/alle"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "Items": [{ "Id": 1, "Naam": "Postvak IN", "Links": [{ "Href": "berichten/mappen/1/berichten" }] }]
            })))
            .mount(&mock_server)
            .await;
        Mock::given(method("GET"))
            .and(path("/berichten/mappen/1/berichten/berichten"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "Items": [{
                    "Id": 11, "Onderwerp": "Huiswerk", "DatumVerzonden": "2026-09-20T10:00:00",
                    "Bijlagen": [{ "Id": 12, "Naam": "info.pdf", "Url": "bijlagen/12" }],
                }]
            })))
            .mount(&mock_server)
            .await;
        // Lessons with raw Bijlagen.
        Mock::given(method("GET"))
            .and(path("/personen/123/afspraken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "Items": [{
                    "Id": 21, "Start": "2026-09-21T08:30:00",
                    "Vakken": [{ "Naam": "Wiskunde" }], "Omschrijving": "Wis",
                    "Bijlagen": [{ "Id": 22, "Naam": "blad.txt", "Url": "bijlagen/22" }],
                }]
            })))
            .mount(&mock_server)
            .await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());
        let result = execute_tool(&mut client, "list_files", &serde_json::json!({}), 123, &store).await;
        assert!(result.success, "got error: {:?}", result.error);
        let files = result.data["files"].as_array().unwrap();
        assert_eq!(files.len(), 3);
        assert_eq!(files[0]["file_id"], "a:7:9");
        assert_eq!(files[0]["source"], "assignment");
        assert_eq!(files[0]["context"]["subject"], "Nederlands");
        assert_eq!(files[0]["context"]["due"], "2026-10-01");
        assert_eq!(files[1]["file_id"], "m:11:12");
        assert_eq!(files[2]["file_id"], "l:21:22");
        assert_eq!(files[2]["context"]["date"], "2026-09-21");
        for f in files {
            assert_eq!(f["readable"], true);
        }
        // Registry round-trip: the listed id resolves.
        assert!(crate::ai::attachment_reader::registry_get("a:7:9").is_some());

        // Scope + subject filters.
        let scoped = execute_tool(
            &mut client,
            "list_files",
            &serde_json::json!({ "scope": "message" }),
            123,
            &store,
        )
        .await;
        assert_eq!(scoped.data["files"].as_array().unwrap().len(), 1);
        let filtered = execute_tool(
            &mut client,
            "list_files",
            &serde_json::json!({ "subject": "wis" }),
            123,
            &store,
        )
        .await;
        let ff = filtered.data["files"].as_array().unwrap();
        assert_eq!(ff.len(), 1);
        assert_eq!(ff[0]["source"], "lesson");
    }

    #[tokio::test]
    async fn read_by_file_id_pages_and_caches() {
        let mock_server = MockServer::start().await;
        let body = "0123456789".repeat(2000); // 20000 chars
        mount_download_pair(&mock_server, "/tbijlagen/99", "/tcontents/99", &body).await;

        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());
        // Register manually (as list_files would).
        crate::ai::attachment_reader::registry_put(
            "t:99:1".to_string(),
            crate::ai::attachment_reader::FileRef {
                url: "tbijlagen/99".to_string(),
                name: "tblad.txt".to_string(),
                source: "lesson".to_string(),
            },
        );
        let first = execute_tool(
            &mut client,
            "read_attachment_text",
            &serde_json::json!({ "file_id": "t:99:1", "offset": 5000, "max_chars": 100 }),
            123,
            &store,
        )
        .await;
        assert!(first.success, "got error: {:?}", first.error);
        assert_eq!(first.data["total_chars"], 20000);
        assert_eq!(first.data["offset"], 5000);
        assert_eq!(first.data["next_offset"], 5100);
        assert_eq!(first.data["text"].as_str().unwrap().chars().count(), 100);
        assert_eq!(first.data.get("cached"), None);
        // Second read serves from cache (same shape + cached flag).
        let second = execute_tool(
            &mut client,
            "read_attachment_text",
            &serde_json::json!({ "file_id": "t:99:1", "offset": 0, "max_chars": 10 }),
            123,
            &store,
        )
        .await;
        assert!(second.success);
        assert_eq!(second.data["cached"], true);
        assert_eq!(second.data["total_chars"], 20000);
        // Unknown id + past-end offset fail cleanly.
        let unknown = execute_tool(
            &mut client,
            "read_attachment_text",
            &serde_json::json!({ "file_id": "x:0:0" }),
            123,
            &store,
        )
        .await;
        assert!(!unknown.success);
        let over = execute_tool(
            &mut client,
            "read_attachment_text",
            &serde_json::json!({ "file_id": "t:99:1", "offset": 99999 }),
            123,
            &store,
        )
        .await;
        assert!(!over.success);
    }

    #[tokio::test]
    async fn foreign_and_tricky_urls_rejected() {
        let mock_server = MockServer::start().await;
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());
        for url in [
            "https://evil.example.com/bijlage.pdf".to_string(),
            format!("{}@evil.com/x", mock_server.uri()),
            "file:///etc/passwd".to_string(),
        ] {
            let r = execute_tool(
                &mut client,
                "read_attachment_text",
                &serde_json::json!({ "url": url, "filename": "x.pdf" }),
                123,
                &store,
            )
            .await;
            assert!(!r.success, "should reject {}", url);
        }
        // Same for download_file.
        let d = execute_tool(
            &mut client,
            "download_file",
            &serde_json::json!({ "url": "https://evil.example.com/f.pdf" }),
            123,
            &store,
        )
        .await;
        assert!(!d.success);
    }

    #[tokio::test]
    async fn download_rejects_oversize() {
        let mock_server = MockServer::start().await;
        let big = "b".repeat(16 * 1024 * 1024);
        mount_download_pair(&mock_server, "/bijlagen/big", "/contents/big", &big).await;
        // Note: space in path to keep it distinct; wiremock matches exactly.
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());
        let r = execute_tool(
            &mut client,
            "download_file",
            &serde_json::json!({ "url": "bijlagen/big" }),
            123,
            &store,
        )
        .await;
        assert!(!r.success);
        assert!(r.error.unwrap().contains("15 MB"));
    }

    #[tokio::test]
    async fn unsupported_file_reports_readable_false() {
        let mock_server = MockServer::start().await;
        mount_download_pair(&mock_server, "/bijlagen/7", "/contents/7", "fake-png-bytes").await;
        let store: PendingActionStore = Mutex::new(HashMap::new());
        let mut client = client_with_token(&mock_server.uri());
        // Bypass registry with a direct png URL (same host passes validation).
        let url = format!("{}/bijlagen/7", mock_server.uri());
        // Mock the indirection for the absolute URL path as well.
        Mock::given(method("GET"))
            .and(path("/bijlagen/7"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "location": format!("{}/contents/7", mock_server.uri()),
            })))
            .mount(&mock_server)
            .await;
        let r = execute_tool(
            &mut client,
            "read_attachment_text",
            &serde_json::json!({ "url": url, "filename": "foto.png" }),
            123,
            &store,
        )
        .await;
        assert!(!r.success);
        assert_eq!(r.data["readable"], false);
        assert!(r.data["reason"].as_str().unwrap().contains("afbeeldingen"));
    }
}