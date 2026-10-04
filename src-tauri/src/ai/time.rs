//! Amsterdam time utilities for the AI assistant.
//!
//! Phase 1 of `fixes/friday-ai-upgrade-plan.md` ("Time awareness").
//!
//! Every user-facing "today" in AI code must come from here — never from
//! `chrono::Utc::now()` or `chrono::Local::now()` formatted directly, which is
//! UTC (or an arbitrary device zone) and therefore wrong around midnight Dutch
//! time. Mirrors `src/lib/ai-time.ts`: same functions, same Dutch strings.

use chrono::{Datelike, NaiveDate, TimeZone, Timelike, Utc};

/// IANA zone all AI "today" values resolve in.
pub const AMSTERDAM: chrono_tz::Tz = chrono_tz::Europe::Amsterdam;
/// Shown to the model so it knows which zone the NOW block uses.
pub const AMSTERDAM_TZ_NAME: &str = "Europe/Amsterdam";

/// Monday-first Dutch weekday names (index with `weekday.number_from_monday() - 1`).
const WEEKDAYS_NL: [&str; 7] = [
    "maandag",
    "dinsdag",
    "woensdag",
    "donderdag",
    "vrijdag",
    "zaterdag",
    "zondag",
];

const MONTHS_NL: [&str; 12] = [
    "januari",
    "februari",
    "maart",
    "april",
    "mei",
    "juni",
    "juli",
    "augustus",
    "september",
    "oktober",
    "november",
    "december",
];

const MONTHS_NL_SHORT: [&str; 12] = [
    "jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec",
];

/// Current moment resolved in Europe/Amsterdam. Mirrors TS `AmsterdamNow`.
pub struct AmsterdamNow {
    /// Wall-clock ISO with offset, e.g. "2026-10-02T14:35:00+02:00".
    pub iso: String,
    /// Calendar date in Amsterdam, yyyy-MM-dd.
    pub date: String,
    /// Wall-clock time in Amsterdam, HH:mm (24h).
    pub time: String,
    /// Lowercase Dutch weekday, e.g. "vrijdag".
    pub weekday_nl: String,
    /// ISO-8601 week number (1-53).
    pub week_number: u32,
    pub tz: &'static str,
    /// "+01:00" (CET) or "+02:00" (CEST).
    pub utc_offset: String,
}

/// Default AI data window: Monday of last week through Sunday of next week.
/// Mirrors TS `ContextWindow`.
pub struct ContextWindow {
    pub start: String,
    pub end: String,
}

/// Lowercase Dutch weekday name for a chrono weekday.
pub fn weekday_nl(weekday: chrono::Weekday) -> &'static str {
    WEEKDAYS_NL[(weekday.number_from_monday() - 1) as usize]
}

/// Current moment resolved in Europe/Amsterdam.
pub fn now_amsterdam() -> AmsterdamNow {
    now_amsterdam_at(Utc::now())
}

/// Same as [`now_amsterdam`] for a fixed instant (tests).
pub fn now_amsterdam_at(utc: chrono::DateTime<Utc>) -> AmsterdamNow {
    let local = AMSTERDAM.from_utc_datetime(&utc.naive_utc());
    let date = local.format("%Y-%m-%d").to_string();
    let time = local.format("%H:%M").to_string();
    let utc_offset = local.format("%:z").to_string();
    let iso = format!("{}T{}{}", date, local.format("%H:%M:%S"), utc_offset);
    AmsterdamNow {
        iso,
        date,
        time,
        weekday_nl: weekday_nl(local.weekday()).to_string(),
        week_number: local.iso_week().week(),
        tz: AMSTERDAM_TZ_NAME,
        utc_offset,
    }
}

/// Shorthand for the user-facing "today".
pub fn today_amsterdam() -> String {
    now_amsterdam().date
}

fn parse_date(date_str: &str) -> NaiveDate {
    NaiveDate::parse_from_str(date_str, "%Y-%m-%d").expect("ai::time: expected yyyy-MM-dd")
}

/// Non-panicking parse for model-supplied dates.
pub fn parse_date_opt(date_str: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok()
}

/// True for real calendar dates only ("2026-13-99" and free text fail).
pub fn is_valid_date_str(s: &str) -> bool {
    parse_date_opt(s).is_some()
}

/// Whole days from `a` to `b` (both yyyy-MM-dd). Returns `None` when either
/// side is not a real date.
pub fn diff_days_opt(a: &str, b: &str) -> Option<i64> {
    match (parse_date_opt(a), parse_date_opt(b)) {
        (Some(pa), Some(pb)) => Some((pb - pa).num_days()),
        _ => None,
    }
}

/// Shift a yyyy-MM-dd calendar date by n days (negative allowed).
pub fn add_days(date_str: &str, days: i64) -> String {
    let shifted = parse_date(date_str) + chrono::Duration::days(days);
    shifted.format("%Y-%m-%d").to_string()
}

/// Monday (1) .. Sunday (7) for a yyyy-MM-dd date.
pub fn weekday_index(date_str: &str) -> u32 {
    use chrono::Weekday;
    match parse_date(date_str).weekday() {
        Weekday::Mon => 1,
        Weekday::Tue => 2,
        Weekday::Wed => 3,
        Weekday::Thu => 4,
        Weekday::Fri => 5,
        Weekday::Sat => 6,
        Weekday::Sun => 7,
    }
}

/// Monday of the week containing `date_str`.
pub fn start_of_week(date_str: &str) -> String {
    add_days(date_str, -((weekday_index(date_str) - 1) as i64))
}

/// Next Monday–Friday after `date_str` (skips Sat/Sun; holidays out of scope).
pub fn next_school_day(date_str: &str) -> String {
    let mut d = add_days(date_str, 1);
    while weekday_index(&d) > 5 {
        d = add_days(&d, 1);
    }
    d
}

/// Default AI data window for an Amsterdam yyyy-MM-dd date.
pub fn context_window(today: &str) -> ContextWindow {
    let monday = start_of_week(today);
    ContextWindow {
        start: add_days(&monday, -7),
        end: add_days(&monday, 13),
    }
}

fn long_day(date_str: &str) -> String {
    let d = parse_date(date_str);
    format!(
        "{} {} {}",
        weekday_nl(d.weekday()),
        d.day(),
        MONTHS_NL[(d.month() - 1) as usize]
    )
}

fn short_range(start: &str, end: &str) -> String {
    let s = parse_date(start);
    let e = parse_date(end);
    let left = if s.year() == e.year() {
        format!("{} {}", s.day(), MONTHS_NL_SHORT[(s.month() - 1) as usize])
    } else {
        format!(
            "{} {} {}",
            s.day(),
            MONTHS_NL_SHORT[(s.month() - 1) as usize],
            s.year()
        )
    };
    format!(
        "{} t/m {} {} {}",
        left,
        e.day(),
        MONTHS_NL_SHORT[(e.month() - 1) as usize],
        e.year()
    )
}

/// Dutch NOW block injected into the system prompt on every request and
/// returned by the `get_current_time` tool. Same text as TS `formatNowBlock()`.
/// The trailing ISO date is deliberate: the model needs yyyy-MM-dd for tool
/// arguments and must never invent it.
pub fn format_now_block() -> String {
    format_now_block_at(Utc::now())
}

/// Same as [`format_now_block`] for a fixed instant (tests).
pub fn format_now_block_at(utc: chrono::DateTime<Utc>) -> String {
    let now = now_amsterdam_at(utc);
    let d = parse_date(&now.date);
    let win = context_window(&now.date);
    let morgen = add_days(&now.date, 1);
    let schooldag = next_school_day(&now.date);
    format!(
        "NU: {} {} {} {}, {} ({}, week {}, {})\nMorgen: {}. Volgende schooldag: {}.\nContext-venster: {}.",
        now.weekday_nl,
        d.day(),
        MONTHS_NL[(d.month() - 1) as usize],
        d.year(),
        now.time,
        AMSTERDAM_TZ_NAME,
        now.week_number,
        now.date,
        long_day(&morgen),
        long_day(&schooldag),
        short_range(&win.start, &win.end)
    )
}

/// JSON payload for the `get_current_time` tool — same shape as
/// TS `currentTimeJson()`.
pub fn current_time_json() -> serde_json::Value {
    current_time_json_at(Utc::now())
}

/// Same as [`current_time_json`] for a fixed instant (tests).
pub fn current_time_json_at(utc: chrono::DateTime<Utc>) -> serde_json::Value {
    let now = now_amsterdam_at(utc);
    let win = context_window(&now.date);
    serde_json::json!({
        "iso": now.iso,
        "date": now.date,
        "time": now.time,
        "weekday_nl": now.weekday_nl,
        "week_number": now.week_number,
        "tz": now.tz,
        "utc_offset": now.utc_offset,
        "morgen": add_days(&now.date, 1),
        "volgende_schooldag": next_school_day(&now.date),
        "context_venster": { "start": win.start, "end": win.end },
        "tekst": format_now_block_at(utc),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn utc_2330_is_next_day_in_amsterdam() {
        let n = now_amsterdam_at(utc(2026, 10, 1, 23, 30));
        assert_eq!(n.date, "2026-10-02");
        assert_eq!(n.time, "01:30");
        assert_eq!(n.weekday_nl, "vrijdag");
        assert_eq!(n.week_number, 40);
        assert_eq!(n.tz, "Europe/Amsterdam");
        assert_eq!(n.utc_offset, "+02:00");
        assert_eq!(n.iso, "2026-10-02T01:30:00+02:00");
    }

    #[test]
    fn spring_forward_skips_0200() {
        let before = now_amsterdam_at(utc(2026, 3, 29, 0, 30));
        assert_eq!(before.time, "01:30");
        assert_eq!(before.utc_offset, "+01:00");
        let after = now_amsterdam_at(utc(2026, 3, 29, 1, 30));
        assert_eq!(after.time, "03:30");
        assert_eq!(after.utc_offset, "+02:00");
        assert_eq!(after.weekday_nl, "zondag");
    }

    #[test]
    fn fall_back_repeats_0200() {
        let first = now_amsterdam_at(utc(2026, 10, 25, 0, 30));
        assert_eq!(first.time, "02:30");
        assert_eq!(first.utc_offset, "+02:00");
        let second = now_amsterdam_at(utc(2026, 10, 25, 1, 30));
        assert_eq!(second.time, "02:30");
        assert_eq!(second.utc_offset, "+01:00");
    }

    #[test]
    fn year_boundary_resolves_in_amsterdam() {
        let n = now_amsterdam_at(utc(2025, 12, 31, 23, 30));
        assert_eq!(n.date, "2026-01-01");
        assert_eq!(n.weekday_nl, "donderdag");
        assert_eq!(n.week_number, 1);
        assert_eq!(n.utc_offset, "+01:00");
    }

    #[test]
    fn iso_week_53_exists() {
        assert_eq!(now_amsterdam_at(utc(2020, 12, 31, 12, 0)).week_number, 53);
        assert_eq!(now_amsterdam_at(utc(2021, 1, 1, 12, 0)).week_number, 53);
        assert_eq!(now_amsterdam_at(utc(2021, 1, 4, 12, 0)).week_number, 1);
    }

    #[test]
    fn calendar_helpers() {
        assert_eq!(add_days("2026-10-02", 1), "2026-10-03");
        assert_eq!(add_days("2026-10-02", -1), "2026-10-01");
        assert_eq!(add_days("2025-12-31", 1), "2026-01-01");
        assert_eq!(add_days("2024-02-28", 1), "2024-02-29");
        assert_eq!(start_of_week("2026-10-02"), "2026-09-28");
        assert_eq!(start_of_week("2026-09-28"), "2026-09-28");
        assert_eq!(start_of_week("2026-10-04"), "2026-09-28");
        assert_eq!(next_school_day("2026-10-02"), "2026-10-05");
        assert_eq!(next_school_day("2026-10-03"), "2026-10-05");
        assert_eq!(next_school_day("2026-10-04"), "2026-10-05");
        assert_eq!(next_school_day("2026-10-05"), "2026-10-06");
    }

    #[test]
    fn date_validation() {
        assert!(is_valid_date_str("2026-09-21"));
        assert!(is_valid_date_str("2024-02-29"));
        assert!(!is_valid_date_str("2026-13-01"));
        assert!(!is_valid_date_str("2026-02-29"));
        assert!(!is_valid_date_str("volgende week"));
        assert_eq!(diff_days_opt("2026-01-01", "2026-03-04"), Some(62));
        assert_eq!(diff_days_opt("2026-09-27", "2026-09-21"), Some(-6));
        assert_eq!(diff_days_opt("x", "2026-09-21"), None);
    }

    #[test]
    fn context_window_edges() {
        let win = context_window("2026-10-02");
        assert_eq!(win.start, "2026-09-21");
        assert_eq!(win.end, "2026-10-11");
        assert_eq!(context_window("2026-09-28").start, win.start);
        assert_eq!(context_window("2026-10-04").end, win.end);
        assert_eq!(weekday_index(&win.start), 1);
        assert_eq!(weekday_index(&win.end), 7);
        let nye = context_window("2025-12-31");
        assert_eq!(nye.start, "2025-12-22");
        assert_eq!(nye.end, "2026-01-11");
    }

    #[test]
    fn now_block_matches_spec_example() {
        let block = format_now_block_at(utc(2026, 10, 2, 12, 35));
        let mut lines = block.lines();
        assert_eq!(
            lines.next().unwrap(),
            "NU: vrijdag 2 oktober 2026, 14:35 (Europe/Amsterdam, week 40, 2026-10-02)"
        );
        assert_eq!(
            lines.next().unwrap(),
            "Morgen: zaterdag 3 oktober. Volgende schooldag: maandag 5 oktober."
        );
        assert_eq!(
            lines.next().unwrap(),
            "Context-venster: 21 sep t/m 11 okt 2026."
        );
    }

    #[test]
    fn current_time_json_shape() {
        let j = current_time_json_at(utc(2026, 10, 2, 12, 35));
        assert_eq!(j["date"], "2026-10-02");
        assert_eq!(j["week_number"], 40);
        assert_eq!(j["tz"], "Europe/Amsterdam");
        assert_eq!(j["morgen"], "2026-10-03");
        assert_eq!(j["volgende_schooldag"], "2026-10-05");
        assert!(j["tekst"]
            .as_str()
            .unwrap()
            .starts_with("NU: vrijdag 2 oktober 2026"));
    }
}
