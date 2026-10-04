/**
 * Unit tests for the Amsterdam time utils (src/lib/ai-time.ts).
 * Rust mirror: src-tauri/src/ai/time.rs tests — keep both in sync.
 *
 * Phase 1 of fixes/friday-ai-upgrade-plan.md ("Time awareness").
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai-time.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import {
  addDays,
  currentTimeJson,
  diffDays,
  formatNowBlock,
  getContextWindow,
  isValidDateStr,
  nextSchoolDay,
  nowAmsterdam,
  startOfWeek,
  todayAmsterdam,
  weekdayIndex,
} from "./ai-time.ts";

// ─── The core bug: 00:00–02:00 Dutch time is "yesterday" in UTC ─────────────

test("23:30 UTC is already the next day in Amsterdam", () => {
  const n = nowAmsterdam(new Date("2026-10-01T23:30:00Z"));
  assert.strictEqual(n.date, "2026-10-02");
  assert.strictEqual(n.time, "01:30");
  assert.strictEqual(n.weekday_nl, "vrijdag");
  assert.strictEqual(n.weekNumber, 40);
  assert.strictEqual(n.tz, "Europe/Amsterdam");
  assert.strictEqual(n.utcOffset, "+02:00");
  assert.strictEqual(n.iso, "2026-10-02T01:30:00+02:00");
  assert.strictEqual(
    todayAmsterdam(new Date("2026-10-01T23:30:00Z")),
    "2026-10-02",
  );
});

// ─── DST switch weekends (last Sunday of March and October) ─────────────────

test("spring forward: 2026-03-29 skips 02:00–03:00", () => {
  const before = nowAmsterdam(new Date("2026-03-29T00:30:00Z"));
  assert.strictEqual(before.time, "01:30");
  assert.strictEqual(before.utcOffset, "+01:00");
  const after = nowAmsterdam(new Date("2026-03-29T01:30:00Z"));
  assert.strictEqual(after.time, "03:30");
  assert.strictEqual(after.utcOffset, "+02:00");
  assert.strictEqual(after.weekday_nl, "zondag");
});

test("fall back: 2026-10-25 repeats 02:00–03:00", () => {
  const first = nowAmsterdam(new Date("2026-10-25T00:30:00Z"));
  assert.strictEqual(first.time, "02:30");
  assert.strictEqual(first.utcOffset, "+02:00");
  const second = nowAmsterdam(new Date("2026-10-25T01:30:00Z"));
  assert.strictEqual(second.time, "02:30");
  assert.strictEqual(second.utcOffset, "+01:00");
});

// ─── Year boundary + ISO week 53 ─────────────────────────────────────────────

test("year boundary resolves in Amsterdam, not UTC", () => {
  const n = nowAmsterdam(new Date("2025-12-31T23:30:00Z"));
  assert.strictEqual(n.date, "2026-01-01");
  assert.strictEqual(n.weekday_nl, "donderdag");
  assert.strictEqual(n.weekNumber, 1);
  assert.strictEqual(n.utcOffset, "+01:00");
});

test("ISO week 53 exists (2020-12-31)", () => {
  assert.strictEqual(
    nowAmsterdam(new Date("2020-12-31T12:00:00Z")).weekNumber,
    53,
  );
  assert.strictEqual(
    nowAmsterdam(new Date("2021-01-01T12:00:00Z")).weekNumber,
    53,
  );
  assert.strictEqual(
    nowAmsterdam(new Date("2021-01-04T12:00:00Z")).weekNumber,
    1,
  );
});

// ─── Calendar helpers ────────────────────────────────────────────────────────

test("isValidDateStr rejects malformed and impossible dates", () => {
  assert.strictEqual(isValidDateStr("2026-09-21"), true);
  assert.strictEqual(isValidDateStr("2024-02-29"), true);
  assert.strictEqual(isValidDateStr("2026-13-01"), false);
  assert.strictEqual(isValidDateStr("2026-02-29"), false);
  assert.strictEqual(isValidDateStr("volgende week"), false);
  assert.strictEqual(isValidDateStr("2026-9-1"), false);
});

test("diffDays counts whole days", () => {
  assert.strictEqual(diffDays("2026-01-01", "2026-03-04"), 62);
  assert.strictEqual(diffDays("2026-09-27", "2026-09-21"), -6);
  assert.strictEqual(diffDays("2026-09-21", "2026-09-21"), 0);
});

test("addDays crosses month and year boundaries", () => {
  assert.strictEqual(addDays("2026-10-02", 1), "2026-10-03");
  assert.strictEqual(addDays("2026-10-02", -1), "2026-10-01");
  assert.strictEqual(addDays("2026-10-31", 1), "2026-11-01");
  assert.strictEqual(addDays("2025-12-31", 1), "2026-01-01");
  assert.strictEqual(addDays("2026-01-01", -1), "2025-12-31");
  assert.strictEqual(addDays("2024-02-28", 1), "2024-02-29"); // leap year
});

test("startOfWeek is Monday", () => {
  assert.strictEqual(startOfWeek("2026-10-02"), "2026-09-28"); // Friday
  assert.strictEqual(startOfWeek("2026-09-28"), "2026-09-28"); // Monday itself
  assert.strictEqual(startOfWeek("2026-10-04"), "2026-09-28"); // Sunday
  assert.strictEqual(weekdayIndex("2026-09-28"), 1);
  assert.strictEqual(weekdayIndex("2026-10-04"), 7);
});

test("nextSchoolDay skips the weekend", () => {
  assert.strictEqual(nextSchoolDay("2026-10-02"), "2026-10-05"); // Fri -> Mon
  assert.strictEqual(nextSchoolDay("2026-10-03"), "2026-10-05"); // Sat -> Mon
  assert.strictEqual(nextSchoolDay("2026-10-04"), "2026-10-05"); // Sun -> Mon
  assert.strictEqual(nextSchoolDay("2026-10-05"), "2026-10-06"); // Mon -> Tue
  assert.strictEqual(nextSchoolDay("2026-10-01"), "2026-10-02"); // Thu -> Fri
});

// ─── Context window: Monday last week .. Sunday next week (21 days) ──────────

test("getContextWindow spans 21 days, Monday to Sunday", () => {
  const win = getContextWindow("2026-10-02"); // a Friday
  assert.deepStrictEqual(win, { start: "2026-09-21", end: "2026-10-11" });
  // Monday and Sunday edges of the same week give the same window.
  assert.deepStrictEqual(getContextWindow("2026-09-28"), win);
  assert.deepStrictEqual(getContextWindow("2026-10-04"), win);
  assert.strictEqual(weekdayIndex(win.start), 1);
  assert.strictEqual(weekdayIndex(win.end), 7);
});

test("getContextWindow across the year boundary", () => {
  const win = getContextWindow("2025-12-31");
  assert.deepStrictEqual(win, { start: "2025-12-22", end: "2026-01-11" });
});

// ─── NOW block (Dutch, injected into the system prompt every request) ────────

test("formatNowBlock matches the spec example", () => {
  const block = formatNowBlock(new Date("2026-10-02T12:35:00Z"));
  const lines = block.split("\n");
  assert.strictEqual(
    lines[0],
    "NU: vrijdag 2 oktober 2026, 14:35 (Europe/Amsterdam, week 40, 2026-10-02)",
  );
  assert.strictEqual(
    lines[1],
    "Morgen: zaterdag 3 oktober. Volgende schooldag: maandag 5 oktober.",
  );
  assert.strictEqual(lines[2], "Context-venster: 21 sep t/m 11 okt 2026.");
});

test("currentTimeJson carries the NOW block plus machine fields", () => {
  const j = currentTimeJson(new Date("2026-10-02T12:35:00Z")) as Record<
    string,
    unknown
  >;
  assert.strictEqual(j["date"], "2026-10-02");
  assert.strictEqual(j["time"], "14:35");
  assert.strictEqual(j["weekday_nl"], "vrijdag");
  assert.strictEqual(j["week_number"], 40);
  assert.strictEqual(j["tz"], "Europe/Amsterdam");
  assert.strictEqual(j["utc_offset"], "+02:00");
  assert.strictEqual(j["morgen"], "2026-10-03");
  assert.strictEqual(j["volgende_schooldag"], "2026-10-05");
  assert.deepStrictEqual(j["context_venster"], {
    start: "2026-09-21",
    end: "2026-10-11",
  });
  assert.match((j["tekst"] as string) ?? "", /^NU: vrijdag 2 oktober 2026/);
});
