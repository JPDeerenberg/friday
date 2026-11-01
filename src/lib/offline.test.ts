/**
 * Offline-opslag: live resultaat wordt bewaard, bij een fout komt de bewaarde
 * kopie terug, agenda-items worden per bereik vervangen, uitzetten wist.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/offline.test.ts
 */
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert";
import { get } from "svelte/store";

import {
  clearOffline,
  loadDownloadedPath,
  loadFile,
  loadIdentity,
  loadRange,
  MAX_OFFLINE_FILE_BYTES,
  offlineStatus,
  pruneItemsBefore,
  saveDownloadedPath,
  saveFile,
  saveIdentity,
  setOfflineEnabled,
  withOffline,
  withOfflineRange,
} from "./offline.ts";

type Ev = { Id: number; Start: string; t: string };
const ev = (Id: number, d: string, t = "x"): Ev => ({
  Id,
  Start: `${d}T08:00:00Z`,
  t,
});
const boom = () => Promise.reject(new Error("Magister is down"));

test("live result is saved and returned; failure falls back to the copy", async () => {
  setOfflineEnabled(true);
  await clearOffline();
  assert.deepStrictEqual(await withOffline("k1", async () => ({ n: 1 })), {
    n: 1,
  });
  assert.strictEqual(get(offlineStatus).stale, false);

  const out = await withOffline("k1", boom as () => Promise<{ n: number }>);
  assert.deepStrictEqual(out, { n: 1 });
  assert.strictEqual(get(offlineStatus).stale, true);

  // a later live success clears the offline banner again
  await withOffline("k1", async () => ({ n: 2 }));
  assert.strictEqual(get(offlineStatus).stale, false);
});

test("without a saved copy the original error is thrown", async () => {
  setOfflineEnabled(true);
  await clearOffline();
  await assert.rejects(() => withOffline("nothing", boom), /Magister is down/);
});

test("merge keeps earlier entries (bulk grade info)", async () => {
  setOfflineEnabled(true);
  await clearOffline();
  const merge = (a: Record<number, number>, b: Record<number, number>) => ({
    ...a,
    ...b,
  });
  await withOffline("bulk", async () => ({ 1: 10 }), { merge });
  await withOffline("bulk", async () => ({ 2: 20 }), { merge });
  const out = await withOffline(
    "bulk",
    boom as () => Promise<Record<number, number>>,
  );
  assert.deepStrictEqual(out, { 1: 10, 2: 20 });
});

test("skipStore (searches) is never saved", async () => {
  setOfflineEnabled(true);
  await clearOffline();
  await withOffline("search", async () => [1], { skipStore: true });
  await assert.rejects(() => withOffline("search", boom));
});

test("range: live replaces only its own window, failure serves saved items", async () => {
  setOfflineEnabled(true);
  await clearOffline();
  const args = (start: string, end: string, fetcher: () => Promise<Ev[]>) => ({
    kind: "calendar",
    pid: 7,
    start,
    end,
    fetcher,
    idOf: (e: Ev) => e.Id,
    dateOf: (e: Ev) => e.Start,
  });
  await withOfflineRange(
    args("2026-11-01", "2026-11-14", async () => [
      ev(1, "2026-11-02"),
      ev(2, "2026-11-10"),
    ]),
  );
  await withOfflineRange(
    args("2026-11-15", "2026-11-28", async () => [ev(3, "2026-11-16")]),
  );
  // Week 1 is fetched again: event 2 was cancelled/removed in Magister.
  await withOfflineRange(
    args("2026-11-01", "2026-11-14", async () => [
      ev(1, "2026-11-02", "changed"),
    ]),
  );

  const offline = await withOfflineRange(
    args("2026-11-01", "2026-11-30", boom),
  );
  assert.deepStrictEqual(offline.map((e) => e.Id).sort(), [1, 3]);
  assert.strictEqual(offline.find((e) => e.Id === 1)!.t, "changed");

  // another person never sees these
  assert.strictEqual(
    await loadRange("calendar", 8, "2026-01-01", "2027-01-01"),
    null,
  );

  await pruneItemsBefore("calendar", 7, "2026-11-10");
  const left = await loadRange<Ev>("calendar", 7, "2026-01-01", "2027-01-01");
  assert.deepStrictEqual(
    left!.items.map((e) => e.Id),
    [3],
  );
});

test("disabling storage stops saving and clearOffline wipes it", async () => {
  setOfflineEnabled(true);
  await clearOffline();
  await withOffline("a", async () => 1);
  setOfflineEnabled(false);
  await withOffline("b", async () => 2); // passthrough, not saved
  await assert.rejects(() => withOffline("b", boom)); // disabled: plain error
  setOfflineEnabled(true);
  await assert.rejects(() => withOffline("b", boom)); // never saved
  assert.strictEqual(await withOffline("a", boom as () => Promise<number>), 1);
  await clearOffline();
  await assert.rejects(() => withOffline("a", boom));
});

test("files over 5 MB are not saved, small ones are", async () => {
  setOfflineEnabled(true);
  await clearOffline();
  const small = new Blob(["hello"]);
  assert.strictEqual(await saveFile("u1", small, "a.txt"), true);
  assert.strictEqual((await loadFile("u1"))!.name, "a.txt");
  const big = new Blob([new Uint8Array(MAX_OFFLINE_FILE_BYTES + 1)]);
  assert.strictEqual(await saveFile("u2", big, "big.bin"), false);
  assert.strictEqual(await loadFile("u2"), null);
});

test("identity and downloaded path survive for offline cold starts", async () => {
  setOfflineEnabled(true);
  await clearOffline();
  await saveIdentity({ personId: 42, account: { naam: "x" }, picture: null });
  assert.strictEqual((await loadIdentity())!.personId, 42);
  await saveDownloadedPath("url", "/data/file.pdf");
  assert.strictEqual(await loadDownloadedPath("url"), "/data/file.pdf");
  setOfflineEnabled(false);
  assert.strictEqual(await loadIdentity(), null);
  setOfflineEnabled(true);
});
