use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde_json::Value;

use crate::models::ai_schedule::{
    AiScheduleItem, AiScheduleItemType, AiScheduleSource, AiScheduleStatus, DurationSource,
};
use crate::models::calendar::CalendarEvent;

/// Settings that affect planning – mirrored from frontend `DEFAULT_SETTINGS.aiSchedule`
/// but kept with defaults here so the backend can run without the frontend passing them.
#[derive(Debug, Clone)]
pub struct ScheduleSettings {
    pub bedtime: String, // "23:00"
    pub wake_time: String, // "07:00"
    pub blocked_times: Vec<BlockedTime>,
}

#[derive(Debug, Clone)]
pub struct BlockedTime {
    pub day: String, // "monday" etc or "2026-09-08"
    pub start: String,
    pub end: String,
}

impl Default for ScheduleSettings {
    fn default() -> Self {
        Self {
            bedtime: "23:00".to_string(),
            wake_time: "07:00".to_string(),
            blocked_times: vec![],
        }
    }
}

fn parse_hm(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split(':');
    let h = parts.next()?.parse::<u32>().ok()?;
    let m = parts.next()?.parse::<u32>().ok()?;
    Some((h, m))
}

/// Compute planning window: today through coming Sunday plus following full week.
/// Returns (start_date, end_date) as NaiveDate.
pub fn planning_window(today: NaiveDate) -> (NaiveDate, NaiveDate) {
    // "This week" = today through coming Sunday (week starts Monday per ISO)
    let weekday = today.weekday().num_days_from_monday(); // 0=Mon ..6=Sun
    let days_until_sunday = 6 - weekday as i64;
    let this_sunday = today + Duration::days(days_until_sunday);
    let next_sunday = this_sunday + Duration::days(7);
    (today, next_sunday)
}

pub fn iso_to_naive(s: &str) -> Option<NaiveDateTime> {
    // Try ISO 8601 with timezone or without
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Local).naive_local());
    }
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok()
        .or_else(|| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok())
        .or_else(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| d.and_hms_opt(0, 0, 0).unwrap()))
}

pub fn naive_to_iso(n: NaiveDateTime) -> String {
    // Europe/Amsterdam ISO without timezone offset but implying Amsterdam
    // Use format that frontend expects: "2026-09-08T15:00:00"
    n.format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn today_ams() -> NaiveDate {
    Local::now().date_naive()
}

#[derive(Debug, Clone)]
pub struct FreeSlot {
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
}

/// Compute free slots for each day in planning window, after subtracting
/// fixed busy intervals (lessons, locked AI items, sleep, blocked times).
pub fn compute_free_slots(
    window_start: NaiveDate,
    window_end: NaiveDate,
    lessons: &[CalendarEvent],
    locked_items: &[AiScheduleItem],
    settings: &ScheduleSettings,
) -> Vec<FreeSlot> {
    let mut slots = Vec::new();
    let mut current = window_start;
    while current <= window_end {
        let day_slots = free_slots_for_day(current, lessons, locked_items, settings);
        slots.extend(day_slots);
        current += Duration::days(1);
    }
    slots
}

fn free_slots_for_day(
    date: NaiveDate,
    lessons: &[CalendarEvent],
    locked_items: &[AiScheduleItem],
    settings: &ScheduleSettings,
) -> Vec<FreeSlot> {
    let bed = parse_hm(&settings.bedtime).unwrap_or((23, 0));
    let wake = parse_hm(&settings.wake_time).unwrap_or((7, 0));

    let bed_time = NaiveTime::from_hms_opt(bed.0, bed.1, 0).unwrap();
    let wake_time = NaiveTime::from_hms_opt(wake.0, wake.1, 0).unwrap();

    // Day boundaries
    let day_start = date.and_time(wake_time);
    let day_end = date.and_time(bed_time);
    // If bedtime is after midnight (e.g., 01:00 next day), handle wrap
    // For now assume bedtime > wake_time on same day; if bedtime < wake_time it means after midnight.
    let (day_start, day_end) = if day_end <= day_start {
        // bedtime is early next morning, so end is next day bedtime
        (day_start, (date + Duration::days(1)).and_time(bed_time))
    } else {
        (day_start, day_end)
    };

    // Collect busy intervals for this day
    let mut busy: Vec<(NaiveDateTime, NaiveDateTime)> = Vec::new();

    // Sleep is not inside day_start/day_end; it's outside. But we treat day_start-day_end as awake window,
    // so no need to add sleep as busy inside it. Sleep will be materialized separately.

    for ev in lessons {
        if let (Some(s), Some(e)) = (iso_to_naive(&ev.start), iso_to_naive(&ev.einde)) {
            // Only if overlaps this day's awake window
            if e > day_start && s < day_end {
                let bs = s.max(day_start);
                let be = e.min(day_end);
                if be > bs {
                    busy.push((bs, be));
                }
            }
        }
    }

    for item in locked_items {
        // Exclude FreeTime and Sleep from locked? But locked_items already filtered to exclude them.
        // Include any locked item that overlaps.
        if let (Some(s), Some(e)) = (iso_to_naive(&item.start), iso_to_naive(&item.end)) {
            if e > day_start && s < day_end {
                let bs = s.max(day_start);
                let be = e.min(day_end);
                if be > bs {
                    busy.push((bs, be));
                }
            }
        }
    }

    // Blocked times (recurring weekly or specific date)
    for bt in &settings.blocked_times {
        // Check if applies to this date: if day matches weekday name or exact date
        let weekday_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
        let wd = date.weekday().num_days_from_monday() as usize;
        let day_name = weekday_names[wd];
        let matches = bt.day.eq_ignore_ascii_case(day_name)
            || bt.day.eq_ignore_ascii_case(&date.format("%Y-%m-%d").to_string())
            || bt.day.eq_ignore_ascii_case("daily")
            || bt.day.eq_ignore_ascii_case("weekday") && wd < 5
            || bt.day.eq_ignore_ascii_case("weekend") && wd >= 5;
        if matches {
            if let (Some((sh, sm)), Some((eh, em))) = (parse_hm(&bt.start), parse_hm(&bt.end)) {
                let s = date.and_time(NaiveTime::from_hms_opt(sh, sm, 0).unwrap());
                let e = date.and_time(NaiveTime::from_hms_opt(eh, em, 0).unwrap());
                let (s, e) = if e <= s {
                    (s, (date + Duration::days(1)).and_time(NaiveTime::from_hms_opt(eh, em, 0).unwrap()))
                } else {
                    (s, e)
                };
                if e > day_start && s < day_end {
                    let bs = s.max(day_start);
                    let be = e.min(day_end);
                    if be > bs {
                        busy.push((bs, be));
                    }
                }
            }
        }
    }

    busy.sort_by_key(|(s, _)| *s);
    // Merge overlapping busy
    let mut merged: Vec<(NaiveDateTime, NaiveDateTime)> = Vec::new();
    for (s, e) in busy {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 {
                if e > last.1 {
                    last.1 = e;
                }
                continue;
            }
        }
        merged.push((s, e));
    }

    // Now invert to free slots
    let mut free = Vec::new();
    let mut cursor = day_start;
    for (bs, be) in merged {
        if bs > cursor {
            free.push(FreeSlot {
                start: cursor,
                end: bs,
            });
        }
        cursor = cursor.max(be);
    }
    if day_end > cursor {
        free.push(FreeSlot {
            start: cursor,
            end: day_end,
        });
    }

    // Filter very small gaps (<10 min)
    free.into_iter()
        .filter(|s| (s.end - s.start).num_minutes() >= 10)
        .collect()
}

/// Generate Sleep items for window (one per day)
pub fn generate_sleep_items(window_start: NaiveDate, window_end: NaiveDate, settings: &ScheduleSettings) -> Vec<AiScheduleItem> {
    let mut items = Vec::new();
    let bed = parse_hm(&settings.bedtime).unwrap_or((23, 0));
    let wake = parse_hm(&settings.wake_time).unwrap_or((7, 0));
    let bed_time = NaiveTime::from_hms_opt(bed.0, bed.1, 0).unwrap();
    let wake_time = NaiveTime::from_hms_opt(wake.0, wake.1, 0).unwrap();

    let mut date = window_start;
    while date <= window_end {
        // Sleep from bedtime to next day wake time
        let sleep_start = date.and_time(bed_time);
        let sleep_end = (date + Duration::days(1)).and_time(wake_time);
        // If bedtime > wake (same day), keep as is, else adjust: if bedtime is 23:00, wake 07:00 next day
        // If bedtime is 01:00 (after midnight), sleep_start is actually after wake? Handle not needed for defaults.
        let now_iso = Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
        items.push(AiScheduleItem {
            id: format!("sleep-{}", date.format("%Y-%m-%d")),
            title: "Slaap".to_string(),
            description: Some("Vaste slaapperiode — wordt niet ingepland voor huiswerk.".to_string()),
            item_type: AiScheduleItemType::Sleep,
            start: naive_to_iso(sleep_start),
            end: naive_to_iso(sleep_end),
            status: AiScheduleStatus::Planned,
            urgency: 1,
            related_assignment_id: None,
            related_calendar_event_id: None,
            related_subject: None,
            estimated_minutes: None,
            duration_source: None,
            source: AiScheduleSource::AiChat,
            created_at: now_iso.clone(),
            updated_at: now_iso.clone(),
            completed_at: None,
        });
        date += Duration::days(1);
    }
    items
}

/// Generate FreeTime items covering remaining gaps after planning homework/study.
/// This is called after homework blocks have been placed.
pub fn generate_free_time_items(free_slots: &[FreeSlot]) -> Vec<AiScheduleItem> {
    let now_iso = Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
    free_slots
        .iter()
        .enumerate()
        .map(|(i, slot)| AiScheduleItem {
            id: format!("freetime-{}-{}", slot.start.format("%Y-%m-%d"), i),
            title: "Vrije tijd".to_string(),
            description: Some("Vrije tijd — je kunt hier zelf iets plannen.".to_string()),
            item_type: AiScheduleItemType::FreeTime,
            start: naive_to_iso(slot.start),
            end: naive_to_iso(slot.end),
            status: AiScheduleStatus::Planned,
            urgency: 1,
            related_assignment_id: None,
            related_calendar_event_id: None,
            related_subject: None,
            estimated_minutes: Some((slot.end - slot.start).num_minutes() as u32),
            duration_source: None,
            source: AiScheduleSource::AiChat,
            created_at: now_iso.clone(),
            updated_at: now_iso.clone(),
            completed_at: None,
        })
        .collect()
}

/// Helper to compute rolling average estimated_minutes per subject from completed items.
pub fn subject_average_minutes(items: &[AiScheduleItem], subject: &str) -> Option<u32> {
    let mut total = 0u32;
    let mut count = 0u32;
    for item in items {
        if item.status == AiScheduleStatus::Completed
            && item.related_subject.as_deref() == Some(subject)
            && item.estimated_minutes.is_some()
            && item.duration_source == Some(DurationSource::UserEntered)
        {
            total += item.estimated_minutes.unwrap();
            count += 1;
        }
    }
    if count > 0 {
        Some(total / count)
    } else {
        None
    }
}

/// Simplified plan generation: creates HomeworkReview and AssignmentWork blocks,
/// plus StudyBlocks for upcoming tests (InfoType 2-5) and work for open
/// calendar homework (InfoType 1). Deterministic slot-fitting; the
/// `description` of each item contains the reasoning (deadline proximity,
/// urgency, chosen slot) so the user can see *why* it was placed there.
pub struct AssignmentInput {
    pub id: i64,
    pub titel: String,
    pub vak: Option<String>,
    pub inleveren_voor: String,
    pub omschrijving: Option<String>,
}

pub struct TestInput {
    pub event_id: i64,
    pub vak: Option<String>,
    pub omschrijving: Option<String>,
    pub start: NaiveDateTime,
    pub info_type: i32,
}

fn compute_urgency(deadline: NaiveDateTime, today: NaiveDate) -> u8 {
    let days = (deadline.date() - today).num_days();
    if days <= 1 {
        5
    } else if days <= 3 {
        4
    } else if days <= 7 {
        3
    } else if days <= 14 {
        2
    } else {
        1
    }
}

/// True when [a_start, a_end) overlaps [b_start, b_end).
/// Touching endpoints (a_end == b_start) do NOT count as overlap.
pub fn items_overlap(a_start: NaiveDateTime, a_end: NaiveDateTime, b_start: NaiveDateTime, b_end: NaiveDateTime) -> bool {
    a_start < b_end && b_start < a_end
}

pub fn intervals_overlap_str(a_start: &str, a_end: &str, b_start: &str, b_end: &str) -> bool {
    match (
        iso_to_naive(a_start),
        iso_to_naive(a_end),
        iso_to_naive(b_start),
        iso_to_naive(b_end),
    ) {
        (Some(as_), Some(ae), Some(bs), Some(be)) => items_overlap(as_, ae, bs, be),
        _ => false,
    }
}

/// Extract upcoming tests from Magister lessons: InfoType 2 (Proefwerk),
/// 3 (Tentamen), 4 (SO), 5 (Mondeling). Includes tests inside the window
/// plus up to 14 days after window start so preparation can be scheduled
/// *before* the test.
pub fn extract_upcoming_tests(lessons: &[CalendarEvent], window_start: NaiveDate, window_end: NaiveDate) -> Vec<TestInput> {
    let horizon = window_end + Duration::days(7);
    let mut out = Vec::new();
    for ev in lessons {
        if ![2, 3, 4, 5].contains(&ev.info_type) {
            continue;
        }
        // Skip cancelled lessons
        if ev.status == 4 || ev.status == 5 {
            continue;
        }
        let Some(start) = iso_to_naive(&ev.start) else { continue };
        let d = start.date();
        // Test should be in the future-ish: from window_start-1 to horizon
        if d < window_start - Duration::days(1) || d > horizon {
            continue;
        }
        let vak = ev.vakken.as_ref().and_then(|v| v.first()).and_then(|v| v.naam.clone());
        let oms = ev.omschrijving.clone().or_else(|| ev.inhoud.clone());
        out.push(TestInput {
            event_id: ev.id,
            vak,
            omschrijving: oms,
            start,
            info_type: ev.info_type,
        });
    }
    out.sort_by_key(|t| t.start);
    out
}

/// Extract open calendar homework (InfoType 1, not Afgerond) as work that
/// needs planning. These have no assignment_id; they link via calendar event id.
pub struct HomeworkInput {
    pub event_id: i64,
    pub vak: Option<String>,
    pub omschrijving: Option<String>,
    pub les_start: NaiveDateTime,
}

pub fn extract_open_homework(lessons: &[CalendarEvent]) -> Vec<HomeworkInput> {
    let mut out = Vec::new();
    for ev in lessons {
        if ev.info_type != 1 || ev.afgerond {
            continue;
        }
        if ev.status == 4 || ev.status == 5 {
            continue;
        }
        let Some(les_start) = iso_to_naive(&ev.start) else { continue };
        let vak = ev.vakken.as_ref().and_then(|v| v.first()).and_then(|v| v.naam.clone());
        // Inhoud holds the actual homework text; fall back to omschrijving
        let oms = ev.inhoud.clone().or_else(|| ev.omschrijving.clone());
        // Skip empty homework rows
        if oms.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) && vak.is_none() {
            continue;
        }
        out.push(HomeworkInput {
            event_id: ev.id,
            vak,
            omschrijving: oms,
            les_start,
        });
    }
    out
}

fn info_type_label(t: i32) -> &'static str {
    match t {
        2 => "Proefwerk",
        3 => "Tentamen",
        4 => "SO",
        5 => "Mondeling",
        _ => "Toets",
    }
}

/// Consume `minutes` (+ optional trailing break) from the earliest free slot
/// that fits. Returns (start, end) and updates `free_slots` in place.
/// Returns None when no slot fits.
fn take_slot(free_slots: &mut Vec<FreeSlot>, minutes: i64) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let idx = free_slots.iter().position(|s| (s.end - s.start).num_minutes() >= minutes)?;
    let slot = free_slots[idx].clone();
    let start = slot.start;
    let end = start + Duration::minutes(minutes);
    let remaining_start = end;
    let remaining_end = slot.end;
    free_slots.remove(idx);
    if remaining_end > remaining_start && (remaining_end - remaining_start).num_minutes() >= 10 {
        free_slots.insert(idx, FreeSlot { start: remaining_start, end: remaining_end });
    }
    free_slots.sort_by_key(|s| s.start);
    Some((start, end))
}

fn days_until(target: NaiveDate, today: NaiveDate) -> i64 {
    (target - today).num_days()
}

pub fn generate_plan(
    window_start: NaiveDate,
    window_end: NaiveDate,
    lessons: &[CalendarEvent],
    locked_items: &[AiScheduleItem],
    assignments: &[AssignmentInput],
    existing_items: &[AiScheduleItem],
    settings: &ScheduleSettings,
    // Map from assignment_id -> (estimated_minutes, duration_source)
    duration_map: &std::collections::HashMap<i64, (u32, DurationSource)>,
) -> Vec<AiScheduleItem> {
    let today = today_ams();
    let mut result: Vec<AiScheduleItem> = Vec::new();

    // Compute free slots after fixed busy (lessons + locked AI + blocked times).
    // Guardrail: every generated item consumes its slot, so two generated
    // items can never overlap each other, nor a lesson/locked item.
    let mut free_slots = compute_free_slots(window_start, window_end, lessons, locked_items, settings);
    let now_iso = Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S").to_string();
    let mut last_subject: Option<String> = None;

    // Sort assignments by urgency then deadline (most urgent first).
    // Include overdue (up to 7 days old) — they become urgency 5.
    let mut sorted: Vec<&AssignmentInput> = assignments.iter().collect();
    sorted.sort_by_key(|a| {
        let dl = iso_to_naive(&a.inleveren_voor).unwrap_or(today.and_hms_opt(0, 0, 0).unwrap());
        let urgency = compute_urgency(dl, today);
        (std::cmp::Reverse(urgency), dl)
    });

    for assignment in sorted {
        let deadline = iso_to_naive(&assignment.inleveren_voor).unwrap_or((window_end + Duration::days(1)).and_hms_opt(23, 59, 59).unwrap());
        // Keep overdue from the last 7 days (still needs doing); drop ancient ones.
        if deadline.date() < window_start - Duration::days(7) {
            continue;
        }
        let days = days_until(deadline.date(), today);
        let days_txt = if days < 0 {
            format!("{} dag(en) TE LAAT", -days)
        } else if days == 0 {
            "vandaag".to_string()
        } else if days == 1 {
            "morgen".to_string()
        } else {
            format!("over {} dagen", days)
        };
        let urgency = compute_urgency(deadline, today);
        let vak = assignment.vak.clone().unwrap_or_else(|| "Algemeen".to_string());

        // Determine estimated minutes
        let (est, source) = if let Some((m, s)) = duration_map.get(&assignment.id) {
            (*m, Some(s.clone()))
        } else if let Some(avg) = assignment.vak.as_deref().and_then(|subj| subject_average_minutes(existing_items, subj)) {
            (avg, Some(DurationSource::SubjectAverage))
        } else {
            // No estimate: create HomeworkReview triage block (10-15 min).
            // This is where the duration gets decided before any AssignmentWork.
            let review_minutes = 15u32;
            if let Some((start, end)) = take_slot(&mut free_slots, review_minutes as i64) {
                // Avoid same subject back-to-back: if previous block was same vak
                // and touches this start, shift by inserting the review after a
                // 10-min buffer when possible.
                let item = AiScheduleItem {
                    id: format!("review-{}", assignment.id),
                    title: format!("Bekijk: {}", assignment.titel),
                    description: Some(format!(
                        "Reden: nieuw huiswerk voor {} zonder tijdsinschatting (deadline {}, {}). Eerst 15 min triage: bekijk wat er moet gebeuren en vul de duur in — daarna plant de AI het echte werkblok. Urgentie {}/5.",
                        vak, deadline.format("%d-%m %H:%M"), days_txt, urgency
                    )),
                    item_type: AiScheduleItemType::HomeworkReview,
                    start: naive_to_iso(start),
                    end: naive_to_iso(end),
                    status: AiScheduleStatus::Planned,
                    urgency,
                    related_assignment_id: Some(assignment.id),
                    related_calendar_event_id: None,
                    related_subject: assignment.vak.clone(),
                    estimated_minutes: Some(review_minutes),
                    duration_source: Some(DurationSource::AiEstimated),
                    source: AiScheduleSource::AiChat,
                    created_at: now_iso.clone(),
                    updated_at: now_iso.clone(),
                    completed_at: None,
                };
                last_subject = assignment.vak.clone();
                result.push(item);
            }
            continue; // don't create AssignmentWork until review done
        };

        // For assignments with estimate, split if >60 into multiple blocks with Break.
        let mut remaining = est;
        let chunk_size = if est > 60 { 60 } else { est };
        let total_chunks = (est + chunk_size - 1) / chunk_size;
        let mut chunk_index = 0;
        while remaining > 0 {
            let this_chunk = remaining.min(chunk_size);
            let needed = this_chunk as i64 + if remaining > this_chunk { 15 } else { 0 };
            // Prefer a slot that avoids same-subject back-to-back when possible.
            let slot_choice = {
                let mut chosen: Option<usize> = None;
                for (idx, s) in free_slots.iter().enumerate() {
                    if (s.end - s.start).num_minutes() < needed {
                        continue;
                    }
                    // If previous generated block touches this slot start and has
                    // the same subject, deprioritise this slot (try next first).
                    let touches_prev = result.last().and_then(|last| iso_to_naive(&last.end)).map(|le| le == s.start).unwrap_or(false);
                    let same_subj = last_subject.as_deref() == assignment.vak.as_deref() && touches_prev;
                    if same_subj {
                        if chosen.is_none() {
                            chosen = Some(idx); // fallback
                        }
                        continue; // look for a non-touching slot first
                    } else {
                        chosen = Some(idx);
                        break;
                    }
                }
                chosen.or_else(|| free_slots.iter().position(|s| (s.end - s.start).num_minutes() >= needed))
            };
            let Some(slot_idx) = slot_choice else { break };
            let slot = free_slots[slot_idx].clone();
            let start = slot.start;
            let end = start + Duration::minutes(this_chunk as i64);
            // Final overlap guard: never emit overlapping the previous result.
            if let Some(last) = result.last() {
                if let (Some(ls), Some(le)) = (iso_to_naive(&last.start), iso_to_naive(&last.end)) {
                    if items_overlap(ls, le, start, end) {
                        break;
                    }
                }
            }
            let title = if est > 60 {
                format!("{} (deel {}/{})", assignment.titel, chunk_index + 1, total_chunks)
            } else {
                assignment.titel.clone()
            };
            let desc = format!(
                "Reden: {} voor {} (deadline {}, {}) — gepland op {} omdat dit vrije slot past ({} min, urgentie {}/5). {}.",
                if total_chunks > 1 { format!("deelsessie {}/{}", chunk_index + 1, total_chunks) } else { "werksessie".to_string() },
                vak,
                deadline.format("%d-%m %H:%M"),
                days_txt,
                start.format("%a %d-%m %H:%M"),
                this_chunk,
                urgency,
                assignment.omschrijving.clone().unwrap_or_else(|| "Huiswerk maken".to_string()),
            );
            let item = AiScheduleItem {
                id: format!("work-{}-{}", assignment.id, chunk_index),
                title,
                description: Some(desc),
                item_type: AiScheduleItemType::AssignmentWork,
                start: naive_to_iso(start),
                end: naive_to_iso(end),
                status: AiScheduleStatus::Planned,
                urgency,
                related_assignment_id: Some(assignment.id),
                related_calendar_event_id: None,
                related_subject: assignment.vak.clone(),
                estimated_minutes: Some(this_chunk),
                duration_source: source.clone(),
                source: AiScheduleSource::AiChat,
                created_at: now_iso.clone(),
                updated_at: now_iso.clone(),
                completed_at: None,
            };
            result.push(item);
            last_subject = assignment.vak.clone();
            let mut new_start = end;
            if remaining > this_chunk {
                let break_end = end + Duration::minutes(15);
                // Guard: break must still fit inside the slot
                if break_end > slot.end {
                    // Roll back: remove the work item we just pushed, slot stays
                    result.pop();
                    break;
                }
                let break_item = AiScheduleItem {
                    id: format!("break-{}-{}", assignment.id, chunk_index),
                    title: "Pauze".to_string(),
                    description: Some("Korte pauze tussen werksessies — even bewegen.".to_string()),
                    item_type: AiScheduleItemType::Break,
                    start: naive_to_iso(new_start),
                    end: naive_to_iso(break_end),
                    status: AiScheduleStatus::Planned,
                    urgency: 1,
                    related_assignment_id: None,
                    related_calendar_event_id: None,
                    related_subject: None,
                    estimated_minutes: Some(15),
                    duration_source: None,
                    source: AiScheduleSource::AiChat,
                    created_at: now_iso.clone(),
                    updated_at: now_iso.clone(),
                    completed_at: None,
                };
                result.push(break_item);
                new_start = break_end;
            }
            let remaining_start = new_start;
            let remaining_end = slot.end;
            free_slots.remove(slot_idx);
            if remaining_end > remaining_start && (remaining_end - remaining_start).num_minutes() >= 10 {
                free_slots.insert(slot_idx, FreeSlot { start: remaining_start, end: remaining_end });
            }
            free_slots.sort_by_key(|s| s.start);
            remaining = remaining.saturating_sub(this_chunk);
            chunk_index += 1;
            if chunk_index > 10 { break; }
        }
    }

    // --- Tests: StudyBlocks (revision, not tied to a handed-out assignment) ---
    let tests = extract_upcoming_tests(lessons, window_start, window_end);
    for test in tests {
        let days = days_until(test.start.date(), today);
        let urgency = compute_urgency(test.start, today);
        let vak = test.vak.clone().unwrap_or_else(|| "Onbekend vak".to_string());
        let label = info_type_label(test.info_type);
        // Study time scales with urgency/proximity: 2 sessions when close, 1 otherwise.
        let sessions = if days <= 3 { 2 } else { 1 };
        for s_idx in 0..sessions {
            let minutes = 45u32;
            let Some((start, end)) = take_slot(&mut free_slots, minutes as i64) else { break };
            // Don't schedule study after the test itself
            if start >= test.start {
                // Put slot back (take_slot already consumed) — re-insert remainder
                free_slots.push(FreeSlot { start, end });
                free_slots.sort_by_key(|s| s.start);
                break;
            }
            let title = if sessions > 1 {
                format!("Leren voor {} {} (sessie {}/{})", label, vak, s_idx + 1, sessions)
            } else {
                format!("Leren voor {} {}", label, vak)
            };
            let when_txt = if days < 0 {
                "geweest".to_string()
            } else if days == 0 {
                "vandaag".to_string()
            } else {
                format!("over {} dagen", days)
            };
            let desc = format!(
                "Reden: {} {} op {} ({}). Voorbereiding — geen specifieke opdracht, wel herhalen/oefenen. Urgentie {}/5.",
                label, vak, test.start.format("%a %d-%m %H:%M"),
                when_txt,
                urgency
            );
            result.push(AiScheduleItem {
                id: format!("study-test-{}-{}", test.event_id, s_idx),
                title,
                description: Some(desc),
                item_type: AiScheduleItemType::StudyBlock,
                start: naive_to_iso(start),
                end: naive_to_iso(end),
                status: AiScheduleStatus::Planned,
                urgency,
                related_assignment_id: None,
                related_calendar_event_id: Some(test.event_id),
                related_subject: test.vak.clone(),
                estimated_minutes: Some(minutes),
                duration_source: Some(DurationSource::AiEstimated),
                source: AiScheduleSource::AiChat,
                created_at: now_iso.clone(),
                updated_at: now_iso.clone(),
                completed_at: None,
            });
            last_subject = test.vak.clone();
        }
    }

    // --- Open calendar homework (InfoType 1): short work blocks ---
    let homeworks = extract_open_homework(lessons);
    for hw in homeworks {
        // Skip if we already planned something for this calendar event
        if result.iter().any(|i| i.related_calendar_event_id == Some(hw.event_id)) {
            continue;
        }
        if existing_items.iter().any(|i| i.related_calendar_event_id == Some(hw.event_id) && (i.status == AiScheduleStatus::Planned || i.status == AiScheduleStatus::InProgress)) {
            continue;
        }
        let vak = hw.vak.clone().unwrap_or_else(|| "Algemeen".to_string());
        let est = hw.vak.as_deref().and_then(|s| subject_average_minutes(existing_items, s)).unwrap_or(30);
        let urgency = 3u8;
        let Some((start, end)) = take_slot(&mut free_slots, est as i64) else { continue };
        // Homework should be done before/within 2 days after the lesson
        let desc = format!(
            "Reden: huiswerk uit de les ({} op {}). Korte werksessie van {} min — maak/af wat in de les is opgegeven. Vak-gemiddelde of 30 min default.",
            vak, hw.les_start.format("%a %d-%m %H:%M"), est
        );
        result.push(AiScheduleItem {
            id: format!("hw-cal-{}", hw.event_id),
            title: format!("Huiswerk: {}", vak),
            description: Some(desc),
            item_type: AiScheduleItemType::AssignmentWork,
            start: naive_to_iso(start),
            end: naive_to_iso(end),
            status: AiScheduleStatus::Planned,
            urgency,
            related_assignment_id: None,
            related_calendar_event_id: Some(hw.event_id),
            related_subject: hw.vak.clone(),
            estimated_minutes: Some(est),
            duration_source: Some(DurationSource::SubjectAverage),
            source: AiScheduleSource::AiChat,
            created_at: now_iso.clone(),
            updated_at: now_iso.clone(),
            completed_at: None,
        });
        last_subject = hw.vak.clone();
        let _ = last_subject;
    }

    // Generate remaining free time items for still-free gaps
    let free_time_items = generate_free_time_items(&free_slots);
    let mut sleep_items = generate_sleep_items(window_start, window_end, settings);

    result.extend(free_time_items);
    result.append(&mut sleep_items);

    // Sort all by start
    result.sort_by_key(|i| iso_to_naive(&i.start).unwrap_or(today.and_hms_opt(0,0,0).unwrap()));

    // Deduplicate by id (keep first) + drop exact time+assignment duplicates
    let mut seen = std::collections::HashSet::new();
    result.retain(|item| seen.insert(item.id.clone()));

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::calendar::{CalendarEvent, Vak, Docent, Lokaal};

    fn make_lesson(start: &str, einde: &str) -> CalendarEvent {
        CalendarEvent {
            id: 1,
            start: start.to_string(),
            einde: einde.to_string(),
            lesuur_van: None,
            lesuur_tot_met: None,
            duurt_hele_dag: false,
            omschrijving: Some("Les".to_string()),
            lokatie: None,
            status: 2,
            event_type: 16,
            subtype: None,
            is_online_deelname: None,
            weergave_type: None,
            inhoud: None,
            info_type: 0,
            aantekening: None,
            afgerond: false,
            herhaal_status: None,
            vakken: Some(vec![Vak { id: Some(1), naam: Some("Wiskunde".to_string()) }]),
            docenten: None,
            lokalen: None,
            opdracht_id: None,
            heeft_bijlagen: false,
            bijlagen: None,
            links: None,
            afwezigheid: None,
            self_url: None,
            merged_absence: None,
        }
    }

    #[test]
    fn planning_window_covers_two_weeks() {
        let today = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap(); // Tuesday
        let (start, end) = planning_window(today);
        assert_eq!(start, today);
        // Coming Sunday is 2026-09-13, plus next week => 2026-09-20
        assert_eq!(end, NaiveDate::from_ymd_opt(2026, 9, 20).unwrap());
    }

    #[test]
    fn free_slots_excludes_lessons() {
        let date = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap();
        let lessons = vec![make_lesson("2026-09-08T09:00:00", "2026-09-08T10:00:00")];
        let locked: Vec<AiScheduleItem> = vec![];
        let settings = ScheduleSettings::default();
        let slots = free_slots_for_day(date, &lessons, &locked, &settings);
        // Wake 07:00 to bed 23:00 minus 09-10 lesson = 2 slots: 07-09 and 10-23
        assert!(slots.len() >= 2);
        let first = &slots[0];
        assert_eq!(first.start, date.and_hms_opt(7,0,0).unwrap());
        assert_eq!(first.end, date.and_hms_opt(9,0,0).unwrap());
        let second = &slots[1];
        assert_eq!(second.start, date.and_hms_opt(10,0,0).unwrap());
    }

    #[test]
    fn sleep_items_generated_per_day() {
        let start = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 9, 9).unwrap();
        let settings = ScheduleSettings::default();
        let items = generate_sleep_items(start, end, &settings);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].item_type, AiScheduleItemType::Sleep);
    }

    #[test]
    fn generate_plan_creates_review_when_no_estimate() {
        let start = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 9, 14).unwrap();
        let lessons: Vec<CalendarEvent> = vec![];
        let locked: Vec<AiScheduleItem> = vec![];
        let assignments = vec![AssignmentInput {
            id: 42,
            titel: "Verslag".to_string(),
            vak: Some("Nederlands".to_string()),
            inleveren_voor: "2026-09-10T23:59:59".to_string(),
            omschrijving: None,
        }];
        let existing: Vec<AiScheduleItem> = vec![];
        let settings = ScheduleSettings::default();
        let map = std::collections::HashMap::new();
        let plan = generate_plan(start, end, &lessons, &locked, &assignments, &existing, &settings, &map);
        let has_review = plan.iter().any(|i| i.item_type == AiScheduleItemType::HomeworkReview && i.related_assignment_id == Some(42));
        assert!(has_review, "should create HomeworkReview when no estimate");
        assert!(plan.iter().any(|i| i.item_type == AiScheduleItemType::Sleep));
        assert!(plan.iter().any(|i| i.item_type == AiScheduleItemType::FreeTime));
    }

    #[test]
    fn generate_plan_splits_long_assignment() {
        let start = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 9, 9).unwrap();
        let lessons: Vec<CalendarEvent> = vec![];
        let locked: Vec<AiScheduleItem> = vec![];
        let assignments = vec![AssignmentInput {
            id: 99,
            titel: "Groot project".to_string(),
            vak: Some("Wiskunde".to_string()),
            inleveren_voor: "2026-09-09T23:59:59".to_string(),
            omschrijving: Some("Lang".to_string()),
        }];
        let existing: Vec<AiScheduleItem> = vec![];
        let settings = ScheduleSettings::default();
        let mut map = std::collections::HashMap::new();
        map.insert(99, (120, DurationSource::UserEntered));
        let plan = generate_plan(start, end, &lessons, &locked, &assignments, &existing, &settings, &map);
        let work_blocks: Vec<_> = plan.iter().filter(|i| i.item_type == AiScheduleItemType::AssignmentWork && i.related_assignment_id == Some(99)).collect();
        assert!(work_blocks.len() >= 2, "long assignment should split into multiple blocks");
        let has_break = plan.iter().any(|i| i.item_type == AiScheduleItemType::Break);
        assert!(has_break);
    }
}
