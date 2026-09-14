/**
 * Browser port of `src-tauri/src/ai/schedule.rs`: the Friday's-Plan planner.
 *
 * Date model: chrono `NaiveDateTime` wall time is represented as a number —
 * milliseconds of the wall components read as UTC (`Date.UTC(y, mo, d, h, mi)`).
 * All arithmetic is integer ms math, so results are timezone-independent and
 * bit-identical to the Rust date logic. Offset-bearing inputs
 * (`...Z`, `+02:00`) convert through the DEVICE timezone first
 * (`getFullYear()` & co.), exactly like chrono's `.with_timezone(&Local)`.
 *
 * Dutch description strings are copied VERBATIM from the Rust planner — the
 * user reads these as the "why" behind each block.
 */

export interface YMD {
  y: number;
  mo: number; // 1-12
  d: number;
}

export interface FreeSlot {
  start: number; // wall ms
  end: number;
}

export interface ScheduleSettings {
  bedtime: string; // "23:00"
  wakeTime: string; // "07:00"
  blockedTimes: Array<{ day: string; start: string; end: string }>;
  afterSchoolBufferMin: number;
  planInSchoolGaps: boolean;
}

export interface AssignmentInput {
  id: number;
  titel: string;
  vak: string | null;
  inleveren_voor: string;
  omschrijving: string | null;
}

export interface TestInput {
  event_id: number;
  vak: string | null;
  omschrijving: string | null;
  start: number; // wall ms
  info_type: number;
}

export interface HomeworkInput {
  event_id: number;
  vak: string | null;
  omschrijving: string | null;
  les_start: number; // wall ms
}

export interface PlanLesson {
  id: number;
  start: string;
  einde: string;
  status: number;
  info_type: number;
  afgerond: boolean;
  omschrijving: string | null;
  inhoud: string | null;
  vakken: Array<{ naam: string | null }> | null;
}

export interface PlanItem {
  id: string;
  title: string;
  description: string | null;
  item_type: string;
  start: string;
  end: string;
  status: string;
  urgency: number;
  related_assignment_id: number | null;
  related_calendar_event_id: number | null;
  related_subject: string | null;
  estimated_minutes: number | null;
  duration_source: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export const DEFAULT_PLAN_SETTINGS: ScheduleSettings = {
  bedtime: "23:00",
  wakeTime: "07:00",
  blockedTimes: [],
  afterSchoolBufferMin: 60,
  planInSchoolGaps: false,
};

const MIN = 60_000;
const DAY_MS = 86_400_000;

// ─── Wall-clock primitives ─────────────────────────────────────────────────

export function dt(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function parts(t: number): { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number } {
  const d = new Date(t);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    wd: d.getUTCDay(), // 0=Sun
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function fmtYMD(t: number): string {
  const p = parts(t);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
}

export function fmtISO(t: number): string {
  const p = parts(t);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
}

/** Monday=0..Sunday=6 day key for a wall timestamp. */
export function dayKey(t: number): number {
  return Math.floor(t / DAY_MS);
}

function mondayIndex(t: number): number {
  return (parts(t).wd + 6) % 7; // 0=Mon..6=Sun
}

/** Parse the same shapes as Rust `iso_to_naive`, into wall ms. */
export function isoToWall(s: string): number | null {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  // Offset-bearing (RFC3339/Z): convert through DEVICE tz like chrono Local.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return null;
    return dt(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  }
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return dt(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return dt(+m[1], +m[2], +m[3]);
  return null;
}

/** Device-local wall ms "now" (chrono::Local equivalent). */
export function wallNow(): number {
  const d = new Date();
  return dt(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

export function wallTodayStart(): number {
  const d = new Date();
  return dt(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function parseHm(s: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  return [+m[1], +m[2]];
}

// ─── Window / overlap ──────────────────────────────────────────────────────

/** today through coming Sunday plus the following full week. */
export function planningWindow(todayDay: number): [number, number] {
  const weekday = mondayIndex(todayDay * DAY_MS);
  const daysUntilSunday = 6 - weekday;
  const thisSunday = (todayDay + daysUntilSunday) * DAY_MS;
  void thisSunday;
  return [todayDay, todayDay + daysUntilSunday + 7];
}

export function itemsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function intervalsOverlapStr(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = isoToWall(aStart);
  const ae = isoToWall(aEnd);
  const bs = isoToWall(bStart);
  const be = isoToWall(bEnd);
  if (as == null || ae == null || bs == null || be == null) return false;
  return itemsOverlap(as, ae, bs, be);
}

function daysUntil(targetDay: number, todayDay: number): number {
  return targetDay - todayDay;
}

function computeUrgency(deadlineMs: number, todayDay: number): number {
  const days = dayKey(deadlineMs) - todayDay;
  if (days <= 1) return 5;
  if (days <= 3) return 4;
  if (days <= 7) return 3;
  if (days <= 14) return 2;
  return 1;
}

const WEEKDAY_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fmtDayTime(t: number): string {
  const p = parts(t);
  return `${WEEKDAY_EN[mondayIndex(t)]} ${pad2(p.d)}-${pad2(p.mo)} ${pad2(p.h)}:${pad2(p.mi)}`;
}

function fmtDMHM(t: number): string {
  const p = parts(t);
  return `${pad2(p.d)}-${pad2(p.mo)} ${pad2(p.h)}:${pad2(p.mi)}`;
}

// ─── Free slots ────────────────────────────────────────────────────────────

export function computeFreeSlots(
  windowStartDay: number,
  windowEndDay: number,
  lessons: PlanLesson[],
  lockedItems: PlanItem[],
  settings: ScheduleSettings,
  nowMs: number = wallNow(),
): FreeSlot[] {
  const slots: FreeSlot[] = [];
  for (let day = windowStartDay; day <= windowEndDay; day++) {
    slots.push(...freeSlotsForDay(day, lessons, lockedItems, settings, nowMs));
  }
  return slots;
}

/** Exported for tests (private in Rust). */
export function freeSlotsForDay(
  day: number,
  lessons: PlanLesson[],
  lockedItems: PlanItem[],
  settings: ScheduleSettings,
  nowMs: number,
): FreeSlot[] {
  const bed = parseHm(settings.bedtime) ?? [23, 0];
  const wake = parseHm(settings.wakeTime) ?? [7, 0];
  const base = day * DAY_MS;
  const at = (h: number, m: number): number => base + (h * 60 + m) * MIN;

  let dayStart = at(wake[0], wake[1]);
  let dayEnd = at(bed[0], bed[1]);
  if (dayEnd <= dayStart) dayEnd += DAY_MS; // bedtime past midnight

  // Never offer time that already passed; round up to next 5 minutes.
  const nowDay = dayKey(nowMs);
  if (day === nowDay && dayStart < nowMs) {
    const np = parts(nowMs);
    const mins = np.h * 60 + np.mi;
    const rounded = Math.floor((mins + 4) / 5) * 5;
    let candidate: number;
    if (rounded >= 24 * 60) {
      candidate = base + DAY_MS + (rounded - 24 * 60) * MIN;
    } else {
      candidate = base + rounded * MIN;
    }
    dayStart = Math.max(candidate, dayStart);
  }
  if (dayEnd <= dayStart) return [];

  const busy: Array<[number, number]> = [];
  const dayLessons: Array<[number, number]> = [];
  for (const ev of lessons) {
    if (ev.status === 4 || ev.status === 5) continue; // cancelled: not at school
    const s = isoToWall(ev.start);
    const e = isoToWall(ev.einde);
    if (s == null || e == null) continue;
    if (e > dayStart && s < dayEnd) dayLessons.push([Math.max(s, dayStart), Math.min(e, dayEnd)]);
  }
  if (dayLessons.length > 0) {
    dayLessons.sort((a, b) => a[0] - b[0]);
    const schoolStart = dayLessons[0][0];
    const schoolEnd = Math.max(...dayLessons.map(([, e]) => e));
    if (settings.planInSchoolGaps) {
      for (const [s, e] of dayLessons) busy.push([s, e]);
    } else {
      busy.push([schoolStart, schoolEnd]);
    }
    const bufferEnd = schoolEnd + settings.afterSchoolBufferMin * MIN;
    if (bufferEnd > schoolEnd) busy.push([schoolEnd, Math.min(bufferEnd, dayEnd + 6 * 3_600_000)]);
  }

  for (const item of lockedItems) {
    const s = isoToWall(item.start);
    const e = isoToWall(item.end);
    if (s == null || e == null) continue;
    if (e > dayStart && s < dayEnd) {
      const bs = Math.max(s, dayStart);
      const be = Math.min(e, dayEnd);
      if (be > bs) busy.push([bs, be]);
    }
  }

  const weekdayNames = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const wd = mondayIndex(base);
  const dayName = weekdayNames[wd];
  const isoDay = fmtYMD(base);
  for (const bt of settings.blockedTimes) {
    const bday = bt.day.toLowerCase();
    const matches =
      bday === dayName.toLowerCase() ||
      bday === isoDay ||
      bday === "daily" ||
      (bday === "weekday" && wd < 5) ||
      (bday === "weekend" && wd >= 5);
    if (!matches) continue;
    const sHm = parseHm(bt.start);
    const eHm = parseHm(bt.end);
    if (!sHm || !eHm) continue;
    let s = at(sHm[0], sHm[1]);
    let e = at(eHm[0], eHm[1]);
    if (e <= s) e += DAY_MS;
    if (e > dayStart && s < dayEnd) {
      const bs = Math.max(s, dayStart);
      const be = Math.min(e, dayEnd);
      if (be > bs) busy.push([bs, be]);
    }
  }

  busy.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of busy) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }

  const free: FreeSlot[] = [];
  let cursor = dayStart;
  for (const [bs, be] of merged) {
    if (bs > cursor) free.push({ start: cursor, end: bs });
    cursor = Math.max(cursor, be);
  }
  if (dayEnd > cursor) free.push({ start: cursor, end: dayEnd });
  return free.filter((s) => s.end - s.start >= 10 * MIN);
}

export function generateSleepItems(
  windowStartDay: number,
  windowEndDay: number,
  settings: ScheduleSettings,
  nowIso: string,
): PlanItem[] {
  const bed = parseHm(settings.bedtime) ?? [23, 0];
  const wake = parseHm(settings.wakeTime) ?? [7, 0];
  const items: PlanItem[] = [];
  for (let day = windowStartDay; day <= windowEndDay; day++) {
    const base = day * DAY_MS;
    const sleepStart = base + (bed[0] * 60 + bed[1]) * MIN;
    const sleepEnd = base + DAY_MS + (wake[0] * 60 + wake[1]) * MIN;
    items.push({
      id: `sleep-${fmtYMD(base)}`,
      title: "Slaap",
      description: "Vaste slaapperiode — wordt niet ingepland voor huiswerk.",
      item_type: "sleep",
      start: fmtISO(sleepStart),
      end: fmtISO(sleepEnd),
      status: "planned",
      urgency: 1,
      related_assignment_id: null,
      related_calendar_event_id: null,
      related_subject: null,
      estimated_minutes: null,
      duration_source: null,
      source: "ai_chat",
      created_at: nowIso,
      updated_at: nowIso,
      completed_at: null,
    });
  }
  return items;
}

export function generateFreeTimeItems(freeSlots: FreeSlot[], nowIso: string): PlanItem[] {
  return freeSlots.map((slot, i) => ({
    id: `freetime-${fmtYMD(slot.start)}-${i}`,
    title: "Vrije tijd",
    description: "Vrije tijd — je kunt hier zelf iets plannen.",
    item_type: "free_time",
    start: fmtISO(slot.start),
    end: fmtISO(slot.end),
    status: "planned",
    urgency: 1,
    related_assignment_id: null,
    related_calendar_event_id: null,
    related_subject: null,
    estimated_minutes: Math.round((slot.end - slot.start) / MIN),
    duration_source: null,
    source: "ai_chat",
    created_at: nowIso,
    updated_at: nowIso,
    completed_at: null,
  }));
}

export function subjectAverageMinutes(items: PlanItem[], subject: string): number | null {
  let total = 0;
  let count = 0;
  for (const item of items) {
    if (
      item.status === "completed" &&
      item.related_subject === subject &&
      item.estimated_minutes != null &&
      item.duration_source === "user_entered"
    ) {
      total += item.estimated_minutes;
      count++;
    }
  }
  return count > 0 ? Math.floor(total / count) : null;
}

export function extractUpcomingTests(
  lessons: PlanLesson[],
  windowStartDay: number,
  windowEndDay: number,
): TestInput[] {
  const horizon = windowEndDay + 7;
  const out: TestInput[] = [];
  for (const ev of lessons) {
    if (![2, 3, 4, 5].includes(ev.info_type)) continue;
    if (ev.status === 4 || ev.status === 5) continue;
    const start = isoToWall(ev.start);
    if (start == null) continue;
    const d = dayKey(start);
    if (d < windowStartDay - 1 || d > horizon) continue;
    const vakkenRaw = (ev as unknown as Record<string, unknown>)["vakken"];
    const firstVak =
      Array.isArray(vakkenRaw) && vakkenRaw.length > 0
        ? (vakkenRaw[0] as Record<string, unknown> | null)
        : null;
    const vak = typeof firstVak?.["naam"] === "string" ? (firstVak["naam"] as string) : null;
    out.push({
      event_id: ev.id,
      vak,
      omschrijving: ev.omschrijving ?? ev.inhoud ?? null,
      start,
      info_type: ev.info_type,
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export function extractOpenHomework(lessons: PlanLesson[]): HomeworkInput[] {
  const out: HomeworkInput[] = [];
  for (const ev of lessons) {
    if (ev.info_type !== 1 || ev.afgerond) continue;
    if (ev.status === 4 || ev.status === 5) continue;
    const lesStart = isoToWall(ev.start);
    if (lesStart == null) continue;
    const vakkenRaw = (ev as unknown as Record<string, unknown>)["vakken"];
    const firstVak =
      Array.isArray(vakkenRaw) && vakkenRaw.length > 0
        ? (vakkenRaw[0] as Record<string, unknown> | null)
        : null;
    const vak = typeof firstVak?.["naam"] === "string" ? (firstVak["naam"] as string) : null;
    const oms = ev.inhoud ?? ev.omschrijving ?? null;
    if ((!oms || oms.trim() === "") && vak == null) continue;
    out.push({ event_id: ev.id, vak, omschrijving: oms, les_start: lesStart });
  }
  return out;
}

function infoTypeLabel(t: number): string {
  if (t === 2) return "Proefwerk";
  if (t === 3) return "Tentamen";
  if (t === 4) return "SO";
  if (t === 5) return "Mondeling";
  return "Toets";
}

/** Earliest slot that fits. Mutates freeSlots. */
function takeSlot(freeSlots: FreeSlot[], minutes: number): [number, number] | null {
  const idx = freeSlots.findIndex((s) => s.end - s.start >= minutes * MIN);
  if (idx < 0) return null;
  return consumeFront(freeSlots, idx, minutes);
}

/** Latest-fit placement ending no later than latestEnd. Mutates freeSlots. */
function takeLatestSlot(
  freeSlots: FreeSlot[],
  minutes: number,
  latestEnd: number,
  onlyBeforeDay: number | null,
): [number, number] | null {
  let best: number | null = null;
  for (let idx = 0; idx < freeSlots.length; idx++) {
    const s = freeSlots[idx];
    if (s.end - s.start < minutes * MIN) continue;
    if (onlyBeforeDay != null && dayKey(s.start) >= onlyBeforeDay) continue;
    const endLimit = Math.min(s.end, latestEnd);
    if (endLimit - s.start < minutes * MIN) continue;
    if (best == null || s.start > freeSlots[best].start) best = idx;
  }
  if (best == null) return null;
  return consumeFront(freeSlots, best, minutes);
}

function consumeFront(freeSlots: FreeSlot[], idx: number, minutes: number): [number, number] | null {
  const slot = freeSlots[idx];
  if (!slot) return null;
  const start = slot.start;
  const end = start + minutes * MIN;
  if (end > slot.end) return null;
  freeSlots.splice(idx, 1);
  if (slot.end > end && slot.end - end >= 10 * MIN) {
    freeSlots.splice(idx, 0, { start: end, end: slot.end });
  }
  freeSlots.sort((a, b) => a.start - b.start);
  return [start, end];
}

function overlapsPlanned(result: PlanItem[], start: number, end: number): boolean {
  return result.some((it) => {
    const s = isoToWall(it.start);
    const e = isoToWall(it.end);
    return s != null && e != null && itemsOverlap(s, e, start, end);
  });
}

function localNowIso(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ─── Main generation ───────────────────────────────────────────────────────

export interface GeneratePlanInput {
  windowStartDay: number;
  windowEndDay: number;
  lessons: PlanLesson[];
  lockedItems: PlanItem[];
  assignments: AssignmentInput[];
  existingItems: PlanItem[];
  settings: ScheduleSettings;
  durationMap: Map<number, { minutes: number; source: string }>;
  todayDay?: number; // override for tests (default: real today)
  nowIso?: string;
}

export function generatePlan(input: GeneratePlanInput): PlanItem[] {
  const {
    windowStartDay,
    windowEndDay,
    lessons,
    lockedItems,
    assignments,
    existingItems,
    settings,
    durationMap,
  } = input;
  const todayDay = input.todayDay ?? dayKey(wallNow());
  const nowIso = input.nowIso ?? localNowIso();
  const result: PlanItem[] = [];

  const freeSlots = computeFreeSlots(windowStartDay, windowEndDay, lessons, lockedItems, settings);

  const sorted = [...assignments].sort((a, b) => {
    const dla = isoToWall(a.inleveren_voor) ?? (windowEndDay + 1) * DAY_MS + 23 * 3_600_000 + 59 * MIN + 59_000;
    const dlb = isoToWall(b.inleveren_voor) ?? (windowEndDay + 1) * DAY_MS + 23 * 3_600_000 + 59 * MIN + 59_000;
    const ua = computeUrgency(dla, todayDay);
    const ub = computeUrgency(dlb, todayDay);
    if (ua !== ub) return ub - ua;
    return dla - dlb;
  });

  for (const assignment of sorted) {
    const deadline =
      isoToWall(assignment.inleveren_voor) ?? (windowEndDay + 1) * DAY_MS + (23 * 60 + 59) * MIN + 59_000;
    if (dayKey(deadline) < windowStartDay - 7) continue;
    const days = daysUntil(dayKey(deadline), todayDay);
    const daysTxt =
      days < 0 ? `${-days} dag(en) TE LAAT` : days === 0 ? "vandaag" : days === 1 ? "morgen" : `over ${days} dagen`;
    const urgency = computeUrgency(deadline, todayDay);
    const vak = assignment.vak ?? "Algemeen";

    const known = durationMap.get(assignment.id);
    let est: number | null = null;
    let source: string | null = null;
    if (known) {
      est = known.minutes;
      source = known.source;
    } else {
      const avg = assignment.vak ? subjectAverageMinutes(existingItems, assignment.vak) : null;
      if (avg != null) {
        est = avg;
        source = "subject_average";
      }
    }

    if (est == null) {
      const reviewMinutes = 15;
      const placed = takeSlot(freeSlots, reviewMinutes);
      if (placed) {
        const [start, end] = placed;
        if (!overlapsPlanned(result, start, end)) {
          result.push({
            id: `review-${assignment.id}`,
            title: `Bekijk: ${assignment.titel}`,
            description:
              `Reden: nieuw huiswerk voor ${vak} zonder tijdsinschatting (deadline ${fmtDMHM(deadline)}, ${daysTxt}). ` +
              `Eerst 15 min triage: bekijk wat er moet gebeuren en vul de duur in — daarna plant de AI het echte werkblok. Urgentie ${urgency}/5.`,
            item_type: "homework_review",
            start: fmtISO(start),
            end: fmtISO(end),
            status: "planned",
            urgency,
            related_assignment_id: assignment.id,
            related_calendar_event_id: null,
            related_subject: assignment.vak,
            estimated_minutes: reviewMinutes,
            duration_source: "ai_estimated",
            source: "ai_chat",
            created_at: nowIso,
            updated_at: nowIso,
            completed_at: null,
          });
        } else {
          freeSlots.push({ start, end });
          freeSlots.sort((a, b) => a.start - b.start);
        }
      }
      continue;
    }

    const chunkSize = est > 60 ? 60 : est;
    const placements: Array<[number, number, number]> = [];
    let remaining = est;
    let latest = deadline;
    let prevDay: number | null = null;
    while (remaining > 0) {
      const thisChunk = Math.min(remaining, chunkSize);
      const placed =
        (prevDay != null ? takeLatestSlot(freeSlots, thisChunk, latest, prevDay) : null) ??
        takeLatestSlot(freeSlots, thisChunk, latest, null);
      if (!placed) break;
      const [start, end] = placed;
      placements.push([start, end, thisChunk]);
      remaining -= thisChunk;
      latest = start;
      prevDay = dayKey(start);
    }
    if (placements.length === 0) continue;
    placements.sort((a, b) => a[0] - b[0]);
    const totalChunks = placements.length;
    placements.forEach(([start, end, mins], chunkIndex) => {
      const title =
        totalChunks > 1 ? `${assignment.titel} (deel ${chunkIndex + 1}/${totalChunks})` : assignment.titel;
      const desc =
        totalChunks > 1
          ? `Reden: deelsessie ${chunkIndex + 1}/${totalChunks} voor ${vak} (deadline ${fmtDMHM(deadline)}, ${daysTxt}) — gepland op ${fmtDayTime(start)} (${mins} min, urgentie ${urgency}/5) zodat het werk over meerdere dagen is gespreid. ${assignment.omschrijving ?? "Huiswerk maken"}.`
          : `Reden: werksessie voor ${vak} (deadline ${fmtDMHM(deadline)}, ${daysTxt}) — gepland op ${fmtDayTime(start)} (${mins} min, urgentie ${urgency}/5). ${assignment.omschrijving ?? "Huiswerk maken"}.`;
      result.push({
        id: `work-${assignment.id}-${chunkIndex}`,
        title,
        description: desc,
        item_type: "assignment_work",
        start: fmtISO(start),
        end: fmtISO(end),
        status: "planned",
        urgency,
        related_assignment_id: assignment.id,
        related_calendar_event_id: null,
        related_subject: assignment.vak,
        estimated_minutes: mins,
        duration_source: source,
        source: "ai_chat",
        created_at: nowIso,
        updated_at: nowIso,
        completed_at: null,
      });
    });
  }

  // --- Tests: study blocks ---
  const tests = extractUpcomingTests(lessons, windowStartDay, windowEndDay);
  for (const test of tests) {
    const days = daysUntil(dayKey(test.start), todayDay);
    const urgency = computeUrgency(test.start, todayDay);
    const vak = test.vak ?? "Onbekend vak";
    const label = infoTypeLabel(test.info_type);
    const sessions = days <= 3 ? 2 : 1;
    const placed: Array<[number, number, number]> = [];
    for (let sIdx = 0; sIdx < sessions; sIdx++) {
      const minutes = 45;
      const latestEnd = test.start - sIdx * DAY_MS;
      let slot: [number, number] | null = null;
      if (sIdx === 0) {
        slot = takeLatestSlot(freeSlots, minutes, latestEnd, null);
      } else {
        const prevDay = placed.length > 0 ? dayKey(placed[0][0]) : null;
        slot =
          (prevDay != null ? takeLatestSlot(freeSlots, minutes, latestEnd, prevDay) : null) ??
          takeLatestSlot(freeSlots, minutes, latestEnd, null);
      }
      if (!slot) break;
      const [start, end] = slot;
      if (end > test.start || overlapsPlanned(result, start, end)) {
        freeSlots.push({ start, end });
        freeSlots.sort((a, b) => a.start - b.start);
        break;
      }
      placed.push([start, end, minutes]);
    }
    placed.sort((a, b) => a[0] - b[0]);
    const n = placed.length;
    placed.forEach(([start, end, mins], emitIdx) => {
      const title =
        n > 1 ? `Leren voor ${label} ${vak} (sessie ${emitIdx + 1}/${n})` : `Leren voor ${label} ${vak}`;
      const whenTxt = days < 0 ? "geweest" : days === 0 ? "vandaag" : `over ${days} dagen`;
      result.push({
        id: `study-test-${test.event_id}-${emitIdx}`,
        title,
        description:
          `Reden: ${label} ${vak} op ${fmtDayTime(test.start)} (${whenTxt}). Voorbereiding — geen specifieke opdracht, wel herhalen/oefenen. Urgentie ${urgency}/5.`,
        item_type: "study_block",
        start: fmtISO(start),
        end: fmtISO(end),
        status: "planned",
        urgency,
        related_assignment_id: null,
        related_calendar_event_id: test.event_id,
        related_subject: test.vak,
        estimated_minutes: mins,
        duration_source: "ai_estimated",
        source: "ai_chat",
        created_at: nowIso,
        updated_at: nowIso,
        completed_at: null,
      });
    });
  }

  // --- Open calendar homework: short work blocks ---
  const homeworks = extractOpenHomework(lessons);
  for (const hw of homeworks) {
    if (result.some((i) => i.related_calendar_event_id === hw.event_id)) continue;
    if (
      existingItems.some(
        (i) =>
          i.related_calendar_event_id === hw.event_id && (i.status === "planned" || i.status === "in_progress"),
      )
    ) {
      continue;
    }
    const vak = hw.vak ?? "Algemeen";
    const est = (hw.vak ? subjectAverageMinutes(existingItems, hw.vak) : null) ?? 30;
    const placed = takeSlot(freeSlots, est);
    if (!placed) continue;
    const [start, end] = placed;
    if (overlapsPlanned(result, start, end)) {
      freeSlots.push({ start, end });
      freeSlots.sort((a, b) => a.start - b.start);
      continue;
    }
    result.push({
      id: `hw-cal-${hw.event_id}`,
      title: `Huiswerk: ${vak}`,
      description:
        `Reden: huiswerk uit de les (${vak} op ${fmtDayTime(hw.les_start)}). Korte werksessie van ${est} min — maak/af wat in de les is opgegeven. Vak-gemiddelde of 30 min default.`,
      item_type: "assignment_work",
      start: fmtISO(start),
      end: fmtISO(end),
      status: "planned",
      urgency: 3,
      related_assignment_id: null,
      related_calendar_event_id: hw.event_id,
      related_subject: hw.vak,
      estimated_minutes: est,
      duration_source: "subject_average",
      source: "ai_chat",
      created_at: nowIso,
      updated_at: nowIso,
      completed_at: null,
    });
  }

  result.push(...generateFreeTimeItems(freeSlots, nowIso));
  result.push(...generateSleepItems(windowStartDay, windowEndDay, settings, nowIso));
  result.sort((a, b) => {
    const as = isoToWall(a.start) ?? 0;
    const bs = isoToWall(b.start) ?? 0;
    return as - bs;
  });

  const seen = new Set<string>();
  return result.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
