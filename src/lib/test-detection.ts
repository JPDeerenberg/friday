/**
 * Shared test/toetsweek detection (single source of truth:
 * `shared/ai-spec/test-signals.json`).
 *
 * Rust twin: `src-tauri/src/ai/test_detection.rs` — same tokenisation
 * (split on non-alphanumeric), same matching (tokens case-insensitive,
 * uppercaseOnlyTokens only when written uppercase in the original,
 * negativePhrases on the lower-cased text), same output shape.
 */

import SIGNALS_JSON from "../../shared/ai-spec/test-signals.json" with { type: "json" };

export interface TestSignals {
  infoTypes: number[];
  tokens: string[];
  uppercaseOnlyTokens: string[];
  negativePhrases: string[];
}

export interface TestDetectionInput {
  Type?: number | null;
  InfoType?: number | null;
  Opmerking?: string | null;
  Aantekening?: string | null;
}

export type TestSource = "infotype" | "opmerking" | "aantekening" | null;

export interface TestDetection {
  isTest: boolean;
  source: TestSource;
  hint: string | null;
}

export function getTestSignals(): TestSignals {
  return SIGNALS_JSON as TestSignals;
}

/** Split on non-alphanumeric characters (unicode-aware, like Rust `char::is_alphanumeric`). */
function splitTokens(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

function trimmedOrNull(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** True when the note text carries a test signal (and no negative phrase). */
function textIsTestSignal(text: string, signals: TestSignals): boolean {
  const lower = text.toLowerCase();
  if (signals.negativePhrases.some((p) => lower.includes(p.toLowerCase()))) {
    return false;
  }
  const rawTokens = splitTokens(text);
  const lowerTokens = rawTokens.map((t) => t.toLowerCase());
  if (signals.tokens.some((tok) => lowerTokens.includes(tok.toLowerCase()))) {
    return true;
  }
  if (signals.uppercaseOnlyTokens.some((tok) => rawTokens.includes(tok))) {
    return true;
  }
  return false;
}

/**
 * Detect whether a calendar event is a test. Personal events (`Type === 1`)
 * are always skipped. Output: `{ isTest, source, hint }` where `hint` is
 * the trimmed note text.
 */
export function detectTest(
  input: TestDetectionInput,
  signals: TestSignals = getTestSignals(),
): TestDetection {
  if ((input.Type ?? 0) === 1) {
    return { isTest: false, source: null, hint: null };
  }
  const opmerking = trimmedOrNull(input.Opmerking);
  const aantekening = trimmedOrNull(input.Aantekening);
  if (signals.infoTypes.includes(input.InfoType ?? 0)) {
    return {
      isTest: true,
      source: "infotype",
      hint: opmerking ?? aantekening ?? null,
    };
  }
  if (opmerking !== null && textIsTestSignal(opmerking, signals)) {
    return { isTest: true, source: "opmerking", hint: opmerking };
  }
  if (aantekening !== null && textIsTestSignal(aantekening, signals)) {
    return { isTest: true, source: "aantekening", hint: aantekening };
  }
  return { isTest: false, source: null, hint: null };
}
