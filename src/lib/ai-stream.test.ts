/**
 * Unit tests for SSE streaming transport + liveness (Phase 6b).
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai-stream.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";

import { WebBackend, extractSseEvents } from "./backend.ts";
import { activityForTool } from "./ai-loop.ts";

test("extractSseEvents splits frames, keeps remainder", () => {
  const { events, rest } = extractSseEvents(
    'event: text\ndata: {"delta":"hoi"}\n\nevent: done\ndata: {"content":"hoi"}\n\n',
  );
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].event, "text");
  assert.deepStrictEqual(events[0].data, { delta: "hoi" });
  assert.strictEqual(events[1].event, "done");
  assert.strictEqual(rest, "");
});

test("extractSseEvents tolerates split chunks, comments and \\r\\n", () => {
  const part1 = 'event: text\r\ndata: {"delta":"a';
  const r1 = extractSseEvents(part1);
  assert.strictEqual(r1.events.length, 0);
  const r2 = extractSseEvents(`${r1.rest}b"}\r\n\r\n: ping\r\n\r\n`);
  assert.strictEqual(r2.events.length, 1);
  assert.deepStrictEqual(r2.events[0].data, { delta: "ab" });
  assert.strictEqual(r2.rest, "");
});

test("extractSseEvents keeps non-JSON payloads raw", () => {
  const { events } = extractSseEvents("data: [DONE]\n\n");
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].event, "message");
  assert.strictEqual(events[0].data, "[DONE]");
});

test("aiProxyStreamChat assembles deltas then done", async () => {
  const chunks = [
    'event: text\ndata: {"delta":"Hal"}\n\n',
    'event: text\ndata: {"delta":"lo"}\n\nevent: done\ndata: {"content":"Hallo","toolCalls":[]}\n\n',
  ];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
  try {
    const be = new WebBackend("https://example.test");
    const deltas: string[] = [];
    const out = await be.aiProxyStreamChat(
      { x: 1 },
      { onText: (d) => deltas.push(d) },
    );
    assert.deepStrictEqual(deltas, ["Hal", "lo"]);
    assert.strictEqual(out.content, "Hallo");
    assert.deepStrictEqual(out.toolCalls, []);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("aiProxyStreamChat falls back to JSON bodies", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ content: "vol", toolCalls: [] }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  try {
    const be = new WebBackend("https://example.test");
    const deltas: string[] = [];
    const out = await be.aiProxyStreamChat(
      { x: 1 },
      { onText: (d) => deltas.push(d) },
    );
    assert.strictEqual(out.content, "vol");
    assert.deepStrictEqual(deltas, ["vol"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("aiProxyStreamChat surfaces error events", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('event: error\ndata: {"message":"kapot"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  try {
    const be = new WebBackend("https://example.test");
    await assert.rejects(
      be.aiProxyStreamChat({ x: 1 }, { onText: () => {} }),
      /kapot/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("activityForTool maps tools to Dutch liveness lines", () => {
  assert.strictEqual(
    activityForTool("get_calendar_events"),
    "Rooster ophalen…",
  );
  assert.strictEqual(activityForTool("get_grades"), "Cijfers ophalen…");
  assert.strictEqual(activityForTool("append_note"), "Notitie opslaan…");
  assert.strictEqual(activityForTool("read_attachment_text"), "Bijlage lezen…");
  assert.strictEqual(activityForTool("send_message"), "Actie voorbereiden…");
  assert.strictEqual(activityForTool("something_new"), "Gegevens ophalen…");
});
