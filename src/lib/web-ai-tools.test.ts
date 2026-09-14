/**
 * Unit tests for the browser AI tool port (src/lib/web-ai-tools.ts).
 * Grade-math expectations mirror src-tauri/src/ai/grade_calc.rs unit tests.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/web-ai-tools.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import {
  WEB_TOOL_DEFS,
  averageForGrade,
  confirmWebPendingAction,
  executeWebTool,
  minGradeForPass,
  newOverallAverage,
  parseDutchGrade,
  predictedAverage,
  predictedEnd,
  redactDocent,
  redactTeacherNameStr,
  requiredGrade,
  weightedSum,
  __clearPendingForTests,
  __pendingForTests,
} from "./web-ai-tools.ts";
import type { TierA } from "./web-tier-b.ts";
import type { SessionTokens } from "./backend.ts";

const TOKENS = { accessToken: "t", refreshToken: "r", expiresAt: "", apiEndpoint: "https://x.magister.net", personId: 7 } as SessionTokens;
const CTX = { be: {} as TierA, tokens: TOKENS, personId: 7 };

// ─── Redaction ─────────────────────────────────────────────────────────────

test("redactDocent prefers code, falls back to last name", () => {
  assert.deepStrictEqual(redactDocent({ Id: 1, Docentcode: "JNS", Naam: "Jan Jansen" }), {
    id: 1, code: "JNS", naam: "JNS",
  });
  assert.deepStrictEqual(redactDocent({ Id: 2, Naam: "Piet Pietersen" }), { id: 2, naam: "Pietersen" });
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
  assert.strictEqual(predictedAverage(21, 3, [{ value: 5, weight: 1 }], true, 1), "6.5");
  assert.strictEqual(predictedAverage(21, 3, [{ value: 5, weight: 1 }], false, 1), "7.0");
});

test("minGradeForPass variants", () => {
  // 5.5 * 3 - 12 = 4.5
  assert.deepStrictEqual(minGradeForPass(12, 2, 5.5), { kind: "needed", value: "4.5" });
  assert.deepStrictEqual(minGradeForPass(27, 3, 5.5), { kind: "already_passing" });
  assert.deepStrictEqual(minGradeForPass(2, 2, 5.5), { kind: "impossible" });
  assert.deepStrictEqual(minGradeForPass(0, 0, 5.5), { kind: "impossible" });
});

test("averageForGrade is weighted", () => {
  assert.strictEqual(averageForGrade(7, 1, 5, 1, 1), "6.0");
});

test("newOverallAverage replaces subject", () => {
  // (9 + 8 + 6) / 3 = 7.67
  assert.strictEqual(
    newOverallAverage([["Wiskunde", 7], ["Nederlands", 8], ["Engels", 6]], "Wiskunde", 9, 2),
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

test("web tool set excludes schedule tools, keeps writes", () => {
  const names = WEB_TOOL_DEFS.map((t) => t.name);
  for (const banned of [
    "get_ai_schedule", "create_ai_schedule_item", "update_ai_schedule_item",
    "complete_ai_schedule_item", "dismiss_ai_schedule_item", "set_homework_duration",
    "run_update_ai_schedule",
  ]) {
    assert.ok(!names.includes(banned), `schedule tool leaked: ${banned}`);
  }
  for (const needed of [
    "get_calendar_events", "get_grades", "get_full_grade_overview", "get_schoolyears",
    "get_assignments", "get_assignment_detail", "get_messages", "get_message_content",
    "send_message", "mark_messages_read", "get_absences", "get_studiewijzers",
    "get_activities", "get_bronnen", "get_leermiddelen", "get_profile_info",
    "get_today_summary", "read_attachment_text", "calculate_grade_scenario",
    "create_calendar_event", "download_file",
  ]) {
    assert.ok(names.includes(needed), `missing tool: ${needed}`);
  }
  assert.strictEqual(names.length, 21);
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

test("get_calendar_events simplifies + redacts", async () => {
  const be = fakeBe({
    afspraken: {
      Items: [{
        Id: 1, Start: "s", Einde: "e", Type: 13, Status: 1,
        Vakken: [{ Naam: "Wis" }], Docenten: [{ Id: 9, Docentcode: "JNS", Naam: "Jan Jansen" }],
        Lokalen: [{ Naam: "A1" }], LesuurVan: 1, Omschrijving: "o", Inhoud: null, Afgerond: false,
      }],
    },
  });
  const r = await executeWebTool({ be, tokens: TOKENS, personId: 7 }, "get_calendar_events", { start: "x", end: "y" });
  assert.strictEqual(r.success, true);
  const items = (r.data as { items: Array<Record<string, unknown>> }).items;
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0]["docent"], "JNS");
  assert.strictEqual(items[0]["vak"], "Wis");
});

test("send_message stages (never sends) with confirmation payload", async () => {
  __clearPendingForTests();
  const be = fakeBe({});
  const r = await executeWebTool({ be, tokens: TOKENS, personId: 7 }, "send_message", {
    subject: "Hallo", body: "Test", recipients: [{ id: 1, type: "leerling" }],
  });
  assert.strictEqual(r.success, true);
  const data = r.data as Record<string, unknown>;
  assert.strictEqual(data["status"], "pending_user_confirmation");
  assert.match((data["action_id"] as string) ?? "", /^act-/);
  assert.strictEqual(__pendingForTests().size, 1);
});

test("send_message validates required fields", async () => {
  const r = await executeWebTool(CTX, "send_message", { subject: "", body: "x", recipients: [] });
  assert.strictEqual(r.success, false);
});

test("confirm replays the exact desktop endpoints", async () => {
  __clearPendingForTests();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const be: TierA = {
    async magister<T>(_: SessionTokens, method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      return {} as T;
    },
  };
  const staged = await executeWebTool({ be, tokens: TOKENS, personId: 7 }, "send_message", {
    subject: "S", body: "B", recipients: [{ id: 3 }],
  });
  const actionId = (staged.data as Record<string, unknown>)["action_id"] as string;
  const out = (await confirmWebPendingAction({ be, tokens: TOKENS, personId: 7 }, actionId)) as Record<string, unknown>;
  assert.strictEqual(out["status"], "verzonden");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, "POST");
  assert.strictEqual(calls[0].path, "berichten/verzenden");
  const body = calls[0].body as Record<string, unknown>;
  assert.strictEqual(body["onderwerp"], "S");
  assert.deepStrictEqual(body["ontvangers"], [{ id: 3, type: "leerling" }]);
  // Consumed: second confirm fails.
  await assert.rejects(confirmWebPendingAction({ be, tokens: TOKENS, personId: 7 }, actionId));
});

test("mark_messages_read stages + replays PUT berichten/gelezen", async () => {
  __clearPendingForTests();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const be: TierA = {
    async magister<T>(_: SessionTokens, method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      return {} as T;
    },
  };
  const ctx = { be, tokens: TOKENS, personId: 7 };
  const staged = await executeWebTool(ctx, "mark_messages_read", { message_ids: [11, 12] });
  const actionId = (staged.data as Record<string, unknown>)["action_id"] as string;
  await confirmWebPendingAction(ctx, actionId);
  assert.deepStrictEqual(calls[0], { method: "PUT", path: "berichten/gelezen", body: { BerichtIds: [11, 12] } });
});

test("calculate_grade_scenario with explicit grades", async () => {
  const be = fakeBe({});
  const r = await executeWebTool({ be, tokens: TOKENS, personId: 7 }, "calculate_grade_scenario", {
    subject: "Wiskunde",
    grades: [{ value: 6, weight: 1 }, { value: 6, weight: 1 }, { value: 6, weight: 1 }, { value: 6, weight: 1 }],
    target_average: 6.5,
    decimal_points: 1,
  });
  assert.strictEqual(r.success, true);
  const data = r.data as Record<string, unknown>;
  assert.strictEqual(data["required_grade"], "8.5");
  assert.strictEqual(data["grade_count"], 4);
});

test("calculate_grade_scenario needs grades or schoolyear+subject", async () => {
  const r = await executeWebTool({ be: fakeBe({}), tokens: TOKENS, personId: 7 }, "calculate_grade_scenario", {});
  assert.strictEqual(r.success, false);
});

test("read_attachment_text rejects non-text on web", async () => {
  const r = await executeWebTool({ be: fakeBe({}), tokens: TOKENS, personId: 7 }, "read_attachment_text", {
    url: "x", filename: "doc.pdf",
  });
  assert.strictEqual(r.success, false);
  assert.match(r.error ?? "", /tekst/);
});

test("download_file reports size without model payload bloat", async () => {
  const be = fakeBe({ "bijlagen/1": { location: "https://x.magister.net/contents/1" } });
  const beBytes: TierA = {
    ...be,
    async magisterBytes(): Promise<Uint8Array> {
      return new Uint8Array(100);
    },
  };
  const r = await executeWebTool({ be: beBytes, tokens: TOKENS, personId: 7 }, "download_file", { url: "bijlagen/1" });
  assert.strictEqual(r.success, true);
  assert.strictEqual((r.data as Record<string, unknown>)["size_bytes"], 100);
});
