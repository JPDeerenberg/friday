use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Utc};
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
    /// Minutes after the last lesson of a school day before homework may be
    /// planned (travel home by bike/car/foot + eating). Prevents the planner
    /// from scheduling work the minute school ends — or while still at school.
    pub after_school_buffer_min: u32,
    /// When false (default), the whole school day (first lesson start → last
    /// lesson end) is treated as busy, so homework is only planned at home.
    /// When true, gaps between lessons (tussenuren) are fair game too.
    pub plan_in_school_gaps: bool,
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
            after_school_buffer_min: 60,
            plan_in_school_gaps: false,
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
    // Clamp "today" to the current time so nothing is ever planned in the past
    // (previously the whole of today from wake-up time counted as free, which
    // stacked everything onto today — including hours already gone).
    let now = Local::now().naive_local();
    let mut slots = Vec::new();
    let mut current = window_start;
    while current <= window_end {
        let day_slots = free_slots_for_day(current, lessons, locked_items, settings, now);
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
    now: NaiveDateTime,
) -> Vec<FreeSlot> {
    let bed = parse_hm(&settings.bedtime).unwrap_or((23, 0));
    let wake = parse_hm(&settings.wake_time).unwrap_or((7, 0));

    let bed_time = NaiveTime::from_hms_opt(bed.0, bed.1, 0).unwrap();
    let wake_time = NaiveTime::from_hms_opt(wake.0, wake.1, 0).unwrap();

    // Day boundaries
    let mut day_start = date.and_time(wake_time);
    let day_end = date.and_time(bed_time);
    // If bedtime is after midnight (e.g., 01:00 next day), handle wrap
    // For now assume bedtime > wake_time on same day; if bedtime < wake_time it means after midnight.
    let day_end = if day_end <= day_start {
        // bedtime is early next morning, so end is next day bedtime
        (date + Duration::days(1)).and_time(bed_time)
    } else {
        day_end
    };

    // Never offer time that already passed. Round up to the next 5 minutes
    // so a plan made at 16:37 doesn't start a block at 16:37.
    if date == now.date() && day_start < now {
        let mins = now.hour() * 60 + now.minute();
        let rounded = ((mins + 4) / 5) * 5;
        if let Some(t) = NaiveTime::from_hms_opt(rounded / 60 % 24, rounded % 60, 0) {
            let candidate = if rounded >= 24 * 60 {
                (date + Duration::days(1)).and_time(t)
            } else {
                date.and_time(t)
            };
            day_start = candidate.max(day_start);
        } else {
            day_start = now;
        }
    }
    if day_end <= day_start {
        return vec![];
    }

    // Collect busy intervals for this day
    let mut busy: Vec<(NaiveDateTime, NaiveDateTime)> = Vec::new();

    // Sleep is not inside day_start/day_end; it's outside. But we treat day_start-day_end as awake window,
    // so no need to add sleep as busy inside it. Sleep will be materialized separately.

    // School-day handling: collect this day's lessons first so we can block
    // the whole school day (plus travel/eat buffer afterwards).
    let mut day_lessons: Vec<(NaiveDateTime, NaiveDateTime)> = Vec::new();
    for ev in lessons {
        // Cancelled lessons don't keep the student at school.
        if ev.status == 4 || ev.status == 5 {
            continue;
        }
        if let (Some(s), Some(e)) = (iso_to_naive(&ev.start), iso_to_naive(&ev.einde)) {
            if e > day_start && s < day_end {
                day_lessons.push((s.max(day_start), e.min(day_end)));
            }
        }
    }
    if !day_lessons.is_empty() {
        day_lessons.sort_by_key(|(s, _)| *s);
        let school_start = day_lessons.first().map(|(s, _)| *s).unwrap();
        let school_end = day_lessons.iter().map(|(_, e)| *e).max().unwrap();
        if settings.plan_in_school_gaps {
            // Gaps between lessons stay plannable; only the lessons
            // themselves plus the after-school buffer are busy.
            for (s, e) in &day_lessons {
                busy.push((*s, *e));
            }
        } else {
            // Default: the student is at school the whole day — nothing
            // gets planned in tussenuren.
            busy.push((school_start, school_end));
        }
        // Travel home + eating buffer after the last lesson.
        let buffer_end = school_end + Duration::minutes(settings.after_school_buffer_min as i64);
        if buffer_end > school_end {
            busy.push((school_end, buffer_end.min(day_end + Duration::hours(6))));
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
/// Returns None when no slot fits. Used for triage/review and homework that
/// should happen ASAP.
fn take_slot(free_slots: &mut Vec<FreeSlot>, minutes: i64) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let idx = free_slots.iter().position(|s| (s.end - s.start).num_minutes() >= minutes)?;
    consume_front(free_slots, idx, minutes)
}

/// Latest-fit placement: picks the latest free slot (by start) that can hold
/// `minutes` ending no later than `latest_end`, and places the item at the
/// START of that slot. Work is thus scheduled as close to its deadline as
/// possible, which naturally spreads assignments with different deadlines
/// across days instead of piling everything onto today.
/// `only_before_day`: when Some(d), only slots starting on a day strictly
/// before `d` qualify — used to spread multi-chunk work across days.
/// Returns None when nothing fits.
fn take_latest_slot(
    free_slots: &mut Vec<FreeSlot>,
    minutes: i64,
    latest_end: NaiveDateTime,
    only_before_day: Option<NaiveDate>,
) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let mut best: Option<usize> = None;
    for (idx, s) in free_slots.iter().enumerate() {
        if (s.end - s.start).num_minutes() < minutes {
            continue;
        }
        if let Some(d) = only_before_day {
            if s.start.date() >= d {
                continue;
            }
        }
        let end_limit = s.end.min(latest_end);
        if end_limit - s.start < Duration::minutes(minutes) {
            continue;
        }
        if best.map(|b| s.start > free_slots[b].start).unwrap_or(true) {
            best = Some(idx);
        }
    }
    consume_front(free_slots, best?, minutes)
}

/// Shared consume-from-front helper for both placement strategies.
fn consume_front(
    free_slots: &mut Vec<FreeSlot>,
    idx: usize,
    minutes: i64,
) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let slot = free_slots.get(idx)?.clone();
    let start = slot.start;
    let end = start + Duration::minutes(minutes);
    if end > slot.end {
        return None;
    }
    let remaining_start = end;
    let remaining_end = slot.end;
    free_slots.remove(idx);
    if remaining_end > remaining_start && (remaining_end - remaining_start).num_minutes() >= 10 {
        free_slots.insert(idx, FreeSlot { start: remaining_start, end: remaining_end });
    }
    free_slots.sort_by_key(|s| s.start);
    Some((start, end))
}

/// Safety net: true when [start, end) overlaps any already-planned item.
fn overlaps_planned(result: &[AiScheduleItem], start: NaiveDateTime, end: NaiveDateTime) -> bool {
    result.iter().any(|it| {
        if let (Some(s), Some(e)) = (iso_to_naive(&it.start), iso_to_naive(&it.end)) {
            items_overlap(s, e, start, end)
        } else {
            false
        }
    })
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
                if overlaps_planned(&result, start, end) {
                    // Slot was consumed but collides (shouldn't happen) — give it back.
                    free_slots.push(FreeSlot { start, end });
                    free_slots.sort_by_key(|s| s.start);
                } else {
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
                    result.push(item);
                }
            }
            continue; // don't create AssignmentWork until review done
        };

        // Work is placed latest-first (as close to the deadline as fits),
        // so assignments with different deadlines spread across days instead
        // of all piling onto today. Estimates >60 min are split into 60-min
        // chunks on different days (a day gap is the break); single-day
        // leftovers keep a 15-min Break between back-to-back chunks.
        let chunk_size = if est > 60 { 60 } else { est };
        let mut placements: Vec<(NaiveDateTime, NaiveDateTime, u32)> = Vec::new();
        let mut remaining = est;
        let mut latest = deadline;
        let mut prev_day: Option<NaiveDate> = None;
        while remaining > 0 {
            let this_chunk = remaining.min(chunk_size);
            // Prefer a strictly earlier day (spread); fall back to any slot
            // before `latest` (e.g. when only one evening has room).
            let placed = prev_day
                .and_then(|d| {
                    take_latest_slot(&mut free_slots, this_chunk as i64, latest, Some(d))
                })
                .or_else(|| take_latest_slot(&mut free_slots, this_chunk as i64, latest, None));
            let Some((start, end)) = placed else { break };
            if overlaps_planned(&result, start, end)
                || placements.iter().any(|(s, e, _)| items_overlap(*s, *e, start, end))
            {
                free_slots.push(FreeSlot { start, end });
                free_slots.sort_by_key(|s| s.start);
                break;
            }
            placements.push((start, end, this_chunk));
            latest = start;
            prev_day = Some(start.date());
            remaining = remaining.saturating_sub(this_chunk);
            if placements.len() > 10 {
                break;
            }
        }
        if placements.is_empty() {
            continue;
        }
        // Emit chronologically so deel 1/N is the earliest session.
        // No explicit Break items: chunks land on different days (a day gap
        // is the break), and same-evening leftovers are short enough.
        placements.sort();
        let total_chunks = placements.len();
        for (chunk_index, (start, end, mins)) in placements.iter().enumerate() {
            let (start, end, mins) = (*start, *end, *mins);
            let title = if total_chunks > 1 {
                format!(
                    "{} (deel {}/{})",
                    assignment.titel,
                    chunk_index + 1,
                    total_chunks
                )
            } else {
                assignment.titel.clone()
            };
            let desc = if total_chunks > 1 {
                format!(
                    "Reden: deelsessie {}/{} voor {} (deadline {}, {}) — gepland op {} ({} min, urgentie {}/5) zodat het werk over meerdere dagen is gespreid. {}.",
                    chunk_index + 1,
                    total_chunks,
                    vak,
                    deadline.format("%d-%m %H:%M"),
                    days_txt,
                    start.format("%a %d-%m %H:%M"),
                    mins,
                    urgency,
                    assignment.omschrijving.clone().unwrap_or_else(|| "Huiswerk maken".to_string()),
                )
            } else {
                format!(
                    "Reden: werksessie voor {} (deadline {}, {}) — gepland op {} ({} min, urgentie {}/5). {}.",
                    vak,
                    deadline.format("%d-%m %H:%M"),
                    days_txt,
                    start.format("%a %d-%m %H:%M"),
                    mins,
                    urgency,
                    assignment.omschrijving.clone().unwrap_or_else(|| "Huiswerk maken".to_string()),
                )
            };
            result.push(AiScheduleItem {
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
                estimated_minutes: Some(mins),
                duration_source: source.clone(),
                source: AiScheduleSource::AiChat,
                created_at: now_iso.clone(),
                updated_at: now_iso.clone(),
                completed_at: None,
            });
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
        // Sessions spread across days before the test (latest-fit), never after it.
        let sessions = if days <= 3 { 2 } else { 1 };
        let mut placed: Vec<(NaiveDateTime, NaiveDateTime, u32)> = Vec::new();
        for s_idx in 0..sessions {
            let minutes = 45u32;
            // Session s_idx must end before the test, each earlier session at
            // least a day before the previous one so prep spreads out.
            let latest_end = test.start - Duration::days(s_idx as i64);
            let slot = if s_idx == 0 {
                take_latest_slot(&mut free_slots, minutes as i64, latest_end, None)
            } else {
                let prev_day = placed.first().map(|(s, _, _)| s.date());
                prev_day
                    .and_then(|d| take_latest_slot(&mut free_slots, minutes as i64, latest_end, Some(d)))
                    .or_else(|| take_latest_slot(&mut free_slots, minutes as i64, latest_end, None))
            };
            let Some((start, end)) = slot else { break };
            if end > test.start || overlaps_planned(&result, start, end) {
                free_slots.push(FreeSlot { start, end });
                free_slots.sort_by_key(|s| s.start);
                break;
            }
            placed.push((start, end, minutes));
        }
        // Emit chronologically so sessie 1 is the earliest.
        placed.sort();
        let n = placed.len();
        for (emit_idx, (start, end, mins)) in placed.iter().enumerate() {
            let (start, end, mins) = (*start, *end, *mins);
            let title = if n > 1 {
                format!("Leren voor {} {} (sessie {}/{})", label, vak, emit_idx + 1, n)
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
                id: format!("study-test-{}-{}", test.event_id, emit_idx),
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
                estimated_minutes: Some(mins),
                duration_source: Some(DurationSource::AiEstimated),
                source: AiScheduleSource::AiChat,
                created_at: now_iso.clone(),
                updated_at: now_iso.clone(),
                completed_at: None,
            });
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
        if overlaps_planned(&result, start, end) {
            free_slots.push(FreeSlot { start, end });
            free_slots.sort_by_key(|s| s.start);
            continue;
        }
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
        // `now` before wake-up so no today-clamping interferes.
        let now = date.and_hms_opt(6, 0, 0).unwrap();
        let lessons = vec![make_lesson("2026-09-08T09:00:00", "2026-09-08T10:00:00")];
        let locked: Vec<AiScheduleItem> = vec![];
        let settings = ScheduleSettings::default();
        let slots = free_slots_for_day(date, &lessons, &locked, &settings, now);
        // Wake 07:00 to bed 23:00 minus school block 09-10 plus the default
        // 60 min after-school buffer = 2 slots: 07-09 and 11-23.
        assert!(slots.len() >= 2);
        let first = &slots[0];
        assert_eq!(first.start, date.and_hms_opt(7,0,0).unwrap());
        assert_eq!(first.end, date.and_hms_opt(9,0,0).unwrap());
        let second = &slots[1];
        assert_eq!(second.start, date.and_hms_opt(11,0,0).unwrap());
    }

    #[test]
    fn school_gaps_plannable_when_enabled() {
        let date = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap();
        let now = date.and_hms_opt(6, 0, 0).unwrap();
        let lessons = vec![
            make_lesson("2026-09-08T09:00:00", "2026-09-08T10:00:00"),
            make_lesson("2026-09-08T11:00:00", "2026-09-08T12:00:00"),
        ];
        let locked: Vec<AiScheduleItem> = vec![];
        let mut settings = ScheduleSettings::default();
        settings.plan_in_school_gaps = true;
        settings.after_school_buffer_min = 0;
        let slots = free_slots_for_day(date, &lessons, &locked, &settings, now);
        // The 10:00-11:00 tussenure must be offered when gaps are enabled.
        assert!(slots.iter().any(|s| s.start == date.and_hms_opt(10, 0, 0).unwrap()
            && s.end == date.and_hms_opt(11, 0, 0).unwrap()));
    }

    #[test]
    fn today_is_clamped_to_now() {
        let date = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap();
        // Simulate running the planner at 16:37.
        let now = date.and_hms_opt(16, 37, 0).unwrap();
        let lessons: Vec<CalendarEvent> = vec![];
        let locked: Vec<AiScheduleItem> = vec![];
        let settings = ScheduleSettings::default();
        let slots = free_slots_for_day(date, &lessons, &locked, &settings, now);
        assert_eq!(slots.len(), 1);
        // Rounded up to the next 5 minutes: 16:40.
        assert_eq!(slots[0].start, date.and_hms_opt(16, 40, 0).unwrap());
    }

    #[test]
    fn latest_fit_spreads_work_across_days() {
        let start = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 9, 14).unwrap();
        let lessons: Vec<CalendarEvent> = vec![];
        let locked: Vec<AiScheduleItem> = vec![];
        let existing: Vec<AiScheduleItem> = vec![];
        let settings = ScheduleSettings::default();
        let mut map = std::collections::HashMap::new();
        // Two assignments: one due tomorrow, one due in 6 days.
        let assignments = vec![
            AssignmentInput {
                id: 1,
                titel: "Spoed".to_string(),
                vak: Some("Nederlands".to_string()),
                inleveren_voor: "2026-09-09T12:00:00".to_string(),
                omschrijving: None,
            },
            AssignmentInput {
                id: 2,
                titel: "Later".to_string(),
                vak: Some("Wiskunde".to_string()),
                inleveren_voor: "2026-09-14T12:00:00".to_string(),
                omschrijving: None,
            },
        ];
        map.insert(1, (45, DurationSource::UserEntered));
        map.insert(2, (45, DurationSource::UserEntered));
        let plan = generate_plan(start, end, &lessons, &locked, &assignments, &existing, &settings, &map);
        let work1 = plan.iter().find(|i| i.related_assignment_id == Some(1)).unwrap();
        let work2 = plan.iter().find(|i| i.related_assignment_id == Some(2)).unwrap();
        let d1 = iso_to_naive(&work1.start).unwrap().date();
        let d2 = iso_to_naive(&work2.start).unwrap().date();
        // Urgent work lands on/before its deadline day, later work lands later.
        assert!(d1 <= NaiveDate::from_ymd_opt(2026, 9, 9).unwrap());
        assert!(d2 > d1, "work for a later deadline should not pile onto the same early day");
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
        // Spread across days: chunks land on different days (day gap = break).
        let mut days: Vec<NaiveDate> = work_blocks.iter().map(|b| iso_to_naive(&b.start).unwrap().date()).collect();
        days.sort();
        days.dedup();
        assert!(days.len() >= 2, "chunks of a long assignment should spread across days");
        // No two generated work blocks may overlap.
        for (a, b) in work_blocks.iter().zip(work_blocks.iter().skip(1)) {
            let (as_, ae) = (iso_to_naive(&a.start).unwrap(), iso_to_naive(&a.end).unwrap());
            let (bs, be) = (iso_to_naive(&b.start).unwrap(), iso_to_naive(&b.end).unwrap());
            assert!(!items_overlap(as_, ae, bs, be), "generated blocks must not overlap");
        }
    }
}
