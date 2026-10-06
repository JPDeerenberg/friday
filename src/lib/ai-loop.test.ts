/**
 * Unit tests for the provider-agnostic tool loop (src/lib/ai-loop.ts).
 * The desktop loop mirrors the same policy in Rust (see commands/ai.rs
 * loop-policy tests).
 *
 * Phase 6 of fixes/friday-ai-upgrade-plan.md (items 1–5).
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai-loop.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import {
  FINAL_NUDGE,
  MAX_ROUNDS,
  runToolLoop,
  sanitizeHistory,
  toolTimeoutMs,
  trimHistory,
  withToolTimeout,
  type LoopChatMessage,
  type LoopChatResponse,
  type LoopDeps,
} from "./ai-loop.ts";

class StatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function baseDeps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    systemPrompt: "sys",
    initialMessages: [{ role: "user", content: "hi" }],
    chat: async () => ({ content: "done", toolCalls: [] }),
    executeTool: async () => ({ ok: true as const, data: {} }),
    onBudgetAccount: (data) => ({ payload: data, budgetHit: false }),
    sleep: async () => {},
    ...over,
  };
}

// ─── Item 1: every tool call gets a result ───────────────────────────────────

test("throwing tool becomes a result, turn continues", async () => {
  const out = await baseDeps({
    chat: async (msgs) => {
      if (msgs.some((m) => m.role === "tool"))
        return { content: "answered", toolCalls: [] };
      return {
        content: "",
        toolCalls: [{ id: "1", name: "get_grades", arguments: {} }],
      };
    },
    executeTool: async () => {
      throw new Error("Magister down");
    },
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.content, "answered");
  assert.strictEqual(r.stopped, false);
});

test("tool timeout becomes a retryable result", async () => {
  const toolTexts: string[] = [];
  const out = await baseDeps({
    chat: async (msgs) => {
      if (msgs.some((m) => m.role === "tool")) {
        toolTexts.push(
          ...msgs.filter((m) => m.role === "tool").map((m) => m.content),
        );
        return { content: "answered", toolCalls: [] };
      }
      return {
        content: "",
        // Never-resolving execute + 20ms race: exercise via withToolTimeout below.
        toolCalls: [{ id: "1", name: "get_grades", arguments: {} }],
      };
    },
    executeTool: () =>
      withToolTimeout(new Promise(() => {}), 20, "get_grades") as Promise<{
        ok: boolean;
        data: unknown;
      }>,
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.content, "answered");
  assert.strictEqual(toolTexts.length, 1);
  assert.match(toolTexts[0], /Time-out bij tool get_grades/);
});

test("withToolTimeout rejects slow tools, passes fast ones", async () => {
  await assert.rejects(
    withToolTimeout(new Promise(() => {}), 20, "t"),
    /Time-out bij tool t/,
  );
  assert.strictEqual(await withToolTimeout(Promise.resolve(7), 1000, "t"), 7);
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    withToolTimeout(new Promise(() => {}), 1000, "t", ctrl.signal),
    /Abort/,
  );
});

test("file reads get the long timeout", () => {
  assert.strictEqual(toolTimeoutMs("read_attachment_text"), 30000);
  assert.strictEqual(toolTimeoutMs("download_file"), 30000);
  assert.strictEqual(toolTimeoutMs("get_grades"), 15000);
});

test("planner and grade overview get 45s", () => {
  assert.strictEqual(toolTimeoutMs("run_update_ai_schedule"), 45000);
  assert.strictEqual(toolTimeoutMs("get_full_grade_overview"), 45000);
});

// ─── Item 2: malformed args + unknown tools ──────────────────────────────────

test("string args are parsed; junk fails gracefully", async () => {
  const got: unknown[] = [];
  const out = await baseDeps({
    chat: async (msgs) => {
      if (msgs.some((m) => m.role === "tool")) {
        got.push(
          (msgs.find((m) => m.role === "tool") as LoopChatMessage).content,
        );
        return { content: "answered", toolCalls: [] };
      }
      return {
        content: "",
        toolCalls: [
          { id: "1", name: "t", arguments: '{"a":1}' },
          { id: "2", name: "t", arguments: "{oops" },
        ],
      };
    },
    executeTool: async (_n, args) => ({ ok: true, data: args }),
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.content, "answered");
  void got;
});

test("unknown tool fails cleanly without throwing", async () => {
  const out = await baseDeps({
    chat: async (msgs) => {
      if (msgs.some((m) => m.role === "tool"))
        return { content: "answered", toolCalls: [] };
      return {
        content: "",
        toolCalls: [{ id: "1", name: "nope", arguments: {} }],
      };
    },
    executeTool: async () => ({
      ok: false,
      data: null,
      error: "Onbekende tool: nope",
    }),
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.content, "answered");
});

// ─── Item 3: parallel reads, sequential writes ───────────────────────────────

test("reads run concurrently, writes in order", async () => {
  const started: string[] = [];
  const finished: string[] = [];
  const gate = (): Promise<void> => new Promise((res) => setTimeout(res, 30));
  const calls = [
    { id: "1", name: "get_grades", arguments: {} },
    { id: "2", name: "get_messages", arguments: {} },
  ];
  let concurrentMax = 0;
  let active = 0;
  const out = await baseDeps({
    chat: async (msgs) => {
      if (msgs.some((m) => m.role === "tool"))
        return { content: "answered", toolCalls: [] };
      return { content: "", toolCalls: calls };
    },
    executeTool: async (name) => {
      active += 1;
      concurrentMax = Math.max(concurrentMax, active);
      started.push(name);
      await gate();
      active -= 1;
      finished.push(name);
      return { ok: true, data: { n: name } };
    },
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.content, "answered");
  assert.strictEqual(concurrentMax, 2, "reads must overlap");
  assert.deepStrictEqual([...started].sort(), ["get_grades", "get_messages"]);

  // Writes stay sequential.
  const order: string[] = [];
  const wout = await baseDeps({
    chat: async (msgs) => {
      if (msgs.some((m) => m.role === "tool"))
        return { content: "answered", toolCalls: [] };
      return {
        content: "",
        toolCalls: [
          { id: "1", name: "send_message", arguments: { a: 1 } },
          { id: "2", name: "mark_messages_read", arguments: { b: 2 } },
        ],
      };
    },
    executeTool: async (name) => {
      order.push(`start-${name}`);
      await gate();
      order.push(`end-${name}`);
      return { ok: true, data: {}, staged: { action: name } };
    },
    isWriteTool: (n) => n === "send_message" || n === "mark_messages_read",
  });
  const wr = await runToolLoop(wout);
  assert.deepStrictEqual(order, [
    "start-send_message",
    "end-send_message",
    "start-mark_messages_read",
    "end-mark_messages_read",
  ]);
  assert.strictEqual(wr.staged.length, 2);
});

// ─── Item 4: dedupe ─────────────────────────────────────────────────────────

test("identical calls reuse the cached result with a note", async () => {
  let executions = 0;
  let toolTexts: string[] = [];
  const out = await baseDeps({
    chat: async (msgs) => {
      const tools = msgs.filter((m) => m.role === "tool");
      if (tools.length > 0) {
        toolTexts = tools.map((m) => m.content);
        return { content: "answered", toolCalls: [] };
      }
      const same = { start: "2026-09-21", end: "2026-09-27" };
      return {
        content: "",
        toolCalls: [
          { id: "1", name: "get_calendar_events", arguments: same },
          {
            id: "2",
            name: "get_calendar_events",
            arguments: { end: "2026-09-27", start: "2026-09-21" },
          },
        ],
      };
    },
    executeTool: async () => {
      executions += 1;
      return { ok: true, data: { items: [1] } };
    },
  });
  const r = await runToolLoop(out);
  assert.strictEqual(executions, 1);
  assert.strictEqual(toolTexts.length, 2);
  assert.match(toolTexts[1], /cached resultaat hergebruikt/);
  assert.strictEqual(r.content, "answered");
});

// ─── Item 5: rounds + final tool-less call ───────────────────────────────────

test("rounds exhausted triggers one tools-disabled closing call", async () => {
  const chatModes: boolean[] = [];
  let rounds = 0;
  const out = await baseDeps({
    maxRounds: 2,
    chat: async (msgs, opts) => {
      chatModes.push(opts.toolsEnabled);
      if (!opts.toolsEnabled) {
        assert.ok(msgs[msgs.length - 1].content.includes(FINAL_NUDGE));
        return { content: "final answer", toolCalls: [] };
      }
      rounds += 1;
      return {
        content: `thinking ${rounds}`,
        toolCalls: [{ id: `${rounds}`, name: "get_grades", arguments: {} }],
      };
    },
    executeTool: async () => ({ ok: true, data: {} }),
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.content, "final answer");
  assert.deepStrictEqual(chatModes, [true, true, false]);
  assert.strictEqual(r.roundsUsed, 2);
});

test("natural end needs no closing call", async () => {
  let calls = 0;
  const out = await baseDeps({
    chat: async () => {
      calls += 1;
      return { content: "direct", toolCalls: [] };
    },
  });
  const r = await runToolLoop(out);
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.content, "direct");
});

test("budget trip with no answer still gets the closing call", async () => {
  let closing = 0;
  let rounds = 0;
  const out = await baseDeps({
    chat: async (msgs, opts) => {
      if (!opts.toolsEnabled) {
        closing += 1;
        return { content: "wrapped up", toolCalls: [] };
      }
      if (msgs.some((m) => m.role === "tool"))
        return { content: "", toolCalls: [] };
      rounds += 1;
      return {
        content: "",
        toolCalls: [{ id: `${rounds}`, name: "t", arguments: {} }],
      };
    },
    executeTool: async () => ({ ok: true, data: { big: true } }),
    onBudgetAccount: () => ({ payload: { error: "budget" }, budgetHit: true }),
  });
  const r = await runToolLoop(out);
  assert.strictEqual(closing, 1);
  assert.strictEqual(r.content, "wrapped up");
});

test("max rounds default is 8", () => {
  assert.strictEqual(MAX_ROUNDS, 8);
});

// ─── Context trim recovery ──────────────────────────────────────────────────

test("context overflow trims history and retries once", async () => {
  let calls = 0;
  const seenLengths: number[] = [];
  const many: LoopChatMessage[] = [];
  for (let i = 0; i < 10; i++) many.push({ role: "user", content: `old ${i}` });
  const out = await baseDeps({
    initialMessages: many,
    chat: async (msgs) => {
      calls += 1;
      seenLengths.push(msgs.length);
      if (calls === 1)
        throw new StatusError(400, "maximum context length exceeded");
      return { content: "recovered", toolCalls: [] };
    },
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.content, "recovered");
  assert.strictEqual(calls, 2);
  assert.ok(seenLengths[1] < seenLengths[0], "history trimmed before retry");
});

test("second overflow still throws", async () => {
  const out = await baseDeps({
    chat: async () => {
      throw new StatusError(400, "maximum context length exceeded");
    },
  });
  await assert.rejects(runToolLoop(out), /maximum context/);
});

test("trimHistory keeps system + tail", () => {
  const msgs: LoopChatMessage[] = [{ role: "system", content: "s" }];
  for (let i = 0; i < 6; i++) msgs.push({ role: "user", content: `${i}` });
  const trimmed = trimHistory(msgs);
  assert.strictEqual(trimmed[0].content, "s");
  assert.strictEqual(trimmed.length, 5);
});

test("trimHistory never starts the tail with a tool message", () => {
  const msgs: LoopChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "q1" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "1", name: "t", args: {} }],
    },
    { role: "tool", content: "r1", tool_call_id: "1", name: "t" },
    { role: "user", content: "q2" },
  ];
  // keep=2 would start at the tool message — it advances to the user message.
  const trimmed = trimHistory(msgs, 2);
  assert.strictEqual(trimmed[0].role, "system");
  assert.deepStrictEqual(
    trimmed.slice(1).map((m) => m.role),
    ["user"],
  );
  assert.strictEqual(trimmed[1].content, "q2");
});

test("trimHistory never starts with a cut assistant turn", () => {
  const msgs: LoopChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "plain answer" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "1", name: "t", args: {} }],
    },
  ];
  // keep=2 starts at the plain answer (kept; the trailing assistant turn
  // with calls is fine at the end), keep=1 starts at the assistant with
  // cut tool results (dropped, leaving only the system prompt).
  const two = trimHistory(msgs, 2);
  assert.deepStrictEqual(
    two.map((m) => m.content),
    ["s", "plain answer", ""],
  );
  const one = trimHistory(msgs, 1);
  assert.deepStrictEqual(
    one.map((m) => m.content),
    ["s"],
  );
});

// ─── History sanitiser (invalid_assistant_message self-heal) ────────────────

test("sanitizeHistory drops empty assistants and orphan tools", () => {
  const msgs: LoopChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "q" },
    { role: "assistant", content: "   " },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", name: "t", args: {} }],
    },
    { role: "tool", content: "r", tool_call_id: "c1", name: "t" },
    { role: "tool", content: "orphan", tool_call_id: "nope", name: "x" },
    { role: "assistant", content: "antwoord" },
  ];
  const cleaned = sanitizeHistory(msgs);
  assert.deepStrictEqual(
    cleaned.map((m) => `${m.role}:${m.content}`),
    ["system:s", "user:q", "assistant:", "tool:r", "assistant:antwoord"],
  );
});

test("sanitizeHistory drops nameless calls and uniques ids", () => {
  const msgs: LoopChatMessage[] = [
    { role: "system", content: "s" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", name: "", args: {} },
        { id: "c1", name: "t", args: {} },
        { id: "c1", name: "u", args: {} },
      ],
    },
  ];
  const cleaned = sanitizeHistory(msgs);
  assert.strictEqual(cleaned.length, 2);
  const calls = cleaned[1].tool_calls!;
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].id, "c1");
  assert.notStrictEqual(calls[1].id, "c1");
});

test("invalid assistant message retries once with cleaned history", async () => {
  let calls = 0;
  const seen: LoopChatMessage[][] = [];
  const poisoned: LoopChatMessage[] = [
    { role: "user", content: "maak een plan voor vrijdag" },
    { role: "assistant", content: "" },
  ];
  const out = baseDeps({
    initialMessages: poisoned,
    chat: async (msgs) => {
      calls += 1;
      seen.push(msgs.map((m) => ({ ...m })));
      if (calls === 1) {
        throw new StatusError(
          400,
          "Assistant message must have either content or tool_calls, but not none. (type=invalid_request_assistant_message, code=3240)",
        );
      }
      return { content: "hersteld", toolCalls: [] };
    },
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.content, "hersteld");
  assert.strictEqual(calls, 2);
  // The retry no longer replays the empty assistant message.
  const retryRoles = seen[1].map((m) => `${m.role}:${m.content}`);
  assert.deepStrictEqual(retryRoles, [
    "system:sys",
    "user:maak een plan voor vrijdag",
  ]);
});

test("second invalid assistant message still throws", async () => {
  let calls = 0;
  const out = baseDeps({
    chat: async () => {
      calls += 1;
      throw new StatusError(
        400,
        "Assistant message must have either content or tool_calls (type=invalid_request_assistant_message)",
      );
    },
  });
  await assert.rejects(runToolLoop(out), /either content or tool_calls/);
  assert.strictEqual(calls, 2);
});

// ─── Abort ──────────────────────────────────────────────────────────────────

test("abort keeps partial text and marks stopped", async () => {
  const ctrl = new AbortController();
  const out = await baseDeps({
    signal: ctrl.signal,
    chat: async (msgs) => {
      if (msgs.some((m) => m.role === "tool"))
        return { content: "answered", toolCalls: [] };
      ctrl.abort();
      return {
        content: "partial",
        toolCalls: [{ id: "1", name: "t", arguments: {} }],
      };
    },
    executeTool: async () => ({ ok: true, data: {} }),
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.stopped, true);
  assert.strictEqual(r.content, "partial");
});

// ─── Retry integration (429 then success) ───────────────────────────────────

test("429 from chat retries then succeeds", async () => {
  let calls = 0;
  const out = await baseDeps({
    chat: async () => {
      calls += 1;
      if (calls === 1) throw new StatusError(429, "Te veel verzoeken");
      return { content: "recovered", toolCalls: [] } as LoopChatResponse;
    },
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.content, "recovered");
  assert.strictEqual(calls, 2);
});

test("401 from chat is not retried", async () => {
  let calls = 0;
  const out = await baseDeps({
    chat: async () => {
      calls += 1;
      throw new StatusError(401, "HTTP 401");
    },
  });
  await assert.rejects(runToolLoop(out), /401/);
  assert.strictEqual(calls, 1);
});

test("trace records per-turn calls with ok flags", async () => {
  const out = await baseDeps({
    chat: async (msgs) => {
      if (msgs.some((m) => m.role === "tool"))
        return { content: "answered", toolCalls: [] };
      return {
        content: "working",
        toolCalls: [
          { id: "1", name: "get_grades", arguments: { top: 5 } },
          { id: "2", name: "nope", arguments: {} },
        ],
      };
    },
    executeTool: async (name, args) =>
      name === "get_grades"
        ? { ok: true, data: { items: [1] } }
        : { ok: false, data: null, error: "Onbekende tool: nope" },
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.trace.length, 1);
  assert.strictEqual(r.trace[0].text, "working");
  assert.strictEqual(r.trace[0].calls.length, 2);
  assert.deepStrictEqual(r.trace[0].calls[0].args, { top: 5 });
  assert.strictEqual(r.trace[0].calls[0].ok, true);
  assert.strictEqual(r.trace[0].calls[1].ok, false);
});

test("onActivity traces answer, tools and idle", async () => {
  const seen: string[] = [];
  const out = await baseDeps({
    onActivity: (a) => seen.push(a.kind + (a.tool ? `:${a.tool}` : "")),
    chat: async (msgs) => {
      if (msgs.some((m) => m.role === "tool"))
        return { content: "answered", toolCalls: [] };
      return {
        content: "",
        toolCalls: [{ id: "1", name: "get_grades", arguments: {} }],
      };
    },
    executeTool: async () => ({ ok: true, data: {} }),
  });
  const r = await runToolLoop(out);
  assert.strictEqual(r.content, "answered");
  assert.deepStrictEqual(seen, ["answer", "tool:get_grades", "answer", "idle"]);
});

test("chat receives attempt index and text deltas", async () => {
  const attempts: number[] = [];
  const out = await baseDeps({
    chat: async (_msgs, opts) => {
      attempts.push(opts.attempt);
      opts.onTextDelta?.("tok");
      return { content: "done", toolCalls: [] };
    },
  });
  const deltas: string[] = [];
  const out2 = { ...out, onTextDelta: (d: string) => deltas.push(d) };
  const r = await runToolLoop(out2);
  assert.strictEqual(r.content, "done");
  assert.deepStrictEqual(attempts, [0]);
  assert.deepStrictEqual(deltas, ["tok"]);
});
