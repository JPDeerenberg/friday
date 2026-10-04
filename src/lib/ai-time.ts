/**
 * Amsterdam time utilities for the AI assistant.
 *
 * Phase 1 of fixes/friday-ai-upgrade-plan.md ("Time awareness").
 *
 * Every user-facing "today" in AI code must come from here — never from
 * `new Date().toISOString().slice(0, 10)`, which is UTC and therefore wrong
 * between 00:00 and 02:00 Dutch time. All functions resolve in
 * `Europe/Amsterdam` via `Intl.DateTimeFormat` and mirror
 * `src-tauri/src/ai/time.rs` (same names, same shapes, same Dutch strings).
 */

export const AMSTERDAM_TZ = "Europe/Amsterdam" as const;

export interface AmsterdamNow {
  /** Wall-clock ISO with offset, e.g. "2026-10-02T14:35:00+02:00". */
  iso: string;
  /** Calendar date in Amsterdam, yyyy-MM-dd. */
  date: string;
  /** Wall-clock time in Amsterdam, HH:mm (24h). */
  time: string;
  /** Lowercase Dutch weekday, e.g. "vrijdag". */
  weekday_nl: string;
  /** ISO-8601 week number (1-53). */
  weekNumber: number;
  tz: typeof AMSTERDAM_TZ;
  /** "+01:00" (CET) or "+02:00" (CEST). */
  utcOffset: string;
}

export interface ContextWindow {
  /** Monday of last week, yyyy-MM-dd (Amsterdam). */
  start: string;
  /** Sunday of next week, yyyy-MM-dd (Amsterdam). */
  end: string;
}

const WEEKDAYS_NL = [
  "maandag",
  "dinsdag",
  "woensdag",
  "donderdag",
  "vrijdag",
  "zaterdag",
  "zondag",
] as const;

const MONTHS_NL = [
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
] as const;

const MONTHS_NL_SHORT = [
  "jan",
  "feb",
  "mrt",
  "apr",
  "mei",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
] as const;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function partsOf(at: Date): {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
} {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: AMSTERDAM_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(at);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  };
}

function pad2(n: number): string {
  return `${n}`.padStart(2, "0");
}

/** Minutes Amsterdam is ahead of UTC at this instant (60 = CET, 120 = CEST). */
function offsetMinutes(at: Date): number {
  const p = partsOf(at);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - at.getTime()) / 60000);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** ISO-8601 week number for an Amsterdam calendar date (y, mo 1-12, d). */
function isoWeekNumber(y: number, mo: number, d: number): number {
  // Thursday rule: the week containing Thursday defines week 1.
  const date = new Date(Date.UTC(y, mo - 1, d));
  const day = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const thursday = new Date(date.getTime() + (3 - day) * 86400000);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const yearStartDay = (yearStart.getUTCDay() + 6) % 7;
  const week1Monday = yearStart.getTime() - yearStartDay * 86400000;
  return Math.floor((thursday.getTime() - week1Monday) / (7 * 86400000)) + 1;
}

/** Current moment resolved in Europe/Amsterdam. Pass `at` only in tests. */
export function nowAmsterdam(at?: Date): AmsterdamNow {
  const instant = at ?? new Date();
  const p = partsOf(instant);
  const offMin = offsetMinutes(instant);
  const utcOffset = formatOffset(offMin);
  const date = `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
  const time = `${pad2(p.h)}:${pad2(p.mi)}`;
  const weekdayIdx =
    (new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() + 6) % 7;
  return {
    iso: `${date}T${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}${utcOffset}`,
    date,
    time,
    weekday_nl: WEEKDAYS_NL[weekdayIdx],
    weekNumber: isoWeekNumber(p.y, p.mo, p.d),
    tz: AMSTERDAM_TZ,
    utcOffset,
  };
}

/** Shorthand for `nowAmsterdam(at).date` — the user-facing "today". */
export function todayAmsterdam(at?: Date): string {
  return nowAmsterdam(at).date;
}

/** Parse yyyy-MM-dd, throwing on anything else (programmer error, never user input). */
function parseDateStr(dateStr: string): { y: number; mo: number; d: number } {
  const m = DATE_RE.exec(dateStr);
  if (!m) throw new Error(`ai-time: expected yyyy-MM-dd, got "${dateStr}"`);
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

/** True for real calendar dates only ("2026-13-99" and "not-a-date" fail). */
export function isValidDateStr(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d
  );
}

/** Whole days from `a` to `b` (both yyyy-MM-dd). */
export function diffDays(a: string, b: string): number {
  const pa = parseDateStr(a);
  const pb = parseDateStr(b);
  return Math.round(
    (Date.UTC(pb.y, pb.mo - 1, pb.d) - Date.UTC(pa.y, pa.mo - 1, pa.d)) /
      86400000,
  );
}

/** Shift a yyyy-MM-dd calendar date by n days (negative allowed). */
export function addDays(dateStr: string, n: number): string {
  const { y, mo, d } = parseDateStr(dateStr);
  const t = new Date(Date.UTC(y, mo - 1, d) + n * 86400000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Monday (1) .. Sunday (7) for a yyyy-MM-dd date. */
export function weekdayIndex(dateStr: string): number {
  const { y, mo, d } = parseDateStr(dateStr);
  return ((new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** Monday of the week containing `dateStr`. */
export function startOfWeek(dateStr: string): string {
  return addDays(dateStr, -(weekdayIndex(dateStr) - 1));
}

/** Next Monday–Friday after `dateStr` (skips Sat/Sun; holidays out of scope). */
export function nextSchoolDay(dateStr: string): string {
  let d = addDays(dateStr, 1);
  while (weekdayIndex(d) > 5) d = addDays(d, 1);
  return d;
}

/**
 * Default AI data window: Monday of last week through Sunday of next week
 * (21 days). Accepts an Amsterdam yyyy-MM-dd date, a Date instant, or
 * defaults to right now.
 */
export function getContextWindow(now?: Date | string): ContextWindow {
  const today = typeof now === "string" ? now : todayAmsterdam(now);
  const thisMonday = startOfWeek(today);
  return { start: addDays(thisMonday, -7), end: addDays(thisMonday, 13) };
}

function longDay(dateStr: string): string {
  const { y, mo, d } = parseDateStr(dateStr);
  const idx = (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
  return `${WEEKDAYS_NL[idx]} ${d} ${MONTHS_NL[mo - 1]}`;
}

function shortRange(start: string, end: string): string {
  const s = parseDateStr(start);
  const e = parseDateStr(end);
  const left =
    s.y === e.y
      ? `${s.d} ${MONTHS_NL_SHORT[s.mo - 1]}`
      : `${s.d} ${MONTHS_NL_SHORT[s.mo - 1]} ${s.y}`;
  return `${left} t/m ${e.d} ${MONTHS_NL_SHORT[e.mo - 1]} ${e.y}`;
}

/**
 * Dutch NOW block injected into the system prompt on every request and
 * returned by the `get_current_time` tool. Pass `at` only in tests.
 *
 *   NU: vrijdag 2 oktober 2026, 14:35 (Europe/Amsterdam, week 40, 2026-10-02)
 *   Morgen: zaterdag 3 oktober. Volgende schooldag: maandag 5 oktober.
 *   Context-venster: 21 sep t/m 11 okt 2026.
 *
 * The trailing ISO date is deliberate: the model needs yyyy-MM-dd for tool
 * arguments and must never invent it.
 */
export function formatNowBlock(at?: Date): string {
  const now = nowAmsterdam(at);
  const { y, mo, d } = parseDateStr(now.date);
  const win = getContextWindow(now.date);
  const morgen = addDays(now.date, 1);
  const schooldag = nextSchoolDay(now.date);
  return (
    `NU: ${now.weekday_nl} ${d} ${MONTHS_NL[mo - 1]} ${y}, ${now.time} (${AMSTERDAM_TZ}, week ${now.weekNumber}, ${now.date})\n` +
    `Morgen: ${longDay(morgen)}. Volgende schooldag: ${longDay(schooldag)}.\n` +
    `Context-venster: ${shortRange(win.start, win.end)}.`
  );
}

/**
 * JSON payload for the `get_current_time` tool — same shape as
 * Rust `ai::time::current_time_json()`.
 */
export function currentTimeJson(at?: Date): Record<string, unknown> {
  const now = nowAmsterdam(at);
  const win = getContextWindow(now.date);
  return {
    iso: now.iso,
    date: now.date,
    time: now.time,
    weekday_nl: now.weekday_nl,
    week_number: now.weekNumber,
    tz: now.tz,
    utc_offset: now.utcOffset,
    morgen: addDays(now.date, 1),
    volgende_schooldag: nextSchoolDay(now.date),
    context_venster: { start: win.start, end: win.end },
    tekst: formatNowBlock(at),
  };
}
