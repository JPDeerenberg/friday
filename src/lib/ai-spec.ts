/**
 * Shared AI spec: single source of truth for tools + system prompt.
 *
 * `shared/ai-spec/tools.json` holds every tool definition; `prompt.nl.md`
 * holds the Dutch system prompt as sections with `{{NOW}}`, `{{NOTES}}`,
 * `{{CONTEXT}}` and `{{TOOL_LIST}}` placeholders. Desktop consumes the same
 * files (`src-tauri/src/ai/spec.rs`); `ai-parity.test.ts` fails CI on drift.
 *
 * Section markers: `<!-- SECTION:NAME -->` with NAME in
 * HEAD, NOTES, CONTEXT, TOOLS, NO_TOOLS, TAIL_TOOLS, TAIL_SHARED.
 * Tools mode renders HEAD + NOTES + CONTEXT + TOOLS + TAIL_TOOLS +
 * TAIL_SHARED; no-tools mode renders HEAD + NOTES + CONTEXT + NO_TOOLS +
 * TAIL_SHARED. Empty NOTES/CONTEXT sections are skipped.
 */

import TOOLS_JSON from "../../shared/ai-spec/tools.json" with { type: "json" };
import PROMPT_MD from "../../shared/ai-spec/prompt.nl.md?raw";

export interface ToolSpecDef {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ToolsSpec {
  version: number;
  tools: ToolSpecDef[];
}

export interface PromptSections {
  head: string;
  notes: string;
  context: string;
  tools: string;
  no_tools: string;
  tail_tools: string;
  tail_shared: string;
}

export const SECTION_NAMES = [
  "HEAD",
  "NOTES",
  "CONTEXT",
  "TOOLS",
  "NO_TOOLS",
  "TAIL_TOOLS",
  "TAIL_SHARED",
] as const;

const MARKER_RE = /^<!-- SECTION:([A-Z_]+) -->$/;

/** Split the template into its named sections (pure: `md` injectable). */
export function parsePromptSections(md: string): PromptSections {
  const parts = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of md.split("\n")) {
    const line = rawLine.trim();
    const m = MARKER_RE.exec(line);
    if (m) {
      current = m[1];
      parts.set(current, []);
      continue;
    }
    if (current !== null) parts.get(current)?.push(rawLine);
  }
  const get = (name: string): string =>
    (parts.get(name) ?? []).join("\n").trim();
  return {
    head: get("HEAD"),
    notes: get("NOTES"),
    context: get("CONTEXT"),
    tools: get("TOOLS"),
    no_tools: get("NO_TOOLS"),
    tail_tools: get("TAIL_TOOLS"),
    tail_shared: get("TAIL_SHARED"),
  };
}

/** First sentence of a description (tool-list rendering, both platforms). */
export function firstSentence(description: string): string {
  return description.split(".")[0];
}

/**
 * `- name: first sentence` lines, given order. Callers pass their
 * settings-filtered defs so listed tools always match offered tools.
 */
export function renderToolList(
  tools: Array<{ name: string; description: string }>,
): string {
  return tools
    .map((t) => `- ${t.name}: ${firstSentence(t.description)}`)
    .join("\n");
}

export function getToolsSpec(): ToolsSpec {
  return TOOLS_JSON as ToolsSpec;
}

export function getPromptSections(): PromptSections {
  return parsePromptSections(PROMPT_MD);
}

export interface PromptInput {
  now: string;
  /** Formatted notes block, or null when disabled/unavailable. */
  notes: string | null;
  /** Page context text, or null when absent. */
  context: string | null;
  /** Rendered tool list, or null for the no-tools prompt. */
  toolList: string | null;
}

/** Assemble the system prompt from template + inputs (pure). */
export function renderPrompt(
  sections: PromptSections,
  input: PromptInput,
): string {
  const fill = (template: string): string =>
    template
      .replace("{{NOW}}", input.now)
      .replace("{{NOTES}}", input.notes ?? "")
      .replace("{{CONTEXT}}", input.context ?? "")
      .replace("{{TOOL_LIST}}", input.toolList ?? "");
  const parts: string[] = [fill(sections.head)];
  if (input.notes) parts.push(fill(sections.notes));
  if (input.context) parts.push(fill(sections.context));
  if (input.toolList !== null) {
    parts.push(fill(sections.tools));
    parts.push(sections.tail_tools);
  } else {
    parts.push(sections.no_tools);
  }
  parts.push(sections.tail_shared);
  return parts.filter((p) => p.trim().length > 0).join("\n\n");
}
