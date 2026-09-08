use std::path::PathBuf;
use std::sync::Arc;

use rand::RngExt;
use serde_json::Value;
use tauri::{AppHandle, State};
use tokio::sync::RwLock;

use crate::client::SharedClient;
use crate::models::ai_schedule::{AiScheduleItem, AiScheduleStatus, DurationSource, MergedSchedule};

/// Managed state for AI schedule persistence.
pub struct AiScheduleState {
    pub items: Arc<RwLock<Vec<AiScheduleItem>>>,
    pub path: PathBuf,
}

impl AiScheduleState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let path = app_data_dir.join("ai_schedule.json");
        let items = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str::<Vec<AiScheduleItem>>(&s).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Self {
            items: Arc::new(RwLock::new(items)),
            path,
        }
    }

    fn save_sync(&self, items: &[AiScheduleItem]) {
        let _ = std::fs::create_dir_all(self.path.parent().unwrap_or(&PathBuf::from(".")));
        if let Ok(json) = serde_json::to_string_pretty(items) {
            let _ = std::fs::write(&self.path, json);
        }
    }

    pub fn save(&self, items: &[AiScheduleItem]) {
        self.save_sync(items);
    }
}

fn now_iso() -> String {
    chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn validate_item(item: &AiScheduleItem) -> Result<(), String> {
    if item.title.trim().is_empty() {
        return Err("Titel is verplicht.".to_string());
    }
    if !(1..=5).contains(&item.urgency) {
        return Err("Urgency moet tussen 1 en 5 zijn.".to_string());
    }
    // Validate start < end
    let s = crate::ai::schedule::iso_to_naive(&item.start).ok_or("Ongeldige start datum (verwacht ISO 8601).".to_string())?;
    let e = crate::ai::schedule::iso_to_naive(&item.end).ok_or("Ongeldige eind datum (verwacht ISO 8601).".to_string())?;
    if e <= s {
        return Err("Eind moet na start liggen.".to_string());
    }
    Ok(())
}

/// Guardrail: no two plannable AI items may occupy the same time.
/// FreeTime/Sleep are background fillers and are exempt (they get regenerated).
/// Dismissed/Completed items are history and are exempt.
fn find_overlap(existing: &[AiScheduleItem], start: &str, end: &str, ignore_id: Option<&str>) -> Option<String> {
    use crate::models::ai_schedule::AiScheduleItemType;
    for it in existing {
        if let Some(ign) = ignore_id {
            if it.id == ign {
                continue;
            }
        }
        if it.item_type == AiScheduleItemType::FreeTime || it.item_type == AiScheduleItemType::Sleep {
            continue;
        }
        if it.status == AiScheduleStatus::Dismissed || it.status == AiScheduleStatus::Completed {
            continue;
        }
        if crate::ai::schedule::intervals_overlap_str(start, end, &it.start, &it.end) {
            return Some(it.id.clone());
        }
    }
    None
}

#[tauri::command]
pub async fn get_ai_schedule(
    state: State<'_, AiScheduleState>,
    start: String,
    end: String,
) -> Result<Vec<AiScheduleItem>, String> {
    let s = crate::ai::schedule::iso_to_naive(&start).ok_or("Ongeldige start datum".to_string())?;
    let e = crate::ai::schedule::iso_to_naive(&end).ok_or("Ongeldige eind datum".to_string())?;
    let items = state.items.read().await;
    let filtered: Vec<AiScheduleItem> = items
        .iter()
        .filter(|item| {
            if let (Some(is), Some(ie)) = (
                crate::ai::schedule::iso_to_naive(&item.start),
                crate::ai::schedule::iso_to_naive(&item.end),
            ) {
                // Overlaps [s, e]
                ie >= s && is <= e
            } else {
                false
            }
        })
        .cloned()
        .collect();
    Ok(filtered)
}

#[tauri::command]
pub async fn create_ai_schedule_item(
    state: State<'_, AiScheduleState>,
    mut item: AiScheduleItem,
) -> Result<AiScheduleItem, String> {
    if item.id.trim().is_empty() {
        let r: u32 = rand::rng().random();
        item.id = format!("ai-{}-{}", chrono::Utc::now().timestamp_millis(), r);
    }
    let now = now_iso();
    if item.created_at.is_empty() {
        item.created_at = now.clone();
    }
    item.updated_at = now.clone();
    if item.status == AiScheduleStatus::Completed && item.completed_at.is_none() {
        item.completed_at = Some(now.clone());
    }
    validate_item(&item)?;

    // Idempotent: same id already exists -> return existing instead of duplicating.
    // This makes double-clicks / retries safe.
    {
        let items = state.items.read().await;
        if let Some(existing) = items.iter().find(|i| i.id == item.id) {
            return Ok(existing.clone());
        }
        // Same assignment already planned at overlapping time -> don't duplicate.
        if item.related_assignment_id.is_some() || item.related_calendar_event_id.is_some() {
            for it in items.iter() {
                let same_assign = item.related_assignment_id.is_some()
                    && it.related_assignment_id == item.related_assignment_id;
                let same_cal = item.related_calendar_event_id.is_some()
                    && it.related_calendar_event_id == item.related_calendar_event_id;
                if (same_assign || same_cal)
                    && it.status != AiScheduleStatus::Dismissed
                    && crate::ai::schedule::intervals_overlap_str(&item.start, &item.end, &it.start, &it.end)
                {
                    return Ok(it.clone());
                }
            }
        }
        // Guardrail: refuse overlapping planning.
        if let Some(conflict) = find_overlap(&items, &item.start, &item.end, None) {
            return Err(format!(
                "Overlap: er staat al '{}' gepland op dit tijdstip. Kies een ander tijdstip.",
                conflict
            ));
        }
    }

    let mut items = state.items.write().await;
    // Re-check under write lock (race between read and write).
    if let Some(existing) = items.iter().find(|i| i.id == item.id) {
        return Ok(existing.clone());
    }
    if let Some(conflict) = find_overlap(&items, &item.start, &item.end, None) {
        return Err(format!(
            "Overlap: er staat al '{}' gepland op dit tijdstip. Kies een ander tijdstip.",
            conflict
        ));
    }
    items.push(item.clone());
    state.save(&items);
    Ok(item)
}

#[tauri::command]
pub async fn update_ai_schedule_item(
    state: State<'_, AiScheduleState>,
    item: AiScheduleItem,
) -> Result<AiScheduleItem, String> {
    validate_item(&item)?;
    let mut items = state.items.write().await;
    let idx = items.iter().position(|i| i.id == item.id).ok_or_else(|| format!("Item '{}' niet gevonden.", item.id))?;
    // Guardrail: moving/resizing onto another planned item is refused.
    if let Some(conflict) = find_overlap(&items, &item.start, &item.end, Some(&item.id)) {
        return Err(format!(
            "Overlap: er staat al '{}' gepland op dit tijdstip. Kies een ander tijdstip.",
            conflict
        ));
    }
    let mut updated = item.clone();
    updated.updated_at = now_iso();
    if updated.status == AiScheduleStatus::Completed && updated.completed_at.is_none() {
        updated.completed_at = Some(updated.updated_at.clone());
    }
    if updated.status != AiScheduleStatus::Completed {
        updated.completed_at = None;
    }
    // Any manual edit via this command promotes AiChat -> User so the next
    // "Update AI Schedule" treats it as a fixed constraint instead of
    // silently rearranging it.
    if updated.source == crate::models::ai_schedule::AiScheduleSource::AiChat {
        updated.source = crate::models::ai_schedule::AiScheduleSource::User;
    }
    items[idx] = updated.clone();
    state.save(&items);
    Ok(updated)
}

#[tauri::command]
pub async fn delete_ai_schedule_item(
    state: State<'_, AiScheduleState>,
    id: String,
) -> Result<(), String> {
    let mut items = state.items.write().await;
    let before = items.len();
    items.retain(|i| i.id != id);
    if items.len() == before {
        return Err(format!("Item '{}' niet gevonden.", id));
    }
    state.save(&items);
    Ok(())
}

#[tauri::command]
pub async fn complete_ai_schedule_item(
    state: State<'_, AiScheduleState>,
    id: String,
) -> Result<(), String> {
    let mut items = state.items.write().await;
    let item = items.iter_mut().find(|i| i.id == id).ok_or_else(|| format!("Item '{}' niet gevonden.", id))?;
    item.status = AiScheduleStatus::Completed;
    let now = now_iso();
    item.completed_at = Some(now.clone());
    item.updated_at = now;
    let snapshot = items.clone();
    state.save(&snapshot);
    Ok(())
}

#[tauri::command]
pub async fn dismiss_ai_schedule_item(
    state: State<'_, AiScheduleState>,
    id: String,
) -> Result<(), String> {
    let mut items = state.items.write().await;
    let item = items.iter_mut().find(|i| i.id == id).ok_or_else(|| format!("Item '{}' niet gevonden.", id))?;
    item.status = AiScheduleStatus::Dismissed;
    item.updated_at = now_iso();
    let snapshot = items.clone();
    state.save(&snapshot);
    Ok(())
}

#[tauri::command]
pub async fn get_merged_schedule(
    state: State<'_, AiScheduleState>,
    client: State<'_, SharedClient>,
    person_id: i64,
    start: String,
    end: String,
) -> Result<MergedSchedule, String> {
    // Need to avoid holding lock across await that calls Magister client.
    // First, read AI items (clone) without holding across fetch.
    let ai_items: Vec<AiScheduleItem> = {
        let s = crate::ai::schedule::iso_to_naive(&start).ok_or("Ongeldige start datum".to_string())?;
        let e = crate::ai::schedule::iso_to_naive(&end).ok_or("Ongeldige eind datum".to_string())?;
        let items = state.items.read().await;
        items
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
            .cloned()
            .collect()
    };

    // Fetch Magister events (read-only) – try, but don't fail whole merged schedule on connectivity
    let magister_events = match fetch_magister_events(client, person_id, &start, &end).await {
        Ok(ev) => ev,
        Err(e) => {
            log::warn!("get_merged_schedule: failed to fetch Magister events (using empty, error: {})", e);
            Vec::new()
        }
    };

    Ok(MergedSchedule {
        magister_events,
        ai_items,
    })
}

async fn fetch_magister_events(
    client: State<'_, SharedClient>,
    person_id: i64,
    start: &str,
    end: &str,
) -> Result<Vec<crate::models::calendar::CalendarEvent>, String> {
    let start_date = if start.len() >= 10 { &start[0..10] } else { start };
    let end_date = if end.len() >= 10 { &end[0..10] } else { end };
    let events_url = format!("personen/{}/afspraken?tot={}&van={}", person_id, end_date, start_date);
    let events_data = crate::client::get_with_shared(&client, &events_url).await.map_err(|e| e.to_string())?;
    let events_resp: crate::models::calendar::CalendarEventsResponse =
        serde_json::from_value(events_data).map_err(|e| e.to_string())?;

    // Note: we skip absences merging for merged schedule (not critical); could add
    Ok(events_resp.items)
}

async fn fetch_magister_events_inner(
    client: SharedClient,
    person_id: i64,
    start: &str,
    end: &str,
) -> Result<Vec<crate::models::calendar::CalendarEvent>, String> {
    let start_date = if start.len() >= 10 { &start[0..10] } else { start };
    let end_date = if end.len() >= 10 { &end[0..10] } else { end };
    let events_url = format!("personen/{}/afspraken?tot={}&van={}", person_id, end_date, start_date);
    let events_data = crate::client::get_with_shared(&client, &events_url).await.map_err(|e| e.to_string())?;
    let events_resp: crate::models::calendar::CalendarEventsResponse =
        serde_json::from_value(events_data).map_err(|e| e.to_string())?;
    Ok(events_resp.items)
}

async fn fetch_assignments_inner(
    client: SharedClient,
    person_id: i64,
    start: &str,
    end: &str,
) -> Result<Vec<Value>, String> {
    let start_date = if start.len() >= 10 { &start[0..10] } else { start };
    let end_date = if end.len() >= 10 { &end[0..10] } else { end };
    let path = format!("personen/{}/opdrachten?van={}&tot={}", person_id, start_date, end_date);
    let data = crate::client::get_with_shared(&client, &path).await.map_err(|e| e.to_string())?;
    let items = data.get("Items").or_else(|| data.get("items")).cloned().unwrap_or(Value::Array(vec![]));
    Ok(items.as_array().cloned().unwrap_or_default())
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct BlockedTimeInput {
    pub day: String,
    pub start: String,
    pub end: String,
}

/// Inner planning logic shared between the manual button command and the AI tool `run_update_ai_schedule`.
pub async fn perform_update_inner(
    schedule_state: &AiScheduleState,
    client: SharedClient,
    person_id: i64,
    settings: crate::ai::schedule::ScheduleSettings,
) -> Result<Vec<AiScheduleItem>, String> {
    // Determine planning window: today through coming Sunday + next week (Europe/Amsterdam)
    let today = chrono::Local::now().date_naive();
    let (window_start, window_end) = crate::ai::schedule::planning_window(today);
    let window_start_str = window_start.format("%Y-%m-%d").to_string();
    let window_end_str = window_end.format("%Y-%m-%d").to_string();

    // Snapshot existing items before any await
    let existing_items: Vec<AiScheduleItem> = {
        let items = schedule_state.items.read().await;
        items.clone()
    };

    // Fetch real Magister data: calendar + assignments.
    // Do not hold ai_schedule lock across these awaits.
    // Assignments: fetch BROAD range (same as Assignments page: 2013-01-01
    // to +365d) then filter locally by deadline/open state. The narrow
    // window query misses assignments whose creation falls outside the
    // window but whose deadline is inside it — that's why planning only
    // ever produced sleep/free-time.
    let (lessons, assignments_raw) = {
        let lessons = fetch_magister_events_inner(client.clone(), person_id, &window_start_str, &window_end_str)
            .await
            .unwrap_or_default();

        let broad_end = (chrono::Local::now().date_naive() + chrono::Duration::days(365))
            .format("%Y-%m-%d")
            .to_string();
        let assignments = match fetch_assignments_inner(client.clone(), person_id, "2013-01-01", &broad_end).await {
            Ok(v) => v,
            Err(e) => {
                log::warn!("update_ai_schedule: assignments fetch failed: {}", e);
                Vec::new()
            }
        };
        log::info!(
            "update_ai_schedule: {} lessons, {} raw assignments (window {}..{})",
            lessons.len(),
            assignments.len(),
            window_start_str,
            window_end_str
        );
        (lessons, assignments)
    };

    // Determine locked items: Completed/Dismissed, or User source, or InProgress
    // Only Planned AI items are freely rearrangeable; FreeTime is always rearrangeable.
    let locked_items: Vec<AiScheduleItem> = existing_items
        .iter()
        .filter(|item| {
            // Check if item is in window
            let s = crate::ai::schedule::iso_to_naive(&item.start);
            let e = crate::ai::schedule::iso_to_naive(&item.end);
            if s.is_none() || e.is_none() {
                return false;
            }
            let s = s.unwrap().date();
            let e_date = e.unwrap().date();
            if e_date < window_start || s > window_end {
                return false;
            }
            // Locked if: Completed, Dismissed, InProgress, or source User, or Custom that is manually created
            // FreeTime and Sleep are never locked here (they will be regenerated)
            if item.item_type == crate::models::ai_schedule::AiScheduleItemType::FreeTime
                || item.item_type == crate::models::ai_schedule::AiScheduleItemType::Sleep
            {
                return false;
            }
            if item.status == AiScheduleStatus::Completed || item.status == AiScheduleStatus::Dismissed {
                return true;
            }
            if item.status == AiScheduleStatus::InProgress {
                return true;
            }
            if item.source == crate::models::ai_schedule::AiScheduleSource::User {
                return true;
            }
            false
        })
        .cloned()
        .collect();

    // Build duration_map from existing items: assignment_id -> (minutes, source)
    // Use UserEntered durations where available, else SubjectAverage or previous AiEstimated
    let mut duration_map: std::collections::HashMap<i64, (u32, DurationSource)> = std::collections::HashMap::new();
    for item in &existing_items {
        if let (Some(aid), Some(mins), Some(src)) = (
            item.related_assignment_id,
            item.estimated_minutes,
            item.duration_source.clone(),
        ) {
            // Prefer UserEntered over others
            let entry = duration_map.entry(aid).or_insert((mins, src.clone()));
            if src == DurationSource::UserEntered && entry.1 != DurationSource::UserEntered {
                *entry = (mins, src);
            }
        }
        // Also handle items where duration was set via set_homework_duration (stored on item)
        // Items with related_assignment_id but no source yet: still use mins
        if let (Some(aid), Some(mins)) = (item.related_assignment_id, item.estimated_minutes) {
            duration_map.entry(aid).or_insert((mins, item.duration_source.clone().unwrap_or(DurationSource::AiEstimated)));
        }
    }

    // Also need to consider open assignments not yet in duration_map – they will trigger HomeworkReview

    // Convert assignments_raw (Value) to AssignmentInput
    let assignment_inputs: Vec<crate::ai::schedule::AssignmentInput> = assignments_raw
        .iter()
        .filter_map(|v| {
            let id = v.get("Id").or_else(|| v.get("id")).and_then(|x| x.as_i64())?;
            let titel = v
                .get("Titel")
                .or_else(|| v.get("titel"))
                .or_else(|| v.get("title"))
                .and_then(|x| x.as_str())
                .unwrap_or("Opdracht")
                .to_string();
            let vak = v.get("Vak").or_else(|| v.get("vak")).and_then(|x| x.as_str()).map(|s| s.to_string());
            let inleveren_voor = v
                .get("InleverenVoor")
                .or_else(|| v.get("inleveren_voor"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if inleveren_voor.is_empty() {
                return None;
            }
            let omschrijving = v.get("Omschrijving").or_else(|| v.get("omschrijving")).and_then(|x| x.as_str()).map(|s| s.to_string());
            // Filter to open assignments only: not closed/submitted? Check Afgesloten etc.
            let afgesloten = v.get("Afgesloten").or_else(|| v.get("afgesloten")).and_then(|x| x.as_bool()).unwrap_or(false);
            let ingeleverd = v.get("IngeleverdOp").or_else(|| v.get("ingeleverd_op")).and_then(|x| x.as_str()).is_some();
            if afgesloten || ingeleverd {
                // If already submitted/closed, maybe still need review? But for now skip closed
                // Keep if manually not closed? We'll skip submitted to avoid planning done work.
                // However assignments overdue but not submitted should still be planned.
                // We'll keep logic: skip if afgesloten
                if afgesloten {
                    return None;
                }
            }
            Some(crate::ai::schedule::AssignmentInput {
                id,
                titel,
                vak,
                inleveren_voor,
                omschrijving,
            })
        })
        .collect();

    // Generate plan with caller-provided settings (bedtime/wake/blocked)
    let new_items = crate::ai::schedule::generate_plan(
        window_start,
        window_end,
        &lessons,
        &locked_items,
        &assignment_inputs,
        &existing_items,
        &settings,
        &duration_map,
    );
    log::info!(
        "update_ai_schedule: {} existing, {} locked, {} assignments -> {} new items",
        existing_items.len(),
        locked_items.len(),
        assignment_inputs.len(),
        new_items.len()
    );

    // Now mutate state: prune old Completed/Dismissed past items outside window? Spec: on each Update, items with status Completed/Dismissed and end in past can be pruned.
    // We'll do pruning, then remove old rearrangeable items in window (Planned AiChat not locked, plus Sleep/FreeTime), then insert new_items.
    {
        let mut items = schedule_state.items.write().await;
        let now = chrono::Local::now().naive_local();
        // Prune old completed/dismissed with end in past
        items.retain(|item| {
            if (item.status == AiScheduleStatus::Completed || item.status == AiScheduleStatus::Dismissed)
                && crate::ai::schedule::iso_to_naive(&item.end).map(|e| e < now).unwrap_or(false)
                && crate::ai::schedule::iso_to_naive(&item.end)
                    .map(|e| e.date() < window_start)
                    .unwrap_or(false)
            {
                // Keep if very recent? Spec says can be pruned if end in past – keep simple: remove
                false
            } else {
                true
            }
        });

        // Remove existing rearrangeable items in window (Planned AiChat etc, plus all Sleep/FreeTime in window)
        items.retain(|item| {
            let s_date = crate::ai::schedule::iso_to_naive(&item.start).map(|d| d.date());
            let e_date = crate::ai::schedule::iso_to_naive(&item.end).map(|d| d.date());
            let in_window = match (s_date, e_date) {
                (Some(s), Some(e)) => e >= window_start && s <= window_end,
                _ => false,
            };
            if !in_window {
                return true; // keep outside window
            }
            // If locked, keep
            if locked_items.iter().any(|li| li.id == item.id) {
                return true;
            }
            // If FreeTime/Sleep, remove (will be regenerated)
            if item.item_type == crate::models::ai_schedule::AiScheduleItemType::FreeTime
                || item.item_type == crate::models::ai_schedule::AiScheduleItemType::Sleep
            {
                return false;
            }
            // If Planned and source AiChat, remove (rearrangeable)
            if item.status == AiScheduleStatus::Planned && item.source == crate::models::ai_schedule::AiScheduleSource::AiChat {
                return false;
            }
            // Keep User items, InProgress, etc. (already handled locked check)
            true
        });

        // Insert new items idempotently:
        // - same id already present -> skip (no duplicate on re-press)
        // - same assignment/calendar link already planned at overlapping time -> skip
        // - overlaps any kept (locked) item -> skip (guardrail: never double-book)
        for new in new_items {
            if items.iter().any(|i| i.id == new.id) {
                continue;
            }
            let same_link = items.iter().any(|i| {
                if i.status == AiScheduleStatus::Dismissed {
                    return false;
                }
                let same_assign = new.related_assignment_id.is_some()
                    && i.related_assignment_id == new.related_assignment_id;
                let same_cal = new.related_calendar_event_id.is_some()
                    && i.related_calendar_event_id == new.related_calendar_event_id;
                (same_assign || same_cal)
                    && crate::ai::schedule::intervals_overlap_str(&new.start, &new.end, &i.start, &i.end)
            });
            if same_link {
                continue;
            }
            if find_overlap(&items, &new.start, &new.end, None).is_some() {
                // Guardrail: would double-book an already planned time — skip.
                log::warn!("update_ai_schedule: skipping '{}' ({}..{}) — overlaps existing", new.id, new.start, new.end);
                continue;
            }
            items.push(new);
        }

        // Save
        schedule_state.save(&items);
        // Return merged-like result: filtered to window
        let filtered: Vec<AiScheduleItem> = items
            .iter()
            .filter(|item| {
                if let (Some(s), Some(e)) = (
                    crate::ai::schedule::iso_to_naive(&item.start),
                    crate::ai::schedule::iso_to_naive(&item.end),
                ) {
                    let sd = s.date();
                    let ed = e.date();
                    ed >= window_start && sd <= window_end
                } else {
                    false
                }
            })
            .cloned()
            .collect();
        return Ok(filtered);
    }
}

#[tauri::command]
pub async fn update_ai_schedule(
    state: State<'_, AiScheduleState>,
    client: State<'_, SharedClient>,
    bedtime: Option<String>,
    wake_time: Option<String>,
    blocked_times: Option<Vec<BlockedTimeInput>>,
    after_school_buffer_min: Option<u32>,
    plan_in_school_gaps: Option<bool>,
) -> Result<Vec<AiScheduleItem>, String> {
    let person_id = {
        let c = client.lock().await;
        c.token_set
            .as_ref()
            .and_then(|t| t.person_id)
            .ok_or_else(|| "Niet geauthentiseerd.".to_string())?
    };
    let defaults = crate::ai::schedule::ScheduleSettings::default();
    let settings = crate::ai::schedule::ScheduleSettings {
        bedtime: bedtime.unwrap_or(defaults.bedtime),
        wake_time: wake_time.unwrap_or(defaults.wake_time),
        blocked_times: blocked_times
            .unwrap_or_default()
            .into_iter()
            .map(|b| crate::ai::schedule::BlockedTime {
                day: b.day,
                start: b.start,
                end: b.end,
            })
            .collect(),
        after_school_buffer_min: after_school_buffer_min
            .unwrap_or(defaults.after_school_buffer_min),
        plan_in_school_gaps: plan_in_school_gaps.unwrap_or(defaults.plan_in_school_gaps),
    };
    let client_clone = (*client).clone();
    perform_update_inner(&state, client_clone, person_id, settings).await
}

async fn fetch_assignments(
    client: State<'_, SharedClient>,
    person_id: i64,
    start: &str,
    end: &str,
) -> Result<Vec<Value>, String> {
    let start_date = if start.len() >= 10 { &start[0..10] } else { start };
    let end_date = if end.len() >= 10 { &end[0..10] } else { end };
    let path = format!("personen/{}/opdrachten?van={}&tot={}", person_id, start_date, end_date);
    let data = crate::client::get_with_shared(&client, &path).await.map_err(|e| e.to_string())?;
    let items = data.get("Items").or_else(|| data.get("items")).cloned().unwrap_or(Value::Array(vec![]));
    Ok(items.as_array().cloned().unwrap_or_default())
}

// Additional command: set_homework_duration backing
#[tauri::command]
pub async fn set_homework_duration(
    state: State<'_, AiScheduleState>,
    assignment_id: i64,
    estimated_minutes: u32,
    urgency: Option<u8>,
) -> Result<AiScheduleItem, String> {
    if estimated_minutes == 0 || estimated_minutes > 600 {
        return Err("Ongeldige duur (1-600 minuten).".to_string());
    }
    if let Some(u) = urgency {
        if !(1..=5).contains(&u) {
            return Err("Urgency moet 1-5 zijn.".to_string());
        }
    }

    let mut items = state.items.write().await;
    // Find existing item for this assignment (prefer HomeworkReview or AssignmentWork)
    let now = now_iso();
    if let Some(item) = items.iter_mut().find(|i| i.related_assignment_id == Some(assignment_id)) {
        item.estimated_minutes = Some(estimated_minutes);
        item.duration_source = Some(DurationSource::UserEntered);
        if let Some(u) = urgency {
            item.urgency = u;
        }
        item.updated_at = now.clone();
        let cloned = item.clone();
        let snapshot = items.clone();
        state.save(&snapshot);
        return Ok(cloned);
    }

    // If no existing item, create a new AssignmentWork placeholder? Or return error?
    // Create a new Custom-like but with AssignmentWork type
    let new_item = AiScheduleItem {
        id: format!("work-{}-manual", assignment_id),
        title: format!("Huiswerk {}", assignment_id),
        description: Some("Duur ingesteld via UI".to_string()),
        item_type: crate::models::ai_schedule::AiScheduleItemType::AssignmentWork,
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
        related_subject: None,
        estimated_minutes: Some(estimated_minutes),
        duration_source: Some(DurationSource::UserEntered),
        source: crate::models::ai_schedule::AiScheduleSource::User,
        created_at: now.clone(),
        updated_at: now,
        completed_at: None,
    };
    items.push(new_item.clone());
    let snapshot = items.clone();
    state.save(&snapshot);
    Ok(new_item)
}
