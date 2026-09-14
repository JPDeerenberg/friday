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

test("system prompt carries real date and no-hallucination rule", () => {
  const today = new Date().toISOString().slice(0, 10);
  const p = buildWebSystemPrompt(undefined, true);
  assert.ok(p.includes("Vandaag is"), "date line");
  assert.ok(p.includes(today), "real date, not a placeholder");
  assert.ok(p.includes("no hallucineren"), "grounding rule");
});

test("tool-enabled prompt lists web tools, never schedule tools", () => {
  const p = buildWebSystemPrompt(undefined, true);
  for (const t of ["get_calendar_events", "calculate_grade_scenario", "send_message", "get_today_summary"]) {
    assert.ok(p.includes(t), `missing ${t}`);
  }
  for (const banned of ["create_ai_schedule_item", "run_update_ai_schedule", "set_homework_duration"]) {
    assert.ok(!p.includes(banned), `schedule tool leaked: ${banned}`);
  }
});

test("plain prompt has no tool section, keeps page context", () => {
  const p = buildWebSystemPrompt("Pagina: Cijfers\nData: {}", false);
  assert.ok(!p.includes("toegang tot de volgende tools"), "no tool section when disabled");
  assert.ok(p.includes("Pagina: Cijfers"), "page context kept");
});
