/**
 * Unit tests for the central tool-result budgeter (src/lib/ai-budget.ts).
 * Rust mirror: src-tauri/src/ai/budget.rs tests — keep both in sync.
 *
 * Phase 3 of fixes/friday-ai-upgrade-plan.md.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai-budget.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import {
  LONG_STRING_CUT,
  TOOL_RESULT_MAX_CHARS,
  TURN_BUDGET_MAX_CHARS,
  TurnBudget,
  limitToolResult,
} from "./ai-budget.ts";

function size(v: unknown): number {
  return JSON.stringify(v)?.length ?? 0;
}

function assertValidJson(v: unknown): void {
  // Throws on lone surrogates / broken structures.
  JSON.parse(JSON.stringify(v));
  assert.ok(size(v) >= 2);
}

// ─── Fast path ─────────────────────────────────────────────────────────────

test("small results pass through untouched", () => {
  const input = { items: [{ id: 1, vak: "Wis" }], count: 1 };
  assert.deepStrictEqual(limitToolResult(input), input);
  assert.strictEqual(limitToolResult(null), null);
  assert.strictEqual(limitToolResult(42), 42);
});

// ─── Step 1: drop nulls/empties ─────────────────────────────────────────────

test("nulls and empties are dropped first", () => {
  const filler: Record<string, unknown> = { keep: "yes" };
  for (let i = 0; i < 800; i++) filler[`pad${i}`] = null;
  assert.ok(size(filler) > TOOL_RESULT_MAX_CHARS);
  const out = limitToolResult(filler) as Record<string, unknown>;
  assertValidJson(out);
  assert.deepStrictEqual(out, { keep: "yes" });
});

// ─── Step 2: cut long strings ───────────────────────────────────────────────

test("long strings are cut unicode-safe", () => {
  const out = limitToolResult({ text: "🎓".repeat(500) }) as Record<
    string,
    unknown
  >;
  assertValidJson(out);
  assert.strictEqual(
    Array.from(out["text"] as string).length,
    LONG_STRING_CUT + 1,
  ); // 300 + …
  const ascii = limitToolResult({ text: "y".repeat(7000) }) as Record<
    string,
    unknown
  >;
  assert.strictEqual((ascii["text"] as string).length, LONG_STRING_CUT + 1);
});

// ─── Step 3: halve arrays, mark _truncated last ─────────────────────────────

test("fat lists are halved with a trailing _truncated marker", () => {
  const items = [];
  for (let i = 0; i < 100; i++)
    items.push({ id: i, pad: "z".repeat(200), more: "w".repeat(200) });
  const out = limitToolResult({ items, meta: { total: 100 } }) as Record<
    string,
    unknown
  >;
  assertValidJson(out);
  assert.ok(size(out) <= TOOL_RESULT_MAX_CHARS, `got ${size(out)}`);
  const keys = Object.keys(out);
  assert.strictEqual(keys[keys.length - 1], "_truncated");
  const marker = out["_truncated"] as Record<string, unknown>;
  assert.strictEqual(marker["total"], 100);
  assert.ok((marker["shown"] as number) < 100);
  assert.strictEqual((out["items"] as unknown[]).length, marker["shown"]);
  assert.ok(typeof marker["how_to_get_more"] === "string");
});

// ─── Step 4: last resort ────────────────────────────────────────────────────

test("unshrinkable objects fall back to a small notice", () => {
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) wide[`k${i}`] = "v".repeat(300);
  const out = limitToolResult(wide) as Record<string, unknown>;
  assertValidJson(out);
  assert.ok(size(out) <= TOOL_RESULT_MAX_CHARS, `got ${size(out)}`);
  assert.ok("_dropped" in out || "_truncated" in out);
});

// ─── Per-turn budget ────────────────────────────────────────────────────────

test("turn budget replaces later results once exceeded", () => {
  const budget = new TurnBudget(1000);
  const chunk = { pad: "q".repeat(300) }; // ~310 chars
  let hits = 0;
  for (let i = 0; i < 10; i++) {
    const { payload, budgetHit } = budget.account(chunk);
    if (budgetHit) {
      hits += 1;
      assert.deepStrictEqual(payload, {
        error: "budget",
        hint: "Narrow your request.",
      });
    } else {
      assert.deepStrictEqual(payload, chunk);
    }
  }
  assert.ok(hits > 0, "budget must trip");
  assert.ok(budget.usedChars <= 1000);
  assert.strictEqual(budget.remainingChars, 1000 - budget.usedChars);
});

test("default budgets match the spec constants", () => {
  assert.strictEqual(TOOL_RESULT_MAX_CHARS, 6000);
  assert.strictEqual(TURN_BUDGET_MAX_CHARS, 24000);
  const budget = new TurnBudget();
  budget.account({ a: 1 });
  assert.ok(budget.usedChars > 0);
  assert.ok(budget.remainingChars <= TURN_BUDGET_MAX_CHARS);
});

test("custom per-result limit is honoured", () => {
  const out = limitToolResult(
    { items: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    { maxChars: 60 },
  );
  assert.ok(size(out) <= 60, `got ${size(out)}: ${JSON.stringify(out)}`);
  assertValidJson(out);
});
