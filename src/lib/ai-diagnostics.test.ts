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
  historyShapeOf,
  providerTypeOf,
  recordAiDiag,
  shapeOfMessage,
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

test("shapes list roles and counts, never content", () => {
  const shape = historyShapeOf([
    { role: "system", content: "geheim" },
    { role: "user", content: "geheime vraag" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", name: "t" }],
    },
    { role: "tool", content: "geheim resultaat" },
    { role: "assistant", content: "antwoord" },
    { role: "assistant", content: "  " },
  ]);
  assert.deepStrictEqual(shape, [
    "system",
    "user",
    "assistant(c0,t1)",
    "tool",
    "assistant(c1,t0)",
    "assistant(c0,t0)",
  ]);
  assert.ok(!shape.join(",").includes("geheim"));
  assert.strictEqual(shapeOfMessage({ role: "user" }), "user");
});

test("provider type is extracted from suffixed errors", () => {
  assert.strictEqual(
    providerTypeOf(
      new Error(
        "AI-fout (400): x (type=invalid_request_assistant_message, code=3240)",
      ),
    ),
    "invalid_request_assistant_message",
  );
  assert.strictEqual(providerTypeOf(new Error("Weg")), undefined);
});

test("4xx entries carry shape and provider type in the dump", () => {
  clearAiDiagnostics();
  recordAiDiag({
    provider: "mistral",
    model: "mistral-small-latest",
    op: "tools",
    status: "error",
    durationMs: 900,
    errorClass: "invalid_assistant_message",
    providerType: "invalid_request_assistant_message",
    messageShape: ["system", "user", "assistant(c0,t0)"],
    toolNames: [],
  });
  const [e] = getAiDiagnostics();
  assert.deepStrictEqual(e.messageShape, [
    "system",
    "user",
    "assistant(c0,t0)",
  ]);
  assert.strictEqual(e.providerType, "invalid_request_assistant_message");
  const text = diagnosticsText();
  assert.match(text, /err=invalid_assistant_message/);
  assert.match(text, /type=invalid_request_assistant_message/);
  assert.match(text, /shape=\[system,user,assistant\(c0,t0\)\]/);
  clearAiDiagnostics();
});
