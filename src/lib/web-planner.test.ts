/**
 * Golden tests for the planner port (src/lib/web-planner.ts), translated
 * 1:1 from src-tauri/src/ai/schedule.rs `mod tests` — same dates, same
 * assertions, same time-sensitivity characteristics as the originals.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/web-planner.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import {
  dt,
  extractOpenHomework,
  extractUpcomingTests,
  freeSlotsForDay,
  generateFreeTimeItems,
  generatePlan,
  generateSleepItems,
  intervalsOverlapStr,
  isoToWall,
  itemsOverlap,
  planningWindow,
  DEFAULT_PLAN_SETTINGS,
  type PlanItem,
  type PlanLesson,
} from "./web-planner.ts";
import {
  findScheduleOverlap,
  inRange,
  validateScheduleItem,
} from "./web-ai-schedule-store.ts";
import type { AiScheduleItem } from "./ai-schedule-types.ts";

function lesson(start: string, einde: string, extra: Partial<PlanLesson> = {}): PlanLesson {
  return {
    id: 1,
    start,
    einde,
    status: 2,
    info_type: 0,
    afgerond: false,
    omschrijving: "Les",
    inhoud: null,
    vakken: [{ naam: "Wiskunde" }],
    ...extra,
  };
}

const D = (y: number, mo: number, d: number, h = 0, mi = 0): number => dt(y, mo, d, h, mi);

test("planning_window covers two weeks", () => {
  // Tuesday 2026-09-08 → start today, end coming Sunday + next week = 09-20.
  const todayDay = Math.floor(D(2026, 9, 8) / 86_400_000);
  const [start, end] = planningWindow(todayDay);
  assert.strictEqual(start, todayDay);
  assert.strictEqual(end, todayDay + 5 + 7);
});

test("free_slots excludes lessons", () => {
  const day = Math.floor(D(2026, 9, 8) / 86_400_000);
  const now = D(2026, 9, 8, 6, 0); // before wake-up: no today-clamping
  const lessons = [lesson("2026-09-08T09:00:00", "2026-09-08T10:00:00")];
  const slots = freeSlotsForDay(day, lessons, [], DEFAULT_PLAN_SETTINGS, now);
  // Wake 07:00 to bed 23:00 minus school block 09-10 plus the default
  // 60 min after-school buffer = 2 slots: 07-09 and 11-23.
  assert.ok(slots.length >= 2);
  assert.strictEqual(slots[0].start, D(2026, 9, 8, 7, 0));
  assert.strictEqual(slots[0].end, D(2026, 9, 8, 9, 0));
  assert.strictEqual(slots[1].start, D(2026, 9, 8, 11, 0));
});

test("school gaps plannable when enabled", () => {
  const day = Math.floor(D(2026, 9, 8) / 86_400_000);
  const now = D(2026, 9, 8, 6, 0);
  const lessons = [
    lesson("2026-09-08T09:00:00", "2026-09-08T10:00:00"),
    lesson("2026-09-08T11:00:00", "2026-09-08T12:00:00"),
  ];
  const settings = { ...DEFAULT_PLAN_SETTINGS, planInSchoolGaps: true, afterSchoolBufferMin: 0 };
  const slots = freeSlotsForDay(day, lessons, [], settings, now);
  assert.ok(
    slots.some((s) => s.start === D(2026, 9, 8, 10, 0) && s.end === D(2026, 9, 8, 11, 0)),
    "tussenure 10-11 must be offered",
  );
});

test("today is clamped to now", () => {
  const day = Math.floor(D(2026, 9, 8) / 86_400_000);
  const now = D(2026, 9, 8, 16, 37); // 16:37
  const slots = freeSlotsForDay(day, [], [], DEFAULT_PLAN_SETTINGS, now);
  assert.strictEqual(slots.length, 1);
  assert.strictEqual(slots[0].start, D(2026, 9, 8, 16, 40)); // rounded up to next 5 min
});

test("latest fit spreads work across days", () => {
  const start = Math.floor(D(2026, 9, 8) / 86_400_000);
  const end = Math.floor(D(2026, 9, 14) / 86_400_000);
  const plan = generatePlan({
    windowStartDay: start,
    windowEndDay: end,
    lessons: [],
    lockedItems: [],
    assignments: [
      { id: 1, titel: "Spoed", vak: "Nederlands", inleveren_voor: "2026-09-09T12:00:00", omschrijving: null },
      { id: 2, titel: "Later", vak: "Wiskunde", inleveren_voor: "2026-09-14T12:00:00", omschrijving: null },
    ],
    existingItems: [],
    settings: DEFAULT_PLAN_SETTINGS,
    durationMap: new Map([
      [1, { minutes: 45, source: "user_entered" }],
      [2, { minutes: 45, source: "user_entered" }],
    ]),
  });
  const work1 = plan.find((i) => i.related_assignment_id === 1);
  const work2 = plan.find((i) => i.related_assignment_id === 2);
  assert.ok(work1 && work2);
  const d1 = Math.floor((isoToWall(work1.start) as number) / 86_400_000);
  const d2 = Math.floor((isoToWall(work2.start) as number) / 86_400_000);
  assert.ok(d1 <= Math.floor(D(2026, 9, 9) / 86_400_000), "urgent work on/before deadline day");
  assert.ok(d2 > d1, "later deadline must not pile onto the same early day");
});

test("sleep items generated per day", () => {
  const items = generateSleepItems(
    Math.floor(D(2026, 9, 8) / 86_400_000),
    Math.floor(D(2026, 9, 9) / 86_400_000),
    DEFAULT_PLAN_SETTINGS,
    "2026-09-08T00:00:00",
  );
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].item_type, "sleep");
  assert.strictEqual(items[0].start, "2026-09-08T23:00:00");
  assert.strictEqual(items[0].end, "2026-09-09T07:00:00");
});

test("generate_plan creates review when no estimate", () => {
  const plan = generatePlan({
    windowStartDay: Math.floor(D(2026, 9, 8) / 86_400_000),
    windowEndDay: Math.floor(D(2026, 9, 14) / 86_400_000),
    lessons: [],
    lockedItems: [],
    assignments: [
      { id: 42, titel: "Verslag", vak: "Nederlands", inleveren_voor: "2026-09-10T23:59:59", omschrijving: null },
    ],
    existingItems: [],
    settings: DEFAULT_PLAN_SETTINGS,
    durationMap: new Map(),
  });
  assert.ok(
    plan.some((i) => i.item_type === "homework_review" && i.related_assignment_id === 42),
    "should create HomeworkReview when no estimate",
  );
  assert.ok(plan.some((i) => i.item_type === "sleep"));
  assert.ok(plan.some((i) => i.item_type === "free_time"));
});

test("generate_plan splits long assignment across days without overlap", () => {
  const plan = generatePlan({
    windowStartDay: Math.floor(D(2026, 9, 8) / 86_400_000),
    windowEndDay: Math.floor(D(2026, 9, 9) / 86_400_000),
    lessons: [],
    lockedItems: [],
    assignments: [
      { id: 99, titel: "Groot project", vak: "Wiskunde", inleveren_voor: "2026-09-09T23:59:59", omschrijving: "Lang" },
    ],
    existingItems: [],
    settings: DEFAULT_PLAN_SETTINGS,
    durationMap: new Map([[99, { minutes: 120, source: "user_entered" }]]),
  });
  const blocks = plan.filter((i) => i.item_type === "assignment_work" && i.related_assignment_id === 99);
  assert.ok(blocks.length >= 2, "long assignment should split into multiple blocks");
  const days = [...new Set(blocks.map((b) => Math.floor((isoToWall(b.start) as number) / 86_400_000)))];
  assert.ok(days.length >= 2, "chunks should spread across days");
  const sorted = [...blocks].sort((a, b) => (isoToWall(a.start) as number) - (isoToWall(b.start) as number));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const ae = isoToWall(sorted[i].end) as number;
    const bs = isoToWall(sorted[i + 1].start) as number;
    assert.ok(!itemsOverlap(isoToWall(sorted[i].start) as number, ae, bs, isoToWall(sorted[i + 1].end) as number));
  }
});

// ─── Extras beyond the Rust suite ──────────────────────────────────────────

test("intervalsOverlapStr treats touching endpoints as free", () => {
  assert.strictEqual(intervalsOverlapStr("2026-09-08T09:00:00", "2026-09-08T10:00:00", "2026-09-08T10:00:00", "2026-09-08T11:00:00"), false);
  assert.strictEqual(intervalsOverlapStr("2026-09-08T09:00:00", "2026-09-08T10:30:00", "2026-09-08T10:00:00", "2026-09-08T11:00:00"), true);
  assert.strictEqual(intervalsOverlapStr("bogus", "2026-09-08T10:00:00", "2026-09-08T10:00:00", "2026-09-08T11:00:00"), false);
});

test("isoToWall converts Zulu through device tz like chrono Local", () => {
  // Offset-less strings are wall time, untouched by tz.
  assert.strictEqual(isoToWall("2026-09-08T09:00:00"), D(2026, 9, 8, 9, 0));
  assert.strictEqual(isoToWall("2026-09-08"), D(2026, 9, 8));
  assert.strictEqual(isoToWall(""), null);
});

test("extractUpcomingTests filters by InfoType and window", () => {
  const lessons = [
    lesson("2026-09-10T09:00:00", "2026-09-10T10:00:00", { info_type: 2, id: 5 }),
    lesson("2026-09-10T11:00:00", "2026-09-10T12:00:00", { info_type: 1, id: 6 }),
    lesson("2026-09-10T13:00:00", "2026-09-10T14:00:00", { info_type: 3, id: 7, status: 4 }),
  ];
  const out = extractUpcomingTests(lessons, Math.floor(D(2026, 9, 8) / 86_400_000), Math.floor(D(2026, 9, 14) / 86_400_000));
  assert.deepStrictEqual(out.map((t) => t.event_id), [5]);
});

test("extractOpenHomework skips done/cancelled/empty", () => {
  const lessons = [
    lesson("2026-09-10T09:00:00", "2026-09-10T10:00:00", { info_type: 1, id: 1, inhoud: "Maak opg 1" }),
    lesson("2026-09-10T11:00:00", "2026-09-10T12:00:00", { info_type: 1, id: 2, afgerond: true, inhoud: "x" }),
    lesson("2026-09-10T13:00:00", "2026-09-10T14:00:00", { info_type: 1, id: 3, inhoud: "   ", vakken: null }),
  ];
  const out = extractOpenHomework(lessons);
  assert.deepStrictEqual(out.map((h) => h.event_id), [1]);
});

function schedItem(over: Partial<AiScheduleItem> = {}): AiScheduleItem {
  return {
    id: "x",
    title: "Test",
    description: null,
    item_type: "assignment_work",
    start: "2026-09-08T09:00:00",
    end: "2026-09-08T10:00:00",
    status: "planned",
    urgency: 3,
    related_assignment_id: null,
    related_calendar_event_id: null,
    related_subject: null,
    estimated_minutes: null,
    duration_source: null,
    source: "user",
    created_at: "2026-09-08T00:00:00",
    updated_at: "2026-09-08T00:00:00",
    completed_at: null,
    ...over,
  };
}

test("validateScheduleItem rejects bad input", () => {
  assert.throws(() => validateScheduleItem(schedItem({ title: "  " })), /Titel/);
  assert.throws(() => validateScheduleItem(schedItem({ urgency: 9 })), /Urgency/);
  assert.throws(
    () => validateScheduleItem(schedItem({ start: "2026-09-08T10:00:00", end: "2026-09-08T09:00:00" })),
    /Eind moet na start/,
  );
  assert.doesNotThrow(() => validateScheduleItem(schedItem()));
});

test("findScheduleOverlap exempts filler and history", () => {
  const existing = [
    schedItem({ id: "sleep1", item_type: "sleep", start: "2026-09-08T09:00:00", end: "2026-09-08T10:00:00" }),
    schedItem({ id: "done1", status: "completed", start: "2026-09-08T09:00:00", end: "2026-09-08T10:00:00" }),
    schedItem({ id: "busy1", start: "2026-09-08T14:00:00", end: "2026-09-08T15:00:00" }),
  ];
  assert.strictEqual(findScheduleOverlap(existing, "2026-09-08T09:30:00", "2026-09-08T09:45:00", null), null);
  assert.strictEqual(
    findScheduleOverlap(existing, "2026-09-08T14:30:00", "2026-09-08T15:30:00", null),
    "busy1",
  );
  assert.strictEqual(
    findScheduleOverlap(existing, "2026-09-08T14:30:00", "2026-09-08T15:30:00", "busy1"),
    null,
  );
});

test("inRange matches overlapping window", () => {
  const item = schedItem({ start: "2026-09-08T09:00:00", end: "2026-09-08T10:00:00" });
  assert.strictEqual(inRange(item, D(2026, 9, 8), D(2026, 9, 9)), true);
  assert.strictEqual(inRange(item, D(2026, 9, 10), D(2026, 9, 11)), false);
  assert.strictEqual(inRange(schedItem({ start: "bogus", end: "2026-09-08T10:00:00" }), D(2026, 9, 8), D(2026, 9, 9)), false);
});

test("plan item ids are deterministic per input", () => {
  const base = {
    windowStartDay: Math.floor(D(2026, 9, 8) / 86_400_000),
    windowEndDay: Math.floor(D(2026, 9, 9) / 86_400_000),
    lessons: [] as PlanLesson[],
    lockedItems: [] as PlanItem[],
    assignments: [
      { id: 42, titel: "Verslag", vak: "Nederlands", inleveren_voor: "2026-09-10T23:59:59", omschrijving: null },
    ],
    existingItems: [] as PlanItem[],
    settings: DEFAULT_PLAN_SETTINGS,
    durationMap: new Map(),
  };
  const a = generatePlan(base).map((i) => i.id).sort();
  const b = generatePlan(base).map((i) => i.id).sort();
  assert.deepStrictEqual(a, b);
  assert.ok(a.some((id) => id.startsWith("review-42")));
});
