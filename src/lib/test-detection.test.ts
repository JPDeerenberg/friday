/**
 * Test/toetsweek detection parity: the TS implementation must agree with
 * `shared/ai-spec/test-signals.cases.json` (same table is covered on the
 * Rust side by `src-tauri/src/ai/test_detection.rs` tests).
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/test-detection.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import { detectTest } from "./test-detection.ts";
import CASES_JSON from "../../shared/ai-spec/test-signals.cases.json" with { type: "json" };

interface CaseRow {
  name: string;
  input: {
    Type: number;
    InfoType: number;
    Opmerking: string | null;
    Aantekening: string | null;
  };
  expected: { isTest: boolean; source: string | null; hint: string | null };
}

test("shared case table parity", () => {
  const cases = CASES_JSON as CaseRow[];
  assert.ok(cases.length >= 5, "case table must hold the required cases");
  for (const c of cases) {
    const got = detectTest(c.input);
    assert.strictEqual(got.isTest, c.expected.isTest, `${c.name}: isTest`);
    assert.strictEqual(got.source, c.expected.source, `${c.name}: source`);
    assert.strictEqual(got.hint, c.expected.hint, `${c.name}: hint`);
  }
});

test("required cases present", () => {
  const cases = CASES_JSON as CaseRow[];
  const names = cases.map((c) => c.name);
  assert.ok(
    names.some((n) => /opmerking/i.test(n)),
    "sample event via opmerking",
  );
  assert.ok(
    names.some((n) => /InfoType 2/.test(n)),
    "infotype case",
  );
  assert.ok(
    names.some((n) => /geen toets/i.test(n)),
    "negative case",
  );
  assert.ok(
    names.some((n) => /normal lesson/i.test(n)),
    "normal lesson",
  );
  assert.ok(
    names.some((n) => /personal/i.test(n)),
    "personal event",
  );
});
