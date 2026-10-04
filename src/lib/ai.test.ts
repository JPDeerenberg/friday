/**
 * Unit tests for the web AI prompt builder (src/lib/ai.ts).
 * Store/proxy paths need IndexedDB + network — covered live instead.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import { buildWebSystemPrompt } from "./ai.ts";
import { todayAmsterdam } from "./ai-time.ts";

test("system prompt carries real date and no-hallucination rule", () => {
  const today = todayAmsterdam();
  const p = buildWebSystemPrompt(undefined, true);
  assert.ok(p.includes("NU:"), "NOW block");
  assert.ok(p.includes(today), "real date, not a placeholder");
  assert.ok(p.includes("no hallucineren"), "grounding rule");
});

test("tool-enabled prompt lists web tools, including schedule tools", () => {
  const p = buildWebSystemPrompt(undefined, true);
  for (const t of [
    "get_calendar_events",
    "get_calendar_event_detail",
    "read_notes",
    "append_note",
    "calculate_grade_scenario",
    "send_message",
    "get_today_summary",
    "get_current_time",
    "get_ai_schedule",
    "create_ai_schedule_item",
    "list_files",
    "read_attachment_text",
    "run_update_ai_schedule",
    "undo_last_ai_plan_change",
  ]) {
    assert.ok(p.includes(t), `missing ${t}`);
  }
});

test("plain prompt has no tool section, keeps page context and NOW block", () => {
  const p = buildWebSystemPrompt("Pagina: Cijfers\nData: {}", false);
  assert.ok(
    !p.includes("toegang tot de volgende tools"),
    "no tool section when disabled",
  );
  assert.ok(p.includes("Pagina: Cijfers"), "page context kept");
  assert.ok(p.includes("NU:"), "NOW block present without tools too");
});
