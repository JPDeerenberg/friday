/**
 * Regression tests for the V4 cache fix
 * (fixes/FRIDAY_AUTH_LOGOUT_DIAGNOSIS_V4.md):
 *
 * Before: a failed background refresh left the entry expired forever, so
 * every subsequent read re-fired the fetcher (zero backoff), and N
 * concurrent reads of one stale key each fired their own refresh.
 * After: failures re-stamp with a 60s backoff, and in-flight refreshes are
 * de-duplicated per key.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/cache.test.ts
 * or: pnpm test
 */
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert";

import { cacheClear, cacheGet } from "./cache.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for background refresh");
    }
    await sleep(5);
  }
}

test("failed background refresh backs off instead of refiring on every read", async () => {
  const key = `v4-backoff-${Date.now()}`;
  await cacheClear(key);

  // Seed the entry (short TTL so it expires quickly).
  let fetches = 0;
  const seed = await cacheGet(key, async () => {
    fetches++;
    return { n: 1 };
  }, 1);
  assert.deepStrictEqual(seed, { n: 1 });
  assert.strictEqual(fetches, 1);
  await sleep(10); // let the 1ms TTL lapse

  // Read the stale entry while the endpoint keeps failing.
  const failing = async () => {
    fetches++;
    throw new Error("429 rate limited");
  };
  const stale = await cacheGet(key, failing, 5 * 60 * 1000);
  assert.deepStrictEqual(stale, { n: 1 }, "stale data must still be served");
  await waitFor(() => fetches === 2); // background retry happened...
  await sleep(20); // ...and fully settled (re-stamp written)

  // Next read must NOT retry yet — the failure backed off.
  const again = await cacheGet(key, failing, 5 * 60 * 1000);
  assert.deepStrictEqual(again, { n: 1 });
  await sleep(20);
  assert.strictEqual(
    fetches,
    2,
    `expected backoff (2 total fetches), got ${fetches} — entry stayed permanently expired`
  );
  await cacheClear(key);
});

test("concurrent reads of one stale key share a single background refresh", async () => {
  const key = `v4-dedup-${Date.now()}`;
  await cacheClear(key);

  let fetches = 0;
  await cacheGet(key, async () => {
    fetches++;
    return { n: 1 };
  }, 1);
  await sleep(10); // expire it

  // Slow fetcher so all 5 reads overlap while it is in flight.
  const slow = async () => {
    fetches++;
    await sleep(50);
    return { n: 2 };
  };
  const results = await Promise.all([
    cacheGet(key, slow, 5 * 60 * 1000),
    cacheGet(key, slow, 5 * 60 * 1000),
    cacheGet(key, slow, 5 * 60 * 1000),
    cacheGet(key, slow, 5 * 60 * 1000),
    cacheGet(key, slow, 5 * 60 * 1000),
  ]);
  for (const r of results) {
    assert.deepStrictEqual(r, { n: 1 }, "concurrent reads serve the stale entry");
  }
  assert.strictEqual(
    fetches,
    2,
    `expected 1 shared refresh (2 total fetches), got ${fetches}`
  );
  await cacheClear(key);
});
