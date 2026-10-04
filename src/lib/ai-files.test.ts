/**
 * Unit tests for the browser attachment toolkit (src/lib/ai-files.ts).
 * Rust mirror: src-tauri/src/ai/attachment_reader.rs tests.
 *
 * Phase 8 of fixes/friday-ai-upgrade-plan.md.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/ai-files.test.ts
 * or: pnpm test
 */
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

import {
  EXTRACT_MAX_CHARS,
  TEXT_CACHE_LIMIT,
  __cacheLen,
  __clearFileState,
  __registryLen,
  __setPdfLoader,
  cacheGet,
  cachePut,
  capExtracted,
  extractText,
  isEmptyText,
  isReadableExtension,
  pageText,
  registryGet,
  registryPut,
  unsupportedReason,
  validateAttachmentUrl,
} from "./ai-files.ts";

test("url validation blocks tricks", () => {
  const ep = "https://jan.magister.net";
  assert.deepStrictEqual(validateAttachmentUrl("personen/1/bijlagen/2", ep), {
    ok: true,
    kind: "relative",
  });
  assert.deepStrictEqual(
    validateAttachmentUrl("https://jan.magister.net/api/x", ep),
    {
      ok: true,
      kind: "same-host",
    },
  );
  assert.deepStrictEqual(
    validateAttachmentUrl("https://JAN.MAGISTER.NET/x", ep).ok,
    true,
  );
  for (const bad of [
    "https://evil.example.com/x",
    "https://jan.magister.net.evil.com/x",
    "https://user@jan.magister.net/x",
    "https://jan.magister.net@evil.com/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/plain,hi",
    "//evil.com/x",
    "https://jan.magister.net:8443/x",
    "",
  ]) {
    const r = validateAttachmentUrl(bad, ep);
    assert.strictEqual(r.ok, false, `should reject ${bad}`);
  }
});

test("unsupported reasons per platform capability", () => {
  assert.strictEqual(
    unsupportedReason("foto.png", "image/png", false),
    "afbeeldingen worden niet gelezen (alleen tekst)",
  );
  assert.strictEqual(
    unsupportedReason("tabel.xlsx", "", true),
    "spreadsheets worden nog niet ondersteund",
  );
  assert.strictEqual(
    unsupportedReason("deck.pptx", "", false),
    "presentaties worden op web nog niet ondersteund",
  );
  assert.strictEqual(unsupportedReason("deck.pptx", "", true), null);
  assert.strictEqual(unsupportedReason("a.txt", "text/plain", false), null);
  assert.ok(isReadableExtension("werkstuk.pdf", false));
  assert.ok(isReadableExtension("werkstuk.docx", false));
  assert.ok(!isReadableExtension("deck.pptx", false));
  assert.ok(!isReadableExtension("foto.jpg", false));
});

test("paging is char-based and surrogate-safe", () => {
  const text = "a".repeat(100) + "🎓".repeat(10);
  const p1 = pageText(text, 95, 10);
  assert.strictEqual(p1.total, 110);
  assert.strictEqual(p1.nextOffset, 105);
  assert.strictEqual(Array.from(p1.page).length, 10);
  const p2 = pageText(text, 105, 10);
  assert.strictEqual(p2.nextOffset, null);
  assert.strictEqual(Array.from(p2.page).length, 5);
  assert.strictEqual(pageText(text, 500, 10).page, "");
  assert.ok(isEmptyText("  \n "));
  assert.ok(!isEmptyText("Hallo"));
});

test("registry + cache round-trip with eviction", () => {
  __clearFileState();
  registryPut("a:1:2", {
    url: "bijlagen/2",
    name: "a.txt",
    source: "assignment",
  });
  assert.strictEqual(__registryLen(), 1);
  assert.strictEqual(registryGet("a:1:2")?.name, "a.txt");
  assert.strictEqual(registryGet("nope"), null);
  cachePut("a:1:2", {
    url: "bijlagen/2",
    name: "a.txt",
    text: "hallo",
    total_chars: 5,
    size_bytes: 5,
    truncated: false,
  });
  assert.ok(cacheGet("a:1:2", "bijlagen/2"));
  assert.strictEqual(cacheGet("a:1:2", "bijlagen/3"), null);
  for (let i = 0; i < 30; i++) {
    cachePut(`k${i}`, {
      url: "u",
      name: "n",
      text: "t",
      total_chars: 1,
      size_bytes: 1,
      truncated: false,
    });
  }
  assert.ok(__cacheLen() <= TEXT_CACHE_LIMIT);
  __clearFileState();
});

test("capExtracted honours the extraction ceiling", () => {
  const [short, t1] = capExtracted("klein");
  assert.strictEqual(short, "klein");
  assert.strictEqual(t1, false);
  const [long, t2] = capExtracted("z".repeat(EXTRACT_MAX_CHARS + 10));
  assert.strictEqual(Array.from(long).length, EXTRACT_MAX_CHARS);
  assert.strictEqual(t2, true);
});

test("plain text extracts via TextDecoder", async () => {
  const bytes = new TextEncoder().encode("een simpel tekstbestand");
  assert.strictEqual(
    await extractText(bytes, "opdracht.txt", "text/plain"),
    "een simpel tekstbestand",
  );
  assert.strictEqual(
    await extractText(bytes, "data.json", "application/json"),
    "een simpel tekstbestand",
  );
});

test("mammoth extracts the committed docx fixture", async () => {
  const bytes = new Uint8Array(readFileSync("src/lib/fixtures/werkstuk.docx"));
  const text = await extractText(
    bytes,
    "werkstuk.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.match(text, /Hallo Word wereld/);
  assert.match(text, /Tweede paragraaf/);
});

test("injected pdf loader is used for pdf", async () => {
  __setPdfLoader({
    getText: async (data: Uint8Array) => `PDF met ${data.length} bytes`,
  });
  try {
    const text = await extractText(
      new Uint8Array([1, 2, 3]),
      "x.pdf",
      "application/pdf",
    );
    assert.strictEqual(text, "PDF met 3 bytes");
  } finally {
    __setPdfLoader(null);
  }
});

test("unknown binary throws", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]);
  await assert.rejects(
    extractText(bytes, "plaatje.bin", "application/octet-stream"),
    /Niet-ondersteund/,
  );
});
