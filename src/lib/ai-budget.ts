/**
 * Central tool-result budgeter for the AI assistant.
 *
 * Phase 3 of fixes/friday-ai-upgrade-plan.md. Mirrors
 * `src-tauri/src/ai/budget.rs`: same constants, same shapes, same order of
 * truncation steps.
 *
 * Why: one fat tool result can overflow the model context and kill the chat.
 * Every successful tool payload passes through {@link TurnBudget#account},
 * which limits it and counts it against the per-turn budget.
 */

/** Max serialised chars per tool result. */
export const TOOL_RESULT_MAX_CHARS = 6000;
/** Max serialised chars of all tool results together per user turn. */
export const TURN_BUDGET_MAX_CHARS = 24000;
/** Long strings are cut to this many chars of content (plus …). */
export const LONG_STRING_CUT = 300;

const HOW_TO_GET_MORE =
  "Beperk het bereik of gebruik offset/limit om verder te bladeren.";

export interface LimitOptions {
  maxChars?: number;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

/** Step 1: deep-strip nulls/empty fields (key order preserved). */
function stripEmpties(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripEmpties);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (isEmptyValue(val)) continue;
      out[k] = stripEmpties(val);
    }
    return out;
  }
  return v;
}

/** Unicode-safe cut: content chars + …, never splits a surrogate pair. */
function cutStr(s: string, maxContent: number): string {
  const chars = Array.from(s);
  if (chars.length <= maxContent) return s;
  return `${chars.slice(0, maxContent).join("")}…`;
}

/** Step 2: cut every long string in the tree. */
function cutLongStrings(v: unknown): unknown {
  if (typeof v === "string")
    return Array.from(v).length > LONG_STRING_CUT
      ? cutStr(v, LONG_STRING_CUT)
      : v;
  if (Array.isArray(v)) return v.map(cutLongStrings);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = cutLongStrings(val);
    return out;
  }
  return v;
}

function serializedLength(v: unknown): number {
  const s = JSON.stringify(v);
  return s === undefined ? 0 : s.length;
}

interface ArraySlot {
  arr: unknown[];
  path: string;
}

function collectArrays(node: unknown, path: string, out: ArraySlot[]): void {
  if (Array.isArray(node)) {
    if (node.length > 0) out.push({ arr: node, path });
    node.forEach((el, i) => collectArrays(el, `${path}/${i}`, out));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, val] of Object.entries(node))
      collectArrays(val, `${path}/${k}`, out);
  }
}

/**
 * Limit a tool-result payload to `maxChars` serialised chars. Steps, in
 * order: (1) drop nulls/empties, (2) cut long strings to 300 chars,
 * (3) halve the largest arrays until it fits, marking `_truncated` as the
 * last key, (4) drop trailing object keys as a last resort, else a small
 * `_dropped` notice. Never mutates the input; always valid JSON.
 */
export function limitToolResult(result: unknown, opts?: LimitOptions): unknown {
  const max = opts?.maxChars ?? TOOL_RESULT_MAX_CHARS;
  if (result === null || result === undefined) return result;
  if (typeof result === "string") return cutStr(result, max);
  if (typeof result !== "object") return result;

  // Steps 1+2 rebuild fresh containers, so `work` is fully owned and the
  // halving below can mutate array lengths in place safely.
  let work: unknown = cutLongStrings(stripEmpties(result));
  if (serializedLength(work) <= max) return work;

  // Step 3: halve the largest arrays until it fits.
  const originals = new Map<string, number>();
  for (;;) {
    if (serializedLength(work) <= max) break;
    const slots: ArraySlot[] = [];
    collectArrays(work, "", slots);
    if (slots.length === 0) break;
    let largest = slots[0];
    for (const s of slots)
      if (serializedLength(s.arr) > serializedLength(largest.arr)) largest = s;
    if (!originals.has(largest.path))
      originals.set(largest.path, largest.arr.length);
    largest.arr.length = Math.floor(largest.arr.length / 2);
  }

  const truncatedMeta = (): Record<string, unknown> => {
    let shown = 0;
    let total = 0;
    // Re-collect: paths are stable, lengths are current.
    const slots: ArraySlot[] = [];
    collectArrays(work, "", slots);
    for (const s of slots) {
      const orig = originals.get(s.path);
      if (orig !== undefined && orig > s.arr.length) {
        shown += s.arr.length;
        total += orig;
      }
    }
    return {
      shown,
      total,
      how_to_get_more: HOW_TO_GET_MORE,
    };
  };

  if (Array.isArray(work)) {
    if (originals.size === 0) return work; // fit without cuts
    return { items: work, _truncated: truncatedMeta() };
  }

  const obj = work as Record<string, unknown>;
  if (serializedLength(work) <= max) {
    if (originals.size === 0) return obj;
    return { ...obj, _truncated: truncatedMeta() };
  }

  // Step 4: drop trailing keys as a last resort (never the marker itself).
  const keys = Object.keys(obj);
  for (let i = keys.length - 1; i >= 0; i--) {
    delete obj[keys[i]];
    if (serializedLength({ ...obj, _truncated: truncatedMeta() }) <= max) break;
  }
  if (serializedLength({ ...obj, _truncated: truncatedMeta() }) <= max)
    return { ...obj, _truncated: truncatedMeta() };

  return {
    _dropped:
      "Resultaat te groot voor de context, ook na inkorten; vernauw je verzoek.",
    _truncated: truncatedMeta(),
  };
}

export interface BudgetOutcome {
  payload: unknown;
  budgetHit: boolean;
}

/**
 * Per-turn budget: all successful tool payloads of one user turn counted
 * together (default 24k chars). Once exceeded, later results are replaced
 * by a budget error instead of data. Failure texts bypass (tens of chars;
 * Phase 6 owns the error taxonomy).
 */
export class TurnBudget {
  private used = 0;
  private readonly max: number;

  constructor(max: number = TURN_BUDGET_MAX_CHARS) {
    this.max = max;
  }

  get usedChars(): number {
    return this.used;
  }

  get remainingChars(): number {
    return Math.max(0, this.max - this.used);
  }

  account(data: unknown): BudgetOutcome {
    const limited = limitToolResult(data);
    const size = serializedLength(limited);
    if (this.used + size > this.max) {
      return {
        payload: { error: "budget", hint: "Narrow your request." },
        budgetHit: true,
      };
    }
    this.used += size;
    return { payload: limited, budgetHit: false };
  }
}
