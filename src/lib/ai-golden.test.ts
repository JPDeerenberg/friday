/**
 * Golden conversations (Phase 10 of fixes/friday-ai-upgrade-plan.md):
 * scripted end-to-end turns through the web tool loop with fake Magister
 * data. Each test drives `runToolLoop` the way `ai.ts` does — scripted
 * provider responses, fake tool results — and asserts the turn outcome.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai-golden.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import {
  runToolLoop,
  type LoopChatResponse,
  type LoopDeps,
} from "./ai-loop.ts";
import { traceBlock } from "./ai-chats.ts";

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

/** Scripted provider: returns the queued responses in order. */
function scripted(responses: LoopChatResponse[]) {
  let i = 0;
  return async (): Promise<LoopChatResponse> => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return structuredClone(r);
  };
}

const CALENDAR_PAGE = {
  items: [
    {
      id: 1,
      date: "2026-10-05",
      start: "08:30",
      end: "09:20",
      vak: "wiskunde",
      lokaal: "B12",
      omschrijving: "Hoofdstuk 4",
      huiswerk: true,
      type: "les",
      afgerond: false,
    },
  ],
  meta: { requested: {}, returned: 1, total: 1, truncated: false },
};

// ─── "wat heb ik morgen?" ───────────────────────────────────────────────────

test("golden: agenda question fetches once, follow-up reuses the trace", async () => {
  const calls: string[] = [];
  const seenByProvider: Array<{ role: string; tool_calls?: unknown }> = [];
  const scriptedResponses: LoopChatResponse[] = [
    {
      content: "",
      toolCalls: [
        {
          id: "c1",
          name: "get_calendar_events",
          arguments: { start: "2026-10-05", end: "2026-10-05" },
        },
      ],
    },
    { content: "Morgen heb je wiskunde om 08:30.", toolCalls: [] },
  ];
  let step = 0;
  const first = await runToolLoop(
    baseDeps({
      initialMessages: [{ role: "user", content: "wat heb ik morgen?" }],
      chat: async (msgs) => {
        seenByProvider.push(
          ...msgs.map((m) => ({ role: m.role, tool_calls: m.tool_calls })),
        );
        const r =
          scriptedResponses[Math.min(step, scriptedResponses.length - 1)];
        step += 1;
        return structuredClone(r);
      },
      executeTool: async (name) => {
        calls.push(name);
        return { ok: true, data: CALENDAR_PAGE };
      },
    }),
  );
  assert.strictEqual(first.content, "Morgen heb je wiskunde om 08:30.");
  assert.deepStrictEqual(calls, ["get_calendar_events"]);
  assert.strictEqual(first.trace.length, 1);
  assert.strictEqual(first.trace[0].calls[0].name, "get_calendar_events");
  assert.strictEqual(first.trace[0].calls[0].ok, true);
  // Regression (live Mistral 400): the assistant turn replayed to the
  // provider must carry its tool calls WITH the parsed arguments.
  const replayed = seenByProvider.filter((m) => m.role === "assistant").at(-1);
  assert.deepStrictEqual(replayed?.tool_calls, [
    {
      id: "c1",
      name: "get_calendar_events",
      args: { start: "2026-10-05", end: "2026-10-05" },
    },
  ]);

  // Follow-up "en de dag erna?" replays the compact trace — no refetch.
  const secondCalls: string[] = [];
  const second = await runToolLoop(
    baseDeps({
      initialMessages: [
        { role: "user", content: "wat heb ik morgen?" },
        {
          role: "assistant",
          content: first.content + traceBlock(first.trace),
        },
        { role: "user", content: "en de dag erna?" },
      ],
      chat: scripted([{ content: "Dinsdag ben je vrij.", toolCalls: [] }]),
      executeTool: async (name) => {
        secondCalls.push(name);
        return { ok: true, data: {} };
      },
    }),
  );
  assert.strictEqual(second.content, "Dinsdag ben je vrij.");
  assert.deepStrictEqual(secondCalls, []);
});

// ─── "onthoud dat ik dinsdag basketbal heb" ─────────────────────────────────

test("golden: memory request writes a note via append_note", async () => {
  const writes: Array<{ name: string; args: Record<string, unknown> }> = [];
  const out = await runToolLoop(
    baseDeps({
      initialMessages: [
        { role: "user", content: "onthoud dat ik dinsdag basketbal heb" },
      ],
      chat: scripted([
        {
          content: "",
          toolCalls: [
            {
              id: "n1",
              name: "append_note",
              arguments: {
                section: "Lopende dingen",
                text: "dinsdag basketbaltraining",
              },
            },
          ],
        },
        { content: "Onthouden: dinsdag basketbaltraining.", toolCalls: [] },
      ]),
      executeTool: async (name, args) => {
        writes.push({ name, args });
        return { ok: true, data: { ok: true, revision: 3 } };
      },
      isWriteTool: (name) => name === "append_note",
    }),
  );
  assert.strictEqual(out.content, "Onthouden: dinsdag basketbaltraining.");
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].name, "append_note");
  assert.strictEqual(
    (writes[0].args as Record<string, unknown>)["text"],
    "dinsdag basketbaltraining",
  );
});

// ─── "lees de bijlage van mijn opdracht" ────────────────────────────────────

test("golden: attachment flow lists files, then reads in pages", async () => {
  const calls: string[] = [];
  const out = await runToolLoop(
    baseDeps({
      initialMessages: [
        { role: "user", content: "lees de bijlage van mijn opdracht" },
      ],
      chat: scripted([
        {
          content: "",
          toolCalls: [{ id: "f1", name: "list_files", arguments: {} }],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "f2",
              name: "read_attachment_text",
              arguments: { file_id: "a1", offset: 0 },
            },
          ],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "f3",
              name: "read_attachment_text",
              arguments: { file_id: "a1", offset: 8000 },
            },
          ],
        },
        { content: "De bijlage gaat over hoofdstuk 4.", toolCalls: [] },
      ]),
      executeTool: async (name, args) => {
        calls.push(name);
        if (name === "list_files") {
          return {
            ok: true,
            data: {
              files: [
                {
                  file_id: "a1",
                  name: "werkstuk.pdf",
                  extension: "pdf",
                  source: "assignment",
                  readable: true,
                },
              ],
            },
          };
        }
        const offset = (args as Record<string, unknown>)["offset"] as number;
        return {
          ok: true,
          data: {
            name: "werkstuk.pdf",
            total_chars: 16000,
            offset,
            next_offset: offset === 0 ? 8000 : null,
            text: "pagina-inhoud…",
          },
        };
      },
    }),
  );
  assert.strictEqual(out.content, "De bijlage gaat over hoofdstuk 4.");
  assert.deepStrictEqual(calls, [
    "list_files",
    "read_attachment_text",
    "read_attachment_text",
  ]);
});

// ─── a tool failing mid-turn does not poison the turn ───────────────────────

test("golden: failed plan tool still ends with a closing answer", async () => {
  const out = await runToolLoop(
    baseDeps({
      initialMessages: [
        { role: "user", content: "plan wiskunde huiswerk morgen om 16:00" },
      ],
      chat: scripted([
        {
          content: "",
          toolCalls: [
            {
              id: "p1",
              name: "create_ai_schedule_item",
              arguments: { title: "wiskunde" },
            },
          ],
        },
        {
          content: "Plannen is niet gelukt, probeer het later opnieuw.",
          toolCalls: [],
        },
      ]),
      executeTool: async () => {
        throw new Error("store unavailable");
      },
      isWriteTool: (name) => name === "create_ai_schedule_item",
    }),
  );
  assert.strictEqual(
    out.content,
    "Plannen is niet gelukt, probeer het later opnieuw.",
  );
  assert.strictEqual(out.stopped, false);
  assert.strictEqual(out.trace[0].calls[0].ok, false);
});
