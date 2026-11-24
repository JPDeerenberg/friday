import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { entriesEqual, mergeEntries } from "./sync-merge.ts";
import type { SyncEntry } from "./sync-types.ts";

function entry(patch: Partial<SyncEntry> = {}): SyncEntry {
  return {
    key: "settings.startPage",
    category: "settings",
    rev: 1,
    updatedAt: 1000,
    device: "aaaa",
    value: "dashboard",
    ...patch,
  };
}

describe("sync merge", () => {
  it("keeps the local value when it has the newer revision", () => {
    const local = entry({ rev: 3, value: "agenda" });
    const remote = entry({ rev: 2, value: "cijfers" });
    const out = mergeEntries([local], [remote]);
    assert.equal(out.merged.length, 1);
    assert.equal(out.merged[0].value, "agenda");
    assert.equal(out.fromRemote.length, 0);
  });

  it("takes a newer remote value and counts it as a conflict", () => {
    const local = entry({ rev: 2 });
    const remote = entry({ rev: 3, value: "cijfers" });
    const out = mergeEntries([local], [remote]);
    assert.equal(out.merged[0].value, "cijfers");
    assert.deepEqual(out.fromRemote, [remote]);
    assert.equal(out.conflicts, 1);
  });

  it("uses updatedAt and then device id as tie-breakers", () => {
    const local = entry({ rev: 2, updatedAt: 2000, device: "aaaa" });
    const newer = entry({ rev: 2, updatedAt: 3000, device: "bbbb" });
    assert.equal(mergeEntries([local], [newer]).merged[0].device, "bbbb");

    const laterDevice = entry({ rev: 2, updatedAt: 2000, device: "cccc" });
    assert.equal(mergeEntries([local], [laterDevice]).merged[0].device, "cccc");
  });

  it("accepts a remote-only tombstone", () => {
    const local = entry();
    const tombstone = entry({ rev: 2, deleted: true, value: undefined });
    const out = mergeEntries([local], [tombstone]);
    assert.equal(out.merged[0].deleted, true);
    assert.equal(out.merged[0].value, undefined);
  });
});

describe("sync document comparison", () => {
  it("ignores the device stamp on otherwise identical entries", () => {
    assert.equal(
      entriesEqual([entry({ device: "local" })], [entry({ device: "remote" })]),
      true,
    );
  });

  it("notices changed values, revisions and tombstones", () => {
    assert.equal(entriesEqual([entry()], [entry({ value: "cijfers" })]), false);
    assert.equal(entriesEqual([entry()], [entry({ rev: 2 })]), false);
    assert.equal(entriesEqual([entry()], [entry({ deleted: true })]), false);
    assert.equal(entriesEqual([entry()], []), false);
  });
});
