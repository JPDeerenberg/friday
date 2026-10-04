/**
 * Unit tests for the AI diagnostics ring buffer (src/lib/ai-diagnostics.ts).
 * Rust mirror: src-tauri/src/commands/ai.rs diag tests.
 *
 * Phase 6 item 12.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai-diagnostics.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import {
  DIAG_LIMIT,
  __diagLen,
  clearAiDiagnostics,
  diagnosticsText,
  getAiDiagnostics,
  recordAiDiag,
} from "./ai-diagnostics.ts";

test("ring caps at fifty, newest first", () => {
  clearAiDiagnostics();
  for (let i = 0; i < 60; i++) {
    recordAiDiag({
      provider: "openai",
      model: "m",
      op: "chat",
      status: "ok",
      durationMs: 1,
      toolNames: [`t${i}`],
    });
  }
  assert.strictEqual(__diagLen(), DIAG_LIMIT);
  const list = getAiDiagnostics();
  assert.strictEqual(list.length, DIAG_LIMIT);
  assert.deepStrictEqual(list[0].toolNames, ["t59"]);
  clearAiDiagnostics();
  assert.deepStrictEqual(getAiDiagnostics(), []);
});

test("entries carry metadata only, dump is copyable", () => {
  clearAiDiagnostics();
  recordAiDiag({
    provider: "openai",
    model: "gpt-4o-mini",
    op: "tools",
    status: "error",
    durationMs: 1234,
    errorClass: "rate_limited",
    toolNames: ["get_grades", "get_calendar_events"],
  });
  const [e] = getAiDiagnostics();
  assert.ok(e.platform === "web" || e.platform === "desktop");
  assert.ok(typeof e.ts === "number");
  assert.strictEqual(e.errorClass, "rate_limited");
  const text = diagnosticsText();
  assert.match(text, /openai\/gpt-4o-mini tools error 1234ms/);
  assert.match(text, /err=rate_limited/);
  assert.match(text, /tools=get_grades,get_calendar_events/);
  assert.ok(!text.includes("sk-"), "no key material in dumps");
  clearAiDiagnostics();
});

test("recording never throws", () => {
  clearAiDiagnostics();
  assert.doesNotThrow(() =>
    recordAiDiag({
      provider: "x",
      model: "y",
      op: "chat",
      status: "ok",
      durationMs: 0,
    }),
  );
  assert.strictEqual(__diagLen(), 1);
  clearAiDiagnostics();
});
