/**
 * AI parity test: the web implementation must match the shared spec.
 *
 * `shared/ai-spec/tools.json` is the single source of truth. Desktop consumes
 * it by construction (`src-tauri/src/ai/spec.rs` renders straight from it),
 * so drift can only enter on the web side — this test fails CI when it does.
 * Rust-side coverage lives in `src-tauri/src/ai/spec.rs` tests.
 *
 * Phase 9 of fixes/friday-ai-upgrade-plan.md (item 2).
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai-parity.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import { WEB_TOOL_DEFS } from "./web-ai-tools.ts";
import {
  SECTION_NAMES,
  firstSentence,
  getPromptSections,
  getToolsSpec,
  parsePromptSections,
  renderPrompt,
  renderToolList,
} from "./ai-spec.ts";
import PROMPT_MD from "../../shared/ai-spec/prompt.nl.md?raw";
import TOOLS_JSON from "../../shared/ai-spec/tools.json" with { type: "json" };

// ─── Tool definitions ──────────────────────────────────────────────────────

test("spec holds 40 versioned tools", () => {
  const spec = getToolsSpec();
  assert.strictEqual(spec.version, 1);
  assert.strictEqual(spec.tools.length, 40);
  assert.deepStrictEqual(TOOLS_JSON, spec);
});

test("WEB_TOOL_DEFS equals the spec exactly (names, order, schemas)", () => {
  const spec = getToolsSpec();
  assert.strictEqual(WEB_TOOL_DEFS.length, spec.tools.length);
  for (let i = 0; i < spec.tools.length; i++) {
    assert.strictEqual(
      WEB_TOOL_DEFS[i].name,
      spec.tools[i].name,
      `order drift at ${i}`,
    );
    assert.strictEqual(
      WEB_TOOL_DEFS[i].description,
      spec.tools[i].description,
      `desc drift: ${spec.tools[i].name}`,
    );
    assert.deepStrictEqual(
      WEB_TOOL_DEFS[i].parameters,
      spec.tools[i].parameters,
      `schema drift: ${spec.tools[i].name}`,
    );
  }
});

test("every tool has a usable schema", () => {
  for (const t of getToolsSpec().tools) {
    const params = t.parameters as Record<string, unknown>;
    assert.strictEqual(params["type"], "object", t.name);
    assert.ok(Array.isArray(params["required"] ?? []), t.name);
    assert.ok(
      typeof t.description === "string" && t.description.length > 10,
      t.name,
    );
  }
});

test("descriptions survive first-sentence rendering", () => {
  for (const t of getToolsSpec().tools) {
    const first = firstSentence(t.description);
    assert.ok(
      !/\((bijv|bv|e\.g)\.?$/i.test(first),
      `${t.name} truncates mid-abbreviation: ${first.slice(-40)}`,
    );
    assert.ok(first.length > 10, t.name);
  }
});

// ─── Prompt template ───────────────────────────────────────────────────────

test("template parses into seven ordered sections", () => {
  const sections = getPromptSections();
  for (const name of [
    "head",
    "notes",
    "context",
    "tools",
    "no_tools",
    "tail_tools",
    "tail_shared",
  ] as const) {
    assert.ok(sections[name].length > 0, `section ${name} missing`);
  }
  const idx = (marker: string): number =>
    PROMPT_MD.indexOf(`<!-- SECTION:${marker} -->`);
  const order = SECTION_NAMES.map(idx);
  assert.deepStrictEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.ok(order.every((i) => i >= 0));
});

test("each placeholder occurs exactly once", () => {
  for (const ph of ["{{NOW}}", "{{NOTES}}", "{{CONTEXT}}", "{{TOOL_LIST}}"]) {
    const count = PROMPT_MD.split(ph).length - 1;
    assert.strictEqual(count, 1, `${ph} occurs ${count}x`);
  }
});

test("tools mode renders every section in order, no leftovers", () => {
  const sections = getPromptSections();
  const list = renderToolList(getToolsSpec().tools);
  assert.strictEqual(list.split("\n").length, 40);
  const out = renderPrompt(sections, {
    now: "NU: vrijdag 2 oktober 2026, 14:35 (Europe/Amsterdam, week 40, 2026-10-02)",
    notes: '<notities bewerkt_door="gebruiker" revisie="1">\nx\n</notities>',
    context: "Huidige pagina: Agenda",
    toolList: list,
  });
  for (const needle of [
    "NU: vrijdag 2 oktober 2026",
    "Je bent Friday AI",
    "<notities",
    "Huidige context van de app:",
    "Huidige pagina: Agenda",
    "- get_calendar_events:",
    "- undo_last_ai_plan_change:",
    "Standaard venster:",
    "BELANGRIJK — AI Schedule",
    "Veiligheid:",
    "Vraag of doe:",
    "no hallucineren",
  ]) {
    assert.ok(out.includes(needle), `missing: ${needle}`);
  }
  assert.ok(!out.includes("{{"));
  assert.ok(!out.includes("SECTION:"));
  assert.ok(!out.includes("Geen directe toegang"));
  const positions = [
    "Je bent Friday AI",
    "<notities",
    "Huidige context van de app:",
    "Je hebt toegang tot de volgende tools",
    "Standaard venster:",
    "BELANGRIJK — AI Schedule",
    "Veiligheid:",
    "Vraag of doe:",
  ].map((s) => out.indexOf(s));
  assert.deepStrictEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
});

test("no-tools mode keeps notes, drops tools-only sections", () => {
  const sections = getPromptSections();
  const out = renderPrompt(sections, {
    now: "NU: ...",
    notes: "<notities/>",
    context: null,
    toolList: null,
  });
  assert.ok(out.includes("geen directe toegang"));
  assert.ok(out.includes("<notities/>"));
  assert.ok(out.includes("Veiligheid:"));
  assert.ok(!out.includes("{{"));
  assert.ok(!out.includes("Je hebt toegang tot de volgende tools"));
  assert.ok(!out.includes("Standaard venster:"));
  assert.ok(!out.includes("BELANGRIJK — AI Schedule"));
});

test("empty notes/context sections are skipped, never blank", () => {
  const sections = getPromptSections();
  const out = renderPrompt(sections, {
    now: "NU: ...",
    notes: null,
    context: null,
    toolList: "x",
  });
  assert.ok(!out.includes("<notities"));
  assert.ok(!out.includes("Huidige context van de app:"));
  assert.ok(!/\n{3,}/.test(out), "no triple blank lines");
});

test("parse is total: garbage yields empty sections, never throws", () => {
  const sections = parsePromptSections("geen markers hier");
  assert.deepStrictEqual(
    Object.values(sections).every((s) => s === ""),
    true,
  );
});
