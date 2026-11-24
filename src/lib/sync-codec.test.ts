import test from "node:test";
import assert from "node:assert";

import {
  decodeSyncChunks,
  deriveSyncKey,
  encodeSyncDoc,
  parseSyncChunk,
  stableHash,
} from "./sync-codec.ts";
import type { SyncDoc } from "./sync-types.ts";

function noise(seed: number, length: number): string {
  let s = seed >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += String.fromCharCode(33 + (s % 90));
  }
  return out;
}

function doc(entries = 60): SyncDoc {
  return {
    version: 2,
    docId: "friday-123",
    schoolYear: "2026",
    device: "device-a",
    updatedAt: 123456789,
    entries: Array.from({ length: entries }, (_, i) => ({
      key: `settings.key${i}`,
      category: "settings" as const,
      rev: 1,
      updatedAt: 123456789,
      device: "device-a",
      value: { index: i, text: noise(i + 1, 600) },
    })),
  };
}

test("sync document survives chunking and deflate", async () => {
  const input = doc();
  const encoded = await encodeSyncDoc(input);
  assert.ok(encoded.length > 1, "large documents should be split");
  for (const chunk of encoded) {
    assert.ok(chunk.length <= 1300, `chunk too large: ${chunk.length}`);
  }
  const parsed = encoded.map(parseSyncChunk);
  assert.ok(parsed.every(Boolean));
  const decoded = await decodeSyncChunks(parsed.filter((c) => c !== null));
  assert.deepStrictEqual(decoded, input);
});

test("a smaller payload size splits further and still round-trips", async () => {
  const input = doc();
  const wide = await encodeSyncDoc(input, null, 1200);
  const narrow = await encodeSyncDoc(input, null, 400);
  const tiny = await encodeSyncDoc(input, null, 200);
  assert.ok(
    narrow.length > wide.length,
    `400-char chunks (${narrow.length}) should outnumber 1200-char chunks (${wide.length})`,
  );
  assert.ok(
    tiny.length > narrow.length,
    "200-char chunks should split further",
  );
  for (const chunk of narrow) {
    const data = chunk.split("|")[5];
    assert.ok(data.length <= 400, `payload too large: ${data.length}`);
  }
  const parsed = narrow
    .map(parseSyncChunk)
    .filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== null);
  assert.deepStrictEqual(await decodeSyncChunks(parsed), input);
});

test("sync chunks reject a corrupted payload", async () => {
  const encoded = await encodeSyncDoc(doc(2));
  const parsed = encoded.map(parseSyncChunk).filter((c) => c !== null);
  const broken = parsed.map((c, i) =>
    i === 0 ? { ...c, data: `${c.data.slice(0, -1)}A` } : c,
  );
  assert.strictEqual(await decodeSyncChunks(broken), null);
});

test("sync chunks reject an incomplete document", async () => {
  const encoded = await encodeSyncDoc(doc());
  const parsed = encoded.map(parseSyncChunk).filter((c) => c !== null);
  assert.strictEqual(await decodeSyncChunks(parsed.slice(0, -1)), null);
});

test("encrypted sync document round-trips with the password", async () => {
  const input = doc(4);
  const key = await deriveSyncKey("friday-test-password");
  const encoded = await encodeSyncDoc(input, key);
  assert.ok(encoded.every((chunk) => chunk.startsWith("FSY2E|")));
  const parsed = encoded.map(parseSyncChunk).filter((chunk) => chunk !== null);
  assert.ok(parsed.every((chunk) => chunk.encrypted === true));
  assert.strictEqual(await decodeSyncChunks(parsed, null), null);
  const wrong = await deriveSyncKey("wrong-password");
  assert.strictEqual(await decodeSyncChunks(parsed, wrong), null);
  assert.deepStrictEqual(await decodeSyncChunks(parsed, key), input);
});

test("stableHash notices nested changes", () => {
  assert.strictEqual(stableHash({ a: 1 }), stableHash({ a: 1 }));
  assert.notStrictEqual(stableHash({ a: 1 }), stableHash({ a: 2 }));
});
