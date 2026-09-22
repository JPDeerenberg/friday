/**
 * IndexedDB round-trip tests (fake-indexeddb). These catch API-misuse bugs
 * like put()-with-explicit-key on a keyPath store (DataError), which broke
 * the Friday's Plan page before any data was ever written.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/web-stores.test.ts
 * or: pnpm test
 */
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert";

import {
  loadScheduleItems,
  saveScheduleItems,
  validateScheduleItem,
} from "./web-ai-schedule-store.ts";
import {
  clearWebSession,
  loadWebSession,
  saveWebSession,
} from "./web-session.ts";
import {
  clearWebAiConfig,
  loadWebAiConfig,
  saveWebAiConfig,
} from "./web-ai-store.ts";
import { cacheClear, cacheGet } from "./cache.ts";
import type { AiScheduleItem } from "./ai-schedule-types.ts";

function item(over: Partial<AiScheduleItem> = {}): AiScheduleItem {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    title: "Test",
    description: null,
    item_type: "assignment_work",
    start: "2026-09-08T09:00:00",
    end: "2026-09-08T10:00:00",
    status: "planned",
    urgency: 3,
    related_assignment_id: null,
    related_calendar_event_id: null,
    related_subject: null,
    estimated_minutes: null,
    duration_source: null,
    source: "user",
    created_at: "2026-09-08T00:00:00",
    updated_at: "2026-09-08T00:00:00",
    completed_at: null,
    ...over,
  };
}

test("schedule store round-trips items (regression: DataError on save)", async () => {
  const a = item();
  const b = item();
  await saveScheduleItems([a, b]);
  const loaded = await loadScheduleItems();
  assert.strictEqual(loaded.length, 2);
  assert.deepStrictEqual(
    loaded.map((i) => i.id).sort(),
    [a.id, b.id].sort(),
  );
  await saveScheduleItems([a]);
  assert.strictEqual((await loadScheduleItems()).length, 1);
  await saveScheduleItems([]);
  assert.deepStrictEqual(await loadScheduleItems(), []);
});

test("schedule validation still guards bad items", () => {
  assert.throws(() => validateScheduleItem(item({ title: " " })), /Titel/);
});

test("session store round-trips tokens", async () => {
  const tokens = {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    apiEndpoint: "https://x.magister.net",
    personId: 7,
  };
  await saveWebSession(tokens as never);
  assert.deepStrictEqual(await loadWebSession(), tokens);
  await clearWebSession();
  assert.strictEqual(await loadWebSession(), null);
});

test("ai store keeps key on empty update", async () => {
  await clearWebAiConfig();
  await saveWebAiConfig({ apiKey: "secret-1", model: "m", enabled: true } as never);
  let cfg = await loadWebAiConfig();
  assert.strictEqual(cfg.apiKey, "secret-1");
  await saveWebAiConfig({ apiKey: "" });
  cfg = await loadWebAiConfig();
  assert.strictEqual(cfg.apiKey, "secret-1");
  await saveWebAiConfig({ apiKey: "secret-2" });
  assert.strictEqual((await loadWebAiConfig()).apiKey, "secret-2");
  await clearWebAiConfig();
  assert.strictEqual((await loadWebAiConfig()).apiKey, "");
});

test("cache round-trips entries", async () => {
  await cacheClear("t-key");
  const v = await cacheGet("t-key", async () => ({ n: 1 }), 60000);
  assert.deepStrictEqual(v, { n: 1 });
  // Second call within TTL: fetcher must NOT run again.
  let ran = false;
  const v2 = await cacheGet(
    "t-key",
    async () => {
      ran = true;
      return { n: 2 };
    },
    60000,
  );
  assert.deepStrictEqual(v2, { n: 1 });
  assert.strictEqual(ran, false);
  await cacheClear("t-key");
});
