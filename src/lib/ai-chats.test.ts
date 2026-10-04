/**
 * Unit tests for chat persistence + context management (src/lib/ai-chats.ts).
 *
 * Phase 5 of fixes/friday-ai-upgrade-plan.md.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai-chats.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";
import "fake-indexeddb/auto";

import {
  HISTORY_BUDGET_TOKENS,
  appendMessage,
  clearAllConversations,
  createConversation,
  deleteConversation,
  fitHistoryForRequest,
  getMessages,
  isChatStoragePersistent,
  listConversations,
  pruneExpiredConversations,
  renameConversation,
  setConversationSummary,
  summarizeDropped,
  summarySystemMessage,
  traceBlock,
  type ThreadMessage,
} from "./ai-chats.ts";
import { __simulateStoreFailure } from "./web-ai-chats-store.ts";

async function reset(): Promise<void> {
  await clearAllConversations();
}

function thread(n: number, sizeEach = 100): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}-` + "x".repeat(sizeEach),
    });
  }
  return out;
}

// ─── Persistence round-trip ────────────────────────────────────────────────

test("conversation round-trip with auto-title", async () => {
  await reset();
  const conv = await createConversation();
  assert.strictEqual(conv.title, "Nieuwe chat");
  await appendMessage(conv.id, {
    role: "user",
    text: "Wat heb ik morgen aan huiswerk voor wiskunde?",
  });
  await appendMessage(conv.id, {
    role: "assistant",
    text: "Veel succes!",
  });
  const list = await listConversations();
  assert.strictEqual(list.length, 1);
  assert.match(list[0].title, /^Wat heb ik morgen/);
  const msgs = await getMessages(conv.id);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, "user");
  assert.strictEqual(msgs[1].text, "Veel succes!");
});

test("rename, delete one, clear all", async () => {
  await reset();
  const a = await createConversation("A");
  const b = await createConversation("B");
  await renameConversation(a.id, "A2");
  assert.strictEqual(
    (await listConversations()).find((c) => c.id === a.id)?.title,
    "A2",
  );
  await renameConversation(a.id, "   ");
  assert.strictEqual(
    (await listConversations()).find((c) => c.id === a.id)?.title,
    "Nieuwe chat",
  );
  await deleteConversation(a.id);
  assert.deepStrictEqual(
    (await listConversations()).map((c) => c.id),
    [b.id],
  );
  // Messages die with the conversation.
  await appendMessage(b.id, { role: "user", text: "hi" });
  await deleteConversation(b.id);
  assert.deepStrictEqual(await getMessages(b.id), []);
  await createConversation("C");
  await clearAllConversations();
  assert.deepStrictEqual(await listConversations(), []);
});

test("tool trace persists alongside the turn", async () => {
  await reset();
  const conv = await createConversation();
  await appendMessage(conv.id, {
    role: "assistant",
    text: "Je hebt morgen 3 lessen.",
    trace: [
      {
        text: "",
        calls: [
          {
            name: "get_calendar_events",
            args: { start: "2026-09-22", end: "2026-09-22" },
            ok: true,
            text: JSON.stringify({ items: [1, 2, 3] }),
          },
        ],
      },
    ],
  });
  const msgs = await getMessages(conv.id);
  assert.strictEqual(msgs[0].trace?.length, 1);
  assert.strictEqual(msgs[0].trace?.[0].calls[0].name, "get_calendar_events");
});

// ─── Retention pruning ─────────────────────────────────────────────────────

test("pruneExpiredConversations respects the window", async () => {
  await reset();
  await createConversation("fresh");
  await createConversation("old");
  assert.strictEqual(await pruneExpiredConversations(null), 0);
  assert.strictEqual((await listConversations()).length, 2);
  assert.strictEqual(await pruneExpiredConversations(36500), 0);
  assert.strictEqual((await listConversations()).length, 2);
});

// ─── Budget trimming (item 5) ──────────────────────────────────────────────

test("fit keeps the latest message even when huge", () => {
  const t = thread(4, 10);
  const big: ThreadMessage = {
    role: "user",
    content: "Q-" + "y".repeat(100000),
  };
  const out = fitHistoryForRequest([...t, big], 10);
  assert.strictEqual(out.messages.length, 1);
  assert.strictEqual(out.messages[0], big);
  assert.strictEqual(out.dropped.length, 4);
});

test("fit keeps system-plus-latest under budget, drops the front", () => {
  // 6 x ~210 chars = ~1260 chars; budget 100 tokens = 350 chars → last ~1-2 kept.
  const t = thread(6, 200);
  const out = fitHistoryForRequest(t, 100);
  assert.ok(out.messages.length >= 1);
  assert.strictEqual(out.messages[out.messages.length - 1], t[t.length - 1]);
  assert.ok(out.dropped.length > 0);
  // Everything fits in a huge budget.
  const all = fitHistoryForRequest(t, HISTORY_BUDGET_TOKENS);
  assert.strictEqual(all.messages.length, 6);
  assert.strictEqual(all.dropped.length, 0);
});

test("trace replay block carries previews, never raw dumps", () => {
  const block = traceBlock([
    {
      text: "",
      calls: [
        {
          name: "get_grades",
          args: { top: 5 },
          ok: true,
          text: "x".repeat(800),
        },
      ],
    },
  ]);
  assert.match(block, /get_grades/);
  assert.ok(block.length < 800);
  assert.match(block, /niet opnieuw op/);
  assert.strictEqual(traceBlock([]), "");
  assert.strictEqual(traceBlock(undefined), "");
});

// ─── Summary fallback (item 5) ─────────────────────────────────────────────

test("summarizeDropped returns null on failure or emptiness", async () => {
  assert.strictEqual(await summarizeDropped([], async () => "s"), null);
  assert.strictEqual(
    await summarizeDropped(thread(2), async () => {
      throw new Error("provider down");
    }),
    null,
  );
  assert.strictEqual(
    await summarizeDropped(thread(2), async () => "   "),
    null,
  );
  assert.strictEqual(
    await summarizeDropped(thread(2), async () => "Korte samenvatting."),
    "Korte samenvatting.",
  );
});

test("summary system message shape", () => {
  const m = summarySystemMessage("Feiten: toetsweek.");
  assert.strictEqual(m.role, "system");
  assert.match(m.content, /Samenvatting van het eerdere gesprek/);
});

// ─── Quota fallback (item 2) ───────────────────────────────────────────────

test("write failure falls back to memory, reads follow", async () => {
  await reset();
  assert.strictEqual(isChatStoragePersistent(), true);
  __simulateStoreFailure();
  const conv = await createConversation();
  assert.strictEqual(isChatStoragePersistent(), false);
  await appendMessage(conv.id, { role: "user", text: "onthoud dit" });
  const list = await listConversations();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, "onthoud dit".slice(0, 40));
  const msgs = await getMessages(conv.id);
  assert.strictEqual(msgs.length, 1);
  // Logout-equivalent reset restores persistent mode.
  await clearAllConversations();
  assert.strictEqual(isChatStoragePersistent(), true);
  assert.deepStrictEqual(await listConversations(), []);
});

test("summary round-trips on the conversation", async () => {
  await reset();
  const conv = await createConversation();
  await setConversationSummary(conv.id, "Samenvatting.", 4);
  const list = await listConversations();
  assert.strictEqual(list[0].summary, "Samenvatting.");
  assert.strictEqual(list[0].summary_through, 4);
});
