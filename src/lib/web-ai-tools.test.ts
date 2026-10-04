/**
 * Unit tests for the browser AI tool port (src/lib/web-ai-tools.ts).
 * Grade-math expectations mirror src-tauri/src/ai/grade_calc.rs unit tests.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/web-ai-tools.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";
import "fake-indexeddb/auto";

// Phase 7 tests run the web facade in Node: stub browser globals so
// isWeb() takes the IndexedDB path and loadSettings() falls back to defaults.
const g = globalThis as Record<string, unknown>;
g["window"] ??= {};
g["localStorage"] ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

import {
  MAX_PLAN_WRITES_PER_TURN,
  PLAN_WRITE_TOOLS,
  WEB_TOOL_DEFS,
  averageForGrade,
  confirmWebPendingAction,
  executeWebTool,
  minGradeForPass,
  newOverallAverage,
  parseDutchGrade,
  paginateItems,
  predictedAverage,
  predictedEnd,
  redactDocent,
  redactTeacherNameStr,
  requiredGrade,
  resolveCalendarRange,
  slimCalendarEvent,
  weightedSum,
  __clearPendingForTests,
  __pendingForTests,
} from "./web-ai-tools.ts";
import { __clearUndoForTests, __undoLogForTests } from "./ai-schedule.ts";
import {
  loadScheduleItems,
  saveScheduleItems,
} from "./web-ai-schedule-store.ts";
import { getContextWindow, todayAmsterdam } from "./ai-time.ts";
import type { TierA } from "./web-tier-b.ts";
import type { SessionTokens } from "./backend.ts";

const TOKENS = {
  accessToken: "t",
  refreshToken: "r",
  expiresAt: "",
  apiEndpoint: "https://x.magister.net",
  personId: 7,
} as SessionTokens;
const CTX = { be: {} as TierA, tokens: TOKENS, personId: 7 };

// ─── Redaction ─────────────────────────────────────────────────────────────

test("redactDocent prefers code, falls back to last name", () => {
  assert.deepStrictEqual(
    redactDocent({ Id: 1, Docentcode: "JNS", Naam: "Jan Jansen" }),
    {
      id: 1,
      code: "JNS",
      naam: "JNS",
    },
  );
  assert.deepStrictEqual(redactDocent({ Id: 2, Naam: "Piet Pietersen" }), {
    id: 2,
    naam: "Pietersen",
  });
  assert.deepStrictEqual(redactDocent(null), { id: null, naam: "" });
});

test("redactTeacherNameStr extracts parenthesised code", () => {
  assert.strictEqual(redactTeacherNameStr("Jansen (JNS)"), "JNS");
  assert.strictEqual(redactTeacherNameStr("Piet Pietersen"), "Piet Pietersen");
  assert.strictEqual(redactTeacherNameStr(""), "");
});

// ─── Grade math (vectors from grade_calc.rs tests) ─────────────────────────

test("weightedSum accumulates", () => {
  assert.deepStrictEqual(weightedSum([{ value: 6, weight: 1 }]), [6, 1]);
});

test("requiredGrade matches frontend examples", () => {
  // (6.5 * 5 - 24) / 1 = 8.5
  assert.strictEqual(requiredGrade(24, 4, 6.5, 1, [], 1), "8.5");
  assert.strictEqual(requiredGrade(2, 1, 9, 1, [], 1), "Onmogelijk (>10)");
  assert.strictEqual(requiredGrade(9.5 * 3 * 4, 12, 5.5, 1, [], 1), "1.0");
  assert.strictEqual(requiredGrade(0, 0, 6, 1, [], 1), "?");
});

test("predictedAverage adds simulation", () => {
  assert.strictEqual(
    predictedAverage(21, 3, [{ value: 5, weight: 1 }], true, 1),
    "6.5",
  );
  assert.strictEqual(
    predictedAverage(21, 3, [{ value: 5, weight: 1 }], false, 1),
    "7.0",
  );
});

test("minGradeForPass variants", () => {
  // 5.5 * 3 - 12 = 4.5
  assert.deepStrictEqual(minGradeForPass(12, 2, 5.5), {
    kind: "needed",
    value: "4.5",
  });
  assert.deepStrictEqual(minGradeForPass(27, 3, 5.5), {
    kind: "already_passing",
  });
  assert.deepStrictEqual(minGradeForPass(2, 2, 5.5), { kind: "impossible" });
  assert.deepStrictEqual(minGradeForPass(0, 0, 5.5), { kind: "impossible" });
});

test("averageForGrade is weighted", () => {
  assert.strictEqual(averageForGrade(7, 1, 5, 1, 1), "6.0");
});

test("newOverallAverage replaces subject", () => {
  // (9 + 8 + 6) / 3 = 7.67
  assert.strictEqual(
    newOverallAverage(
      [
        ["Wiskunde", 7],
        ["Nederlands", 8],
        ["Engels", 6],
      ],
      "Wiskunde",
      9,
      2,
    ),
    "7.67",
  );
});

test("predictedEnd projects", () => {
  assert.strictEqual(predictedEnd(12, 2, 2, 8), (12 + 16) / 4);
});

test("parseDutchGrade handles comma", () => {
  assert.strictEqual(parseDutchGrade("7,5"), 7.5);
  assert.strictEqual(parseDutchGrade("7.5"), 7.5);
  assert.strictEqual(parseDutchGrade("abc"), null);
});

// ─── Tool defs ─────────────────────────────────────────────────────────────

test("web tool set includes schedule tools (Phase 7 parity), keeps writes", () => {
  const names = WEB_TOOL_DEFS.map((t) => t.name);
  for (const needed of [
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
  ]) {
    assert.ok(names.includes(needed), `missing schedule tool: ${needed}`);
  }
  for (const needed of [
    "get_calendar_events",
    "get_calendar_event_detail",
    "get_grades",
    "get_full_grade_overview",
    "get_schoolyears",
    "get_assignments",
    "get_assignment_detail",
    "get_messages",
    "get_message_content",
    "send_message",
    "mark_messages_read",
    "get_absences",
    "get_studiewijzers",
    "get_activities",
    "get_bronnen",
    "get_leermiddelen",
    "get_profile_info",
    "get_current_time",
    "get_today_summary",
    "read_notes",
    "append_note",
    "edit_note",
    "replace_notes",
    "read_attachment_text",
    "calculate_grade_scenario",
    "create_calendar_event",
    "download_file",
  ]) {
    assert.ok(names.includes(needed), `missing tool: ${needed}`);
  }
  assert.strictEqual(names.length, 40);
});

// ─── Executors (fake Tier-A) ───────────────────────────────────────────────

function fakeBe(routes: Record<string, unknown>): TierA {
  return {
    async magister<T>(_: SessionTokens, _m: string, path: string): Promise<T> {
      for (const [key, value] of Object.entries(routes)) {
        if (path.includes(key)) return value as T;
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };
}

test("unknown tool fails cleanly", async () => {
  const r = await executeWebTool(CTX, "nope", {});
  assert.strictEqual(r.success, false);
  assert.match(r.error ?? "", /Onbekende tool/);
});

test("get_calendar_events slims + redacts (no inhoud, huiswerk flag)", async () => {
  const be = fakeBe({
    afspraken: {
      Items: [
        {
          Id: 1,
          Start: "2026-09-21T08:30:00",
          Einde: "2026-09-21T09:20:00",
          Type: 13,
          Status: 1,
          Vakken: [{ Naam: "Wis" }],
          Docenten: [{ Id: 9, Docentcode: "JNS", Naam: "Jan Jansen" }],
          Lokalen: [{ Naam: "A1" }],
          LesuurVan: 1,
          Omschrijving: "o",
          Inhoud: null,
          Afgerond: false,
        },
      ],
    },
  });
  const r = await executeWebTool(
    { be, tokens: TOKENS, personId: 7 },
    "get_calendar_events",
    { start: "2026-09-21", end: "2026-09-27" },
  );
  assert.strictEqual(r.success, true);
  const data = r.data as {
    items: Array<Record<string, unknown>>;
    meta: Record<string, unknown>;
  };
  assert.strictEqual(data.items.length, 1);
  assert.strictEqual(data.items[0]["docent"], "JNS");
  assert.strictEqual(data.items[0]["vak"], "Wis");
  assert.strictEqual(data.items[0]["date"], "2026-09-21");
  assert.strictEqual(data.items[0]["huiswerk"], false);
  assert.ok(
    !("inhoud" in (data.items[0] as object)),
    "inhoud lives behind the detail tool",
  );
  assert.ok(
    !("lesuur" in (data.items[0] as object)),
    "slim shape drops lesuur",
  );
  assert.strictEqual(data.meta["truncated"] as boolean, false);
  assert.strictEqual(data.meta["total"] as number, 1);
});

// ─── Phase 2: windowing, pagination, budget ────────────────────────────────

function makeLesson(
  id: number,
  start: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    Id: id,
    Start: start,
    Einde: `${start.slice(0, 11)}09:20:00`,
    Type: 13,
    Status: 2,
    Vakken: [{ Naam: "Wiskunde" }],
    Docenten: [{ Id: 9, Docentcode: "JNS", Naam: "Jan Jansen" }],
    Lokalen: [{ Naam: "A101" }],
    LesuurVan: 1,
    Omschrijving: "Paragraaf 3.4",
    Inhoud: null,
    Afgerond: false,
    ...over,
  };
}

function captureBe(routes: Record<string, unknown>): {
  be: TierA;
  paths: string[];
} {
  const paths: string[] = [];
  const be: TierA = {
    async magister<T>(_t: SessionTokens, _m: string, path: string): Promise<T> {
      paths.push(path);
      for (const [key, value] of Object.entries(routes)) {
        if (path.includes(key)) return value as T;
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };
  return { be, paths };
}

test("omitted range defaults to the 3-week window", async () => {
  const { be, paths } = captureBe({ afspraken: { Items: [] } });
  const r = await executeWebTool(
    { be, tokens: TOKENS, personId: 7 },
    "get_calendar_events",
    {},
  );
  assert.strictEqual(r.success, true);
  const win = getContextWindow(todayAmsterdam());
  assert.ok(
    paths[0].includes(`van=${win.start}`),
    `van uses window start: ${paths[0]}`,
  );
  assert.ok(
    paths[0].includes(`tot=${win.end}`),
    `tot uses window end: ${paths[0]}`,
  );
  const meta = (r.data as { meta: Record<string, unknown> }).meta;
  assert.deepStrictEqual(meta["window_default"], win);
  assert.strictEqual(meta["clamped"], false);
});

test("spans over 62 days are clamped, not rejected", () => {
  const range = resolveCalendarRange("2026-01-01", "2026-06-01", "2026-02-01");
  assert.strictEqual(range.clamped, true);
  assert.strictEqual(range.effectiveEnd, "2026-03-04"); // Jan 1 + 62 days
  assert.strictEqual(range.start, "2026-01-01");
  const exact = resolveCalendarRange("2026-01-01", "2026-03-04", "2026-02-01");
  assert.strictEqual(exact.clamped, false);
});

test("clamped fetch only requests the effective range", async () => {
  const { be, paths } = captureBe({ afspraken: { Items: [] } });
  const r = await executeWebTool(
    { be, tokens: TOKENS, personId: 7 },
    "get_calendar_events",
    { start: "2026-01-01", end: "2026-06-01" },
  );
  assert.strictEqual(r.success, true);
  assert.ok(paths[0].includes("tot=2026-03-04"), paths[0]);
  const meta = (r.data as { meta: Record<string, unknown> }).meta;
  assert.strictEqual(meta["clamped"], true);
  assert.deepStrictEqual(meta["requested"], {
    start: "2026-01-01",
    end: "2026-06-01",
  });
  assert.deepStrictEqual(meta["effective"], {
    start: "2026-01-01",
    end: "2026-03-04",
  });
});

test("invalid or reversed ranges fail with a hint", async () => {
  const bad = await executeWebTool(
    { be: fakeBe({}), tokens: TOKENS, personId: 7 },
    "get_calendar_events",
    { start: "volgende week", end: "2026-09-27" },
  );
  assert.strictEqual(bad.success, false);
  assert.match(bad.error ?? "", /Ongeldige datum/);
  const reversed = await executeWebTool(
    { be: fakeBe({}), tokens: TOKENS, personId: 7 },
    "get_calendar_events",
    { start: "2026-09-27", end: "2026-09-21" },
  );
  assert.strictEqual(reversed.success, false);
  assert.match(reversed.error ?? "", /voor startdatum/);
});

test("pagination round-trips via next_offset", async () => {
  const be = fakeBe({
    afspraken: {
      Items: [
        makeLesson(1, "2026-09-22T08:30:00"),
        makeLesson(2, "2026-09-21T08:30:00"),
        makeLesson(3, "2026-09-23T08:30:00"),
        makeLesson(4, "2026-09-21T10:30:00"),
        makeLesson(5, "2026-09-22T10:30:00"),
      ],
    },
  });
  const ctx = { be, tokens: TOKENS, personId: 7 };
  const seen: number[] = [];
  let offset: number | null = 0;
  for (;;) {
    const r = await executeWebTool(ctx, "get_calendar_events", {
      start: "2026-09-21",
      end: "2026-09-27",
      offset,
      limit: 2,
    });
    assert.strictEqual(r.success, true);
    const data = r.data as {
      items: Array<Record<string, unknown>>;
      days: Array<{ date: string; count: number }>;
      meta: Record<string, unknown>;
    };
    for (const item of data.items) seen.push(item["id"] as number);
    // Sorted by start: Sep 21 first, even though Sep 22 was stored first.
    if (offset === 0) {
      assert.deepStrictEqual(
        data.items.map((i) => i["id"]),
        [2, 4],
      );
      assert.deepStrictEqual(data.days, [{ date: "2026-09-21", count: 2 }]);
    }
    const next = data.meta["next_offset"];
    if (next === null) {
      assert.strictEqual(data.meta["truncated"], false);
      break;
    }
    assert.strictEqual(data.meta["truncated"], true);
    offset = next as number;
  }
  assert.deepStrictEqual(seen, [2, 4, 1, 5, 3]);
});

test("slim shape cuts long text, drops nulls, flags homework", () => {
  const slim = slimCalendarEvent(
    makeLesson(7, "2026-09-21T08:30:00", {
      Omschrijving: `x`.repeat(200),
      Inhoud: "Maak opgave 1 t/m 10",
      Lokalen: [],
      Docenten: [{ Id: 3, Naam: "Piet Pietersen" }],
      Afgerond: null,
      Status: null,
    }),
  );
  assert.strictEqual((slim["omschrijving"] as string).length, 121); // 120 + …
  assert.strictEqual(slim["huiswerk"], true);
  assert.ok(!("inhoud" in slim));
  assert.ok(!("lokaal" in slim), "empty lokalen dropped");
  assert.ok(!("afgerond" in slim), "nulls dropped");
  assert.strictEqual(
    slim["docent"],
    "Pietersen",
    "last-name fallback still redacted",
  );
  const noHw = slimCalendarEvent(
    makeLesson(8, "2026-09-21T08:30:00", { Inhoud: "  " }),
  );
  assert.strictEqual(noHw["huiswerk"], false);
});

test("paginateItems honours offset/limit bounds", () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepStrictEqual(paginateItems(items, 0, 2), {
    page: [1, 2],
    truncated: true,
    nextOffset: 2,
  });
  assert.deepStrictEqual(paginateItems(items, 4, 2), {
    page: [5],
    truncated: false,
    nextOffset: null,
  });
  assert.deepStrictEqual(paginateItems(items, 9, 2).page, []);
  assert.strictEqual(
    paginateItems(items, 0, 500).page.length,
    5,
    "limit capped, not rejected",
  );
});

test("default page stays bounded no matter the range size", async () => {
  const lessons = [];
  for (let i = 0; i < 100; i++) {
    const day = `2026-09-${String(21 + (i % 21)).padStart(2, "0")}`;
    lessons.push(
      makeLesson(1000 + i, `${day}T08:30:00`, {
        Omschrijving:
          "Paragraaf 3.4 opgaven 12 t/m 28 maken en leren voor het schriftelijk van volgende week",
        Inhoud: `Huiswerktekst die nooit in de lijst mag belanden. `.repeat(25),
      }),
    );
  }
  const be = fakeBe({ afspraken: { Items: lessons } });
  const r = await executeWebTool(
    { be, tokens: TOKENS, personId: 7 },
    "get_calendar_events",
    {},
  );
  assert.strictEqual(r.success, true);
  const data = r.data as { items: unknown[]; meta: Record<string, unknown> };
  assert.strictEqual(data.items.length, 60, "default limit enforced");
  assert.strictEqual(data.meta["total"], 100);
  assert.strictEqual(data.meta["truncated"], true);
  assert.strictEqual(data.meta["next_offset"], 60);
  assert.ok(
    JSON.stringify(r.data).length < 20000,
    `bounded page, got ${JSON.stringify(r.data).length} chars`,
  );
});

test("get_calendar_event_detail returns full text for one lesson", async () => {
  const be = fakeBe({
    afspraken: {
      Items: [
        makeLesson(42, "2026-09-21T08:30:00", {
          Inhoud: "Lees bladzijde 10 t/m 15",
        }),
        makeLesson(43, "2026-09-21T10:30:00"),
      ],
    },
  });
  const ctx = { be, tokens: TOKENS, personId: 7 };
  const r = await executeWebTool(ctx, "get_calendar_event_detail", {
    id: 42,
    date: "2026-09-21",
  });
  assert.strictEqual(r.success, true);
  const data = r.data as Record<string, unknown>;
  assert.strictEqual(data["inhoud"], "Lees bladzijde 10 t/m 15");
  assert.strictEqual(data["huiswerk"], true);
  assert.deepStrictEqual(data["docent"], [{ id: 9, code: "JNS", naam: "JNS" }]);
  const missing = await executeWebTool(ctx, "get_calendar_event_detail", {
    id: 999,
    date: "2026-09-21",
  });
  assert.strictEqual(missing.success, false);
  assert.match(missing.error ?? "", /niet gevonden op 2026-09-21/);
});

test("grades and messages report totals", async () => {
  const grades = await executeWebTool(
    {
      be: fakeBe({ cijfers: { Items: [{ Id: 1 }] } }),
      tokens: TOKENS,
      personId: 7,
    },
    "get_grades",
    { top: 5 },
  );
  assert.strictEqual((grades.data as Record<string, unknown>)["total"], 1);
  const msgs = await executeWebTool(
    {
      be: fakeBe({
        "mappen/alle": {
          Items: [
            {
              Id: 1,
              Naam: "Postvak IN",
              Links: [{ Href: "berichten/mappen/1/berichten" }],
            },
          ],
        },
        "mappen/1/berichten": { Items: [{ Id: 2 }] },
      }),
      tokens: TOKENS,
      personId: 7,
    },
    "get_messages",
    {},
  );
  assert.strictEqual(msgs.success, true);
  assert.strictEqual((msgs.data as Record<string, unknown>)["total"], 1);
});

test("send_message stages (never sends) with confirmation payload", async () => {
  __clearPendingForTests();
  const be = fakeBe({});
  const r = await executeWebTool(
    { be, tokens: TOKENS, personId: 7 },
    "send_message",
    {
      subject: "Hallo",
      body: "Test",
      recipients: [{ id: 1, type: "leerling" }],
    },
  );
  assert.strictEqual(r.success, true);
  const data = r.data as Record<string, unknown>;
  assert.strictEqual(data["status"], "pending_user_confirmation");
  assert.match((data["action_id"] as string) ?? "", /^act-/);
  assert.strictEqual(__pendingForTests().size, 1);
});

test("send_message validates required fields", async () => {
  const r = await executeWebTool(CTX, "send_message", {
    subject: "",
    body: "x",
    recipients: [],
  });
  assert.strictEqual(r.success, false);
});

test("confirm replays the exact desktop endpoints", async () => {
  __clearPendingForTests();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const be: TierA = {
    async magister<T>(
      _: SessionTokens,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<T> {
      calls.push({ method, path, body });
      return {} as T;
    },
  };
  const staged = await executeWebTool(
    { be, tokens: TOKENS, personId: 7 },
    "send_message",
    {
      subject: "S",
      body: "B",
      recipients: [{ id: 3 }],
    },
  );
  const actionId = (staged.data as Record<string, unknown>)[
    "action_id"
  ] as string;
  const out = (await confirmWebPendingAction(
    { be, tokens: TOKENS, personId: 7 },
    actionId,
  )) as Record<string, unknown>;
  assert.strictEqual(out["status"], "verzonden");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, "POST");
  assert.strictEqual(calls[0].path, "berichten/verzenden");
  const body = calls[0].body as Record<string, unknown>;
  assert.strictEqual(body["onderwerp"], "S");
  assert.deepStrictEqual(body["ontvangers"], [{ id: 3, type: "leerling" }]);
  // Consumed: second confirm fails.
  await assert.rejects(
    confirmWebPendingAction({ be, tokens: TOKENS, personId: 7 }, actionId),
  );
});

test("mark_messages_read stages + replays PUT berichten/gelezen", async () => {
  __clearPendingForTests();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const be: TierA = {
    async magister<T>(
      _: SessionTokens,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<T> {
      calls.push({ method, path, body });
      return {} as T;
    },
  };
  const ctx = { be, tokens: TOKENS, personId: 7 };
  const staged = await executeWebTool(ctx, "mark_messages_read", {
    message_ids: [11, 12],
  });
  const actionId = (staged.data as Record<string, unknown>)[
    "action_id"
  ] as string;
  await confirmWebPendingAction(ctx, actionId);
  assert.deepStrictEqual(calls[0], {
    method: "PUT",
    path: "berichten/gelezen",
    body: { BerichtIds: [11, 12] },
  });
});

test("calculate_grade_scenario with explicit grades", async () => {
  const be = fakeBe({});
  const r = await executeWebTool(
    { be, tokens: TOKENS, personId: 7 },
    "calculate_grade_scenario",
    {
      subject: "Wiskunde",
      grades: [
        { value: 6, weight: 1 },
        { value: 6, weight: 1 },
        { value: 6, weight: 1 },
        { value: 6, weight: 1 },
      ],
      target_average: 6.5,
      decimal_points: 1,
    },
  );
  assert.strictEqual(r.success, true);
  const data = r.data as Record<string, unknown>;
  assert.strictEqual(data["required_grade"], "8.5");
  assert.strictEqual(data["grade_count"], 4);
});

test("calculate_grade_scenario needs grades or schoolyear+subject", async () => {
  const r = await executeWebTool(
    { be: fakeBe({}), tokens: TOKENS, personId: 7 },
    "calculate_grade_scenario",
    {},
  );
  assert.strictEqual(r.success, false);
});

test("read_attachment_text reports images as unreadable", async () => {
  const r = await executeWebTool(
    { be: fakeBe({}), tokens: TOKENS, personId: 7 },
    "read_attachment_text",
    {
      url: "bijlagen/9",
      filename: "foto.png",
    },
  );
  assert.strictEqual(r.success, false);
  assert.strictEqual((r.data as Record<string, unknown>)["readable"], false);
  assert.match(
    (r.data as Record<string, unknown>)["reason"] as string,
    /afbeeldingen/,
  );
});

test("read_attachment_text pages text and caches", async () => {
  const body = new TextEncoder().encode("0123456789".repeat(2000)); // 20000 chars
  let fetches = 0;
  const be: TierA = {
    async magister<T>(): Promise<T> {
      return { location: "https://x.magister.net/contents/1" } as T;
    },
    async magisterBytes(): Promise<Uint8Array> {
      fetches += 1;
      return body;
    },
  };
  const ctx = { be, tokens: TOKENS, personId: 7 };
  const first = await executeWebTool(ctx, "read_attachment_text", {
    url: "bijlagen/1",
    filename: "blad.txt",
    offset: 5000,
    max_chars: 100,
  });
  assert.strictEqual(first.success, true, `read failed: ${first.error}`);
  const d1 = first.data as Record<string, unknown>;
  assert.strictEqual(d1["total_chars"], 20000);
  assert.strictEqual(d1["offset"], 5000);
  assert.strictEqual(d1["next_offset"], 5100);
  assert.strictEqual((d1["text"] as string).length, 100);
  assert.strictEqual(d1["cached"], undefined);
  const second = await executeWebTool(ctx, "read_attachment_text", {
    url: "bijlagen/1",
    filename: "blad.txt",
    offset: 0,
    max_chars: 10,
  });
  assert.strictEqual((second.data as Record<string, unknown>)["cached"], true);
  assert.strictEqual(fetches, 1);
  const over = await executeWebTool(ctx, "read_attachment_text", {
    url: "bijlagen/1",
    filename: "blad.txt",
    offset: 99999,
  });
  assert.strictEqual(over.success, false);
});

test("foreign urls are rejected before any fetch", async () => {
  let fetched = false;
  const be: TierA = {
    async magister<T>(): Promise<T> {
      fetched = true;
      throw new Error("must not fetch");
    },
  };
  for (const url of [
    "https://evil.example.com/bijlage.pdf",
    "file:///etc/passwd",
  ]) {
    const r = await executeWebTool(
      { be, tokens: TOKENS, personId: 7 },
      "read_attachment_text",
      {
        url,
        filename: "x.pdf",
      },
    );
    assert.strictEqual(r.success, false);
  }
  assert.strictEqual(fetched, false);
});

test("get_current_time returns the Amsterdam NOW block without network", async () => {
  const r = await executeWebTool(
    { be: fakeBe({}), tokens: TOKENS, personId: 7 },
    "get_current_time",
    {},
  );
  assert.strictEqual(r.success, true);
  const data = r.data as Record<string, unknown>;
  assert.match((data["date"] as string) ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(data["tz"], "Europe/Amsterdam");
  assert.match((data["tekst"] as string) ?? "", /^NU: /);
  assert.deepStrictEqual(
    Object.keys(data["context_venster"] as object).sort(),
    ["end", "start"],
  );
});

test("download_file reports size without model payload bloat", async () => {
  const be = fakeBe({
    "bijlagen/1": { location: "https://x.magister.net/contents/1" },
  });
  const beBytes: TierA = {
    ...be,
    async magisterBytes(): Promise<Uint8Array> {
      return new Uint8Array(100);
    },
  };
  const r = await executeWebTool(
    { be: beBytes, tokens: TOKENS, personId: 7 },
    "download_file",
    { url: "bijlagen/1" },
  );
  assert.strictEqual(r.success, true);
  assert.strictEqual((r.data as Record<string, unknown>)["size_bytes"], 100);
});

// ─── Phase 4: notes tools ──────────────────────────────────────────────────

test("notes tools round-trip with revisions", async () => {
  const ctx = { be: fakeBe({}), tokens: TOKENS, personId: 7 };
  const read0 = await executeWebTool(ctx, "read_notes", {});
  assert.strictEqual(read0.success, true);
  const rev0 = (read0.data as Record<string, unknown>)["revision"] as number;
  assert.strictEqual(
    (read0.data as Record<string, unknown>)["max_chars"],
    6000,
  );

  const append = await executeWebTool(ctx, "append_note", {
    section: "Voorkeuren",
    text: "uitleg in stappen",
  });
  assert.strictEqual(append.success, true);
  assert.strictEqual(
    (append.data as Record<string, unknown>)["revision"],
    rev0 + 1,
  );

  const edit = await executeWebTool(ctx, "edit_note", {
    old_text: "uitleg in stappen",
    new_text: "korte uitleg",
  });
  assert.strictEqual(edit.success, true);

  const read1 = await executeWebTool(ctx, "read_notes", {});
  const content = (read1.data as Record<string, unknown>)["content"] as string;
  assert.ok(content.includes("## Voorkeuren"));
  assert.ok(content.includes("korte uitleg"));
  const rev1 = (read1.data as Record<string, unknown>)["revision"] as number;

  const replace = await executeWebTool(ctx, "replace_notes", {
    content: "## Over mij\n",
    expected_revision: rev1,
  });
  assert.strictEqual(replace.success, true);

  const stale = await executeWebTool(ctx, "replace_notes", {
    content: "x",
    expected_revision: rev1,
  });
  assert.strictEqual(stale.success, false);
  assert.match(stale.error ?? "", /Conflict/);

  const editMiss = await executeWebTool(ctx, "edit_note", {
    old_text: "bestaat niet xyz",
    new_text: "y",
  });
  assert.strictEqual(editMiss.success, false);
  assert.match(editMiss.error ?? "", /niet gevonden/);
});

test("notes cap errors instead of truncating", async () => {
  const ctx = { be: fakeBe({}), tokens: TOKENS, personId: 7 };
  const read = await executeWebTool(ctx, "read_notes", {});
  const rev = (read.data as Record<string, unknown>)["revision"] as number;
  const r = await executeWebTool(ctx, "replace_notes", {
    content: "x".repeat(6001),
    expected_revision: rev,
  });
  assert.strictEqual(r.success, false);
  assert.match(r.error ?? "", /Vat samen/);
});

test("disabled editing gates write tools, read stays", async () => {
  const { saveWebAiConfig } = await import("./web-ai-store.ts");
  await saveWebAiConfig({ notesAiCanEdit: false });
  const ctx = { be: fakeBe({}), tokens: TOKENS, personId: 7 };
  const blocked = await executeWebTool(ctx, "append_note", { text: "x" });
  assert.strictEqual(blocked.success, false);
  assert.match(blocked.error ?? "", /alleen lezen/i);
  const read = await executeWebTool(ctx, "read_notes", {});
  assert.strictEqual(read.success, true);
  await saveWebAiConfig({ notesAiCanEdit: true });
});

test("string args are parsed, junk fails gracefully", async () => {
  const ctx = { be: fakeBe({}), tokens: TOKENS, personId: 7 };
  const r = await executeWebTool(ctx, "read_notes", "{}");
  assert.strictEqual(r.success, true);
  const bad = await executeWebTool(ctx, "read_notes", "{oops");
  assert.strictEqual(bad.success, false);
  assert.match(bad.error ?? "", /Ongeldige argumenten/);
});

// ─── Phase 7: plan tools on web ────────────────────────────────────────────

async function resetPlanStore(): Promise<void> {
  await saveScheduleItems([]);
  __clearUndoForTests();
}

function planCtx(be: TierA) {
  return { be, tokens: TOKENS, personId: 7 };
}

async function createItem(
  be: TierA,
  over: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const r = await executeWebTool(planCtx(be), "create_ai_schedule_item", {
    title: "Wiskunde maken",
    item_type: "assignment_work",
    start: "2026-09-21T10:30:00",
    end: "2026-09-21T11:20:00",
    ...over,
  });
  assert.strictEqual(r.success, true, `create failed: ${r.error}`);
  return r.data as Record<string, unknown>;
}

test("get_ai_schedule defaults to window with pagination meta", async () => {
  await resetPlanStore();
  const be = fakeBe({ afspraken: { Items: [] } });
  await createItem(be);
  await createItem(be, {
    start: "2026-09-22T10:30:00",
    end: "2026-09-22T11:20:00",
  });
  const r = await executeWebTool(planCtx(be), "get_ai_schedule", {});
  assert.strictEqual(r.success, true);
  const data = r.data as Record<string, unknown>;
  assert.strictEqual((data["items"] as unknown[]).length, 2);
  const meta = data["meta"] as Record<string, unknown>;
  assert.strictEqual(meta["clamped"], false);
  assert.strictEqual(meta["total"], 2);
  // Pagination round-trip.
  const p1 = await executeWebTool(planCtx(be), "get_ai_schedule", {
    limit: 1,
    offset: 0,
  });
  const d1 = p1.data as Record<string, unknown>;
  assert.strictEqual((d1["items"] as unknown[]).length, 1);
  assert.strictEqual((d1["meta"] as Record<string, unknown>)["next_offset"], 1);
  const p2 = await executeWebTool(planCtx(be), "get_ai_schedule", {
    limit: 1,
    offset: 1,
  });
  const d2 = p2.data as { items: unknown[]; meta: Record<string, unknown> };
  assert.strictEqual(d2.items.length, 1);
  assert.strictEqual(d2.meta["next_offset"], null);
});

test("create overlap with AI item rejected with suggestions", async () => {
  await resetPlanStore();
  const be = fakeBe({ afspraken: { Items: [] } });
  await createItem(be);
  const r = await executeWebTool(planCtx(be), "create_ai_schedule_item", {
    title: "Engels leren",
    item_type: "study_block",
    start: "2026-09-21T10:45:00",
    end: "2026-09-21T11:30:00",
  });
  assert.strictEqual(r.success, false);
  const data = r.data as Record<string, unknown>;
  assert.strictEqual(
    (data["conflict_with"] as Record<string, unknown>)["type"],
    "ai_item",
  );
  assert.ok(
    ((data["suggestions"] as unknown[]) ?? []).length > 0,
    "suggestions offered",
  );
  assert.match(r.error ?? "", /voorgestelde vrije plekken/);
});

test("create overlap with lesson rejected", async () => {
  await resetPlanStore();
  const be = fakeBe({
    afspraken: {
      Items: [
        {
          Id: 5,
          Start: "2026-09-21T08:30:00",
          Einde: "2026-09-21T09:20:00",
          Status: 1,
          Omschrijving: "Wiskunde",
        },
      ],
    },
  });
  const r = await executeWebTool(planCtx(be), "create_ai_schedule_item", {
    title: "Leren",
    item_type: "study_block",
    start: "2026-09-21T08:45:00",
    end: "2026-09-21T09:30:00",
  });
  assert.strictEqual(r.success, false);
  const data = r.data as Record<string, unknown>;
  assert.strictEqual(
    (data["conflict_with"] as Record<string, unknown>)["type"],
    "les",
  );
  assert.strictEqual(data["lessons_checked"], true);
});

test("move keeps duration and respects guardrail", async () => {
  await resetPlanStore();
  const be = fakeBe({ afspraken: { Items: [] } });
  const created = await createItem(be);
  const id = created["id"] as string;
  const moved = await executeWebTool(planCtx(be), "move_ai_schedule_item", {
    id,
    new_start: "2026-09-21T14:00:00",
  });
  assert.strictEqual(moved.success, true, `move failed: ${moved.error}`);
  const m = moved.data as Record<string, unknown>;
  assert.strictEqual(m["start"], "2026-09-21T14:00:00");
  assert.strictEqual(m["end"], "2026-09-21T14:50:00");
  // Moving onto itself-incompatible time: create a blocker, then move onto it.
  await createItem(be, {
    title: "Blokker",
    start: "2026-09-21T16:00:00",
    end: "2026-09-21T16:30:00",
  });
  const clash = await executeWebTool(planCtx(be), "move_ai_schedule_item", {
    id,
    new_start: "2026-09-21T16:10:00",
  });
  assert.strictEqual(clash.success, false);
  assert.ok(
    (
      ((clash.data as Record<string, unknown>)["suggestions"] as unknown[]) ??
      []
    ).length > 0,
  );
});

test("delete removes, dismiss keeps with status", async () => {
  await resetPlanStore();
  const be = fakeBe({ afspraken: { Items: [] } });
  const a = await createItem(be);
  const del = await executeWebTool(planCtx(be), "delete_ai_schedule_item", {
    id: a["id"],
  });
  assert.strictEqual(del.success, true);
  assert.strictEqual((await loadScheduleItems()).length, 0);
  const b = await createItem(be);
  const dis = await executeWebTool(planCtx(be), "dismiss_ai_schedule_item", {
    id: b["id"],
  });
  assert.strictEqual(dis.success, true);
  const items = await loadScheduleItems();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].status, "dismissed");
  const done = await executeWebTool(planCtx(be), "complete_ai_schedule_item", {
    id: b["id"],
  });
  assert.strictEqual(done.success, true);
  assert.strictEqual((await loadScheduleItems())[0].status, "completed");
});

test("update patches fields", async () => {
  await resetPlanStore();
  const be = fakeBe({ afspraken: { Items: [] } });
  const created = await createItem(be);
  const r = await executeWebTool(planCtx(be), "update_ai_schedule_item", {
    id: created["id"],
    title: "Nieuwe titel",
    urgency: 5,
  });
  assert.strictEqual(r.success, true, `update failed: ${r.error}`);
  const data = r.data as Record<string, unknown>;
  assert.strictEqual(data["title"], "Nieuwe titel");
  assert.strictEqual(data["urgency"], 5);
});

test("undo restores create, delete and update", async () => {
  await resetPlanStore();
  const be = fakeBe({ afspraken: { Items: [] } });
  const ctx = planCtx(be);
  const created = await createItem(be);
  assert.strictEqual(__undoLogForTests().length, 1);
  const undoCreate = await executeWebTool(ctx, "undo_last_ai_plan_change", {});
  assert.strictEqual(undoCreate.success, true);
  assert.strictEqual((await loadScheduleItems()).length, 0);
  assert.strictEqual(
    (
      (undoCreate.data as Record<string, unknown>)["undone"] as Record<
        string,
        unknown
      >
    )["op"],
    "create_ai_schedule_item",
  );
  // Delete then undo brings it back.
  const c2 = await createItem(be);
  await executeWebTool(ctx, "delete_ai_schedule_item", { id: c2["id"] });
  assert.strictEqual((await loadScheduleItems()).length, 0);
  const undoDelete = await executeWebTool(ctx, "undo_last_ai_plan_change", {});
  assert.strictEqual(undoDelete.success, true);
  assert.strictEqual((await loadScheduleItems()).length, 1);
  // Update then undo restores the old title.
  await executeWebTool(ctx, "update_ai_schedule_item", {
    id: c2["id"],
    title: "X",
  });
  await executeWebTool(ctx, "undo_last_ai_plan_change", {});
  assert.strictEqual((await loadScheduleItems())[0].title, "Wiskunde maken");
  // Empty log fails cleanly.
  __clearUndoForTests();
  const empty = await executeWebTool(ctx, "undo_last_ai_plan_change", {});
  assert.strictEqual(empty.success, false);
  assert.match(empty.error ?? "", /Niets om ongedaan te maken/);
});

test("get_plan_settings mirrors app settings", async () => {
  const r = await executeWebTool(planCtx(fakeBe({})), "get_plan_settings", {});
  assert.strictEqual(r.success, true);
  const data = r.data as Record<string, unknown>;
  for (const k of [
    "bedtime",
    "wake_time",
    "blocked_times",
    "after_school_buffer_min",
    "plan_in_school_gaps",
  ]) {
    assert.ok(k in data, `missing ${k}`);
  }
  assert.strictEqual(typeof data["bedtime"], "string");
});

test("get_free_slots finds room around lessons", async () => {
  const be = fakeBe({
    afspraken: {
      Items: [
        {
          Id: 5,
          Start: "2026-09-21T08:30:00",
          Einde: "2026-09-21T09:20:00",
          Status: 1,
          Omschrijving: "Wiskunde",
        },
      ],
    },
  });
  const r = await executeWebTool(planCtx(be), "get_free_slots", {
    date: "2026-09-21",
  });
  assert.strictEqual(r.success, true, `free slots failed: ${r.error}`);
  const data = r.data as Record<string, unknown>;
  const slots = data["slots"] as Array<Record<string, unknown>>;
  assert.ok(slots.length > 0);
  for (const s of slots) {
    assert.match((s["start"] as string) ?? "", /^2026-09-21T/);
    assert.ok((s["minutes"] as number) >= 0);
  }
  assert.strictEqual(data["lessons_checked"], true);
  // min_minutes filters short gaps.
  const filtered = await executeWebTool(planCtx(be), "get_free_slots", {
    date: "2026-09-21",
    min_minutes: 240,
  });
  const fslots = (
    (filtered.data as Record<string, unknown>)["slots"] as unknown[]
  ).length;
  assert.ok(fslots <= slots.length);
  assert.strictEqual(
    (
      (filtered.data as Record<string, unknown>)["slots"] as Array<
        Record<string, unknown>
      >
    ).every((s) => (s["minutes"] as number) >= 240),
    true,
  );
  // Span guard + bad input.
  const wide = await executeWebTool(planCtx(be), "get_free_slots", {
    date: "2026-01-01",
    end: "2026-06-01",
  });
  assert.strictEqual(wide.success, false);
  const bad = await executeWebTool(planCtx(be), "get_free_slots", {
    date: "volgende week",
  });
  assert.strictEqual(bad.success, false);
});

test("set_homework_duration stores a placeholder duration", async () => {
  await resetPlanStore();
  const r = await executeWebTool(planCtx(fakeBe({})), "set_homework_duration", {
    assignment_id: 42,
    estimated_minutes: 45,
  });
  assert.strictEqual(r.success, true, `set duration failed: ${r.error}`);
  const data = r.data as Record<string, unknown>;
  assert.strictEqual(data["estimated_minutes"], 45);
  assert.strictEqual(data["related_assignment_id"], 42);
});

test("plan bulk-cap constants", async () => {
  assert.strictEqual(MAX_PLAN_WRITES_PER_TURN, 10);
  assert.deepStrictEqual(PLAN_WRITE_TOOLS, [
    "create_ai_schedule_item",
    "update_ai_schedule_item",
    "complete_ai_schedule_item",
    "dismiss_ai_schedule_item",
    "delete_ai_schedule_item",
    "move_ai_schedule_item",
    "set_homework_duration",
  ]);
});

test("list_files enumerates sources and registers for reads", async () => {
  const { __clearFileState } = await import("./ai-files.ts");
  __clearFileState();
  const routes: Record<string, unknown> = {
    "bijlagen/22": { location: "https://x.magister.net/contents/22" },
    opdrachten: {
      Items: [
        {
          Id: 7,
          Titel: "Verslag",
          Vak: "Nederlands",
          InleverenVoor: "2026-10-01",
          Bijlagen: [
            { Id: 9, Naam: "opdracht.txt", Url: "bijlagen/9", Grootte: 100 },
          ],
        },
      ],
    },
    "mappen/alle": {
      Items: [
        {
          Id: 1,
          Naam: "Postvak IN",
          Links: [{ Href: "berichten/mappen/1/berichten" }],
        },
      ],
    },
    "mappen/1/berichten": {
      Items: [
        {
          Id: 11,
          Onderwerp: "Huiswerk",
          DatumVerzonden: "2026-09-20T10:00:00",
          Bijlagen: [{ Id: 12, Naam: "info.txt", Url: "bijlagen/12" }],
        },
      ],
    },
    afspraken: {
      Items: [
        {
          Id: 21,
          Start: "2026-09-21T08:30:00",
          Vakken: [{ Naam: "Wiskunde" }],
          Omschrijving: "Wis",
          Bijlagen: [{ Id: 22, Naam: "blad.txt", Url: "bijlagen/22" }],
        },
      ],
    },
  };
  const be: TierA = {
    async magister<T>(_t: SessionTokens, _m: string, path: string): Promise<T> {
      for (const [key, value] of Object.entries(routes)) {
        if (path.includes(key)) return value as T;
      }
      throw new Error(`unexpected path: ${path}`);
    },
    async magisterBytes(): Promise<Uint8Array> {
      return new TextEncoder().encode("inhoud van het blad");
    },
  };
  const ctx = { be, tokens: TOKENS, personId: 7 };
  const r = await executeWebTool(ctx, "list_files", {});
  assert.strictEqual(r.success, true, `list failed: ${r.error}`);
  const files = (r.data as Record<string, unknown>)["files"] as Array<
    Record<string, unknown>
  >;
  assert.strictEqual(files.length, 3);
  assert.strictEqual(files[0]["file_id"], "a:7:9");
  assert.strictEqual(files[0]["source"], "assignment");
  assert.strictEqual(
    (files[0]["context"] as Record<string, unknown>)["subject"],
    "Nederlands",
  );
  assert.strictEqual(files[1]["file_id"], "m:11:12");
  assert.strictEqual(files[2]["file_id"], "l:21:22");
  for (const f of files) {
    assert.strictEqual(f["readable"], true);
    assert.ok(!("url" in f), "raw urls stay out of the model payload");
  }
  // Registry round-trip: read the lesson file by id (downloads once).
  const read = await executeWebTool(ctx, "read_attachment_text", {
    file_id: "l:21:22",
  });
  assert.strictEqual(read.success, true, `read failed: ${read.error}`);
  assert.strictEqual(
    (read.data as Record<string, unknown>)["text"],
    "inhoud van het blad",
  );
  // Scope + subject filters.
  const scoped = await executeWebTool(ctx, "list_files", { scope: "message" });
  assert.strictEqual(
    ((scoped.data as Record<string, unknown>)["files"] as unknown[]).length,
    1,
  );
  const filtered = await executeWebTool(ctx, "list_files", { subject: "wis" });
  const ff = (filtered.data as Record<string, unknown>)["files"] as Array<
    Record<string, unknown>
  >;
  assert.strictEqual(ff.length, 1);
  assert.strictEqual(ff[0]["source"], "lesson");
  __clearFileState();
});
