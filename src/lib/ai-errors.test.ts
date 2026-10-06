/**
 * Unit tests for the AI error taxonomy + retry policy (src/lib/ai-errors.ts).
 * Rust mirror: src-tauri/src/commands/ai.rs loop-policy tests.
 *
 * Phase 6 of fixes/friday-ai-upgrade-plan.md (items 6 + 8).
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai-errors.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import {
  MAX_CHAT_ATTEMPTS,
  classifyAiError,
  dedupeKey,
  parseToolArgs,
  retryDelayMs,
  scrubSecrets,
  withRetry,
} from "./ai-errors.ts";

class StatusError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// ─── Taxonomy (plan item 8 table) ────────────────────────────────────────────

test("401/403 maps to invalid key with settings action", () => {
  const info = classifyAiError(new StatusError(401, "HTTP 401 — Unauthorized"));
  assert.strictEqual(info.kind, "invalid_key");
  assert.strictEqual(info.retryable, false);
  assert.strictEqual(info.action?.kind, "open-ai-settings");
  assert.match(info.message, /API-sleutel/);
});

test("desktop string errors classify the same way", () => {
  assert.strictEqual(
    classifyAiError("AI error: HTTP 429 Too Many Requests").kind,
    "rate_limited",
  );
  assert.strictEqual(
    classifyAiError("HTTP 404 model not found: gpt-9").kind,
    "model_not_found",
  );
  assert.strictEqual(
    classifyAiError("request failed with HTTP 503").kind,
    "server_busy",
  );
});

test("404 model maps to model_not_found", () => {
  const info = classifyAiError(new StatusError(404, "model_not_found"));
  assert.strictEqual(info.kind, "model_not_found");
  assert.strictEqual(info.action?.kind, "open-ai-settings");
});

test("429 is retryable without action", () => {
  const info = classifyAiError(new StatusError(429, "Te veel verzoeken"));
  assert.strictEqual(info.kind, "rate_limited");
  assert.strictEqual(info.retryable, true);
  assert.strictEqual(info.action, undefined);
});

test("context overflow maps to trim-and-retry", () => {
  const info = classifyAiError(
    new StatusError(
      400,
      "This model's maximum context length is 128000 tokens",
    ),
  );
  assert.strictEqual(info.kind, "context_too_long");
  assert.strictEqual(info.retryable, true);
});

test("502/503/504 map to server busy", () => {
  for (const s of [502, 503, 504]) {
    const info = classifyAiError(new StatusError(s, `HTTP ${s}`));
    assert.strictEqual(info.kind, "server_busy", `status ${s}`);
    assert.strictEqual(info.retryable, true);
  }
});

test("network failures map to offline with retry action", () => {
  const info = classifyAiError(new TypeError("Failed to fetch"));
  assert.strictEqual(info.kind, "offline");
  assert.strictEqual(info.retryable, true);
  assert.strictEqual(info.action?.kind, "retry");
  const zero = classifyAiError(
    new StatusError(0, "Geen verbinding met de server."),
  );
  assert.strictEqual(zero.kind, "offline");
});

test("abort maps to stopped, never retried", () => {
  const info = classifyAiError(new DOMException("Aborted", "AbortError"));
  assert.strictEqual(info.kind, "aborted");
  assert.strictEqual(info.retryable, false);
});

test("not configured maps to settings action", () => {
  const info = classifyAiError(
    new Error(
      "AI is niet geconfigureerd: vul een API-sleutel in bij Instellingen > AI Assistent.",
    ),
  );
  assert.strictEqual(info.kind, "not_configured");
  assert.strictEqual(info.action?.kind, "open-ai-settings");
});

test("unknown errors get a copy-detail action, no retry", () => {
  const info = classifyAiError(new Error("Something bizarre happened"));
  assert.strictEqual(info.kind, "unknown");
  assert.strictEqual(info.retryable, false);
  assert.strictEqual(info.action?.kind, "copy-detail");
});

test("400 without context wording is fatal with settings action", () => {
  const info = classifyAiError(new StatusError(400, "Bad request: neat freak"));
  assert.strictEqual(info.retryable, false);
  assert.strictEqual(info.action?.kind, "open-ai-settings");
});

test("empty assistant message maps to self-heal kind, Dutch, no blind retry", () => {
  const info = classifyAiError(
    new StatusError(
      400,
      "AI-fout (400): Assistant message must have either content or tool_calls, but not none. (type=invalid_request_assistant_message, code=3240)",
    ),
  );
  assert.strictEqual(info.kind, "invalid_assistant_message");
  assert.strictEqual(info.retryable, false);
  assert.match(info.message, /ruim het gesprek op/);
  const bare = classifyAiError("invalid_request_assistant_message: rejected");
  assert.strictEqual(bare.kind, "invalid_assistant_message");
});

test("invalid assistant message is never blind-retried", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new StatusError(
          400,
          "Assistant message must have either content or tool_calls",
        );
      },
      { sleep: async () => {} },
    ),
  );
  assert.strictEqual(calls, 1);
});

test("details never leak secrets", () => {
  const info = classifyAiError(
    new Error("oops sk-abcdef123456789 and Bearer xyz-secret-here"),
  );
  assert.ok(!String(info.detail).includes("sk-abcdef"));
  assert.ok(!String(info.detail).includes("xyz-secret"));
});

// ─── Retry policy (plan item 6) ─────────────────────────────────────────────

test("429 then success calls twice", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new StatusError(429, "Te veel verzoeken");
      return "ok";
    },
    { sleep: async () => {} },
  );
  assert.strictEqual(out, "ok");
  assert.strictEqual(calls, 2);
});

test("401 is never retried", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new StatusError(401, "HTTP 401");
      },
      { sleep: async () => {} },
    ),
  );
  assert.strictEqual(calls, 1);
});

test("gives up after 1 try + 2 retries", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new StatusError(503, "HTTP 503");
      },
      { sleep: async () => {} },
    ),
  );
  assert.strictEqual(calls, MAX_CHAT_ATTEMPTS);
});

test("Retry-After is honoured over the computed backoff", async () => {
  const seen: number[] = [];
  await assert.rejects(
    withRetry(
      async () => {
        throw new StatusError(429, "slow down", 5000);
      },
      { sleep: async (ms) => void seen.push(ms) },
    ),
  );
  assert.deepStrictEqual(seen, [5000, 5000]);
});

test("backoff grows exponentially within the cap", () => {
  const d0 = retryDelayMs(0);
  const d1 = retryDelayMs(1);
  assert.ok(d0 >= 500 && d0 < 750, `d0=${d0}`);
  assert.ok(d1 >= 1000 && d1 < 1250, `d1=${d1}`);
  assert.ok(retryDelayMs(99) <= 8000 + 250);
});

test("abort during backoff stops without another attempt", async () => {
  const ctrl = new AbortController();
  let calls = 0;
  const pending = withRetry(
    async () => {
      calls += 1;
      throw new StatusError(503, "HTTP 503");
    },
    { signal: ctrl.signal },
  );
  setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(pending, /Abort/);
  assert.strictEqual(calls, 1);
});

// ─── Args + dedupe helpers ──────────────────────────────────────────────────

test("parseToolArgs accepts objects, parses strings, rejects junk", () => {
  assert.deepStrictEqual(parseToolArgs({ a: 1 }), { ok: true, args: { a: 1 } });
  assert.deepStrictEqual(parseToolArgs('{"a":1}'), {
    ok: true,
    args: { a: 1 },
  });
  const bad = parseToolArgs("{oops");
  assert.strictEqual(bad.ok, false);
  if (!bad.ok)
    assert.match(bad.message, /Ongeldige argumenten.*probeer opnieuw/);
  const arr = parseToolArgs([1, 2]);
  assert.strictEqual(arr.ok, false);
});

test("dedupeKey ignores key order", () => {
  assert.strictEqual(
    dedupeKey("t", { a: 1, b: 2 }),
    dedupeKey("t", { b: 2, a: 1 }),
  );
  assert.notStrictEqual(dedupeKey("t", { a: 1 }), dedupeKey("t", { a: 2 }));
  assert.notStrictEqual(dedupeKey("t1", { a: 1 }), dedupeKey("t2", { a: 1 }));
});
