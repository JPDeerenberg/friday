/**
 * Browser attachment toolkit for the AI (Phase 8).
 *
 * Mirrors `src-tauri/src/ai/attachment_reader.rs`: same caps, same shapes,
 * same validation semantics. Differences are platform capabilities, not
 * contracts: web reads PDF (pdfjs-dist) and DOCX (mammoth), both lazily
 * imported so the main bundle doesn't grow; PPTX/images/spreadsheets report
 * `readable: false` with a Dutch reason.
 */

export const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
export const DEFAULT_PAGE_CHARS = 8000;
export const EXTRACT_MAX_CHARS = 200_000;
export const TEXT_CACHE_LIMIT = 20;
export const REGISTRY_LIMIT = 200;

export type UrlKind = "relative" | "same-host";

export type UrlCheck =
  { ok: true; kind: UrlKind } | { ok: false; reason: string };

const REJECT_REASON =
  "Ongeldige URL: alleen links van je eigen Magister-domein zijn toegestaan.";

/**
 * Validate a model-supplied attachment URL (SSRF guard). Accepts relative
 * paths and absolute URLs on the endpoint's own host; rejects foreign hosts,
 * userinfo tricks, non-HTTP schemes and protocol-relative URLs.
 */
export function validateAttachmentUrl(url: string, endpoint: string): UrlCheck {
  const u = (url ?? "").trim();
  if (!u) return { ok: false, reason: "Geen URL opgegeven." };
  if (u.startsWith("//")) return { ok: false, reason: REJECT_REASON };
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: REJECT_REASON };
    }
    if (parsed.username || parsed.password)
      return { ok: false, reason: REJECT_REASON };
    let ep: URL;
    try {
      ep = new URL(endpoint);
    } catch {
      return { ok: false, reason: REJECT_REASON };
    }
    const hostEq = parsed.hostname.toLowerCase() === ep.hostname.toLowerCase();
    const portEq =
      (parsed.port || defaultPort(parsed.protocol)) ===
      (ep.port || defaultPort(ep.protocol));
    if (hostEq && portEq) return { ok: true, kind: "same-host" };
    return {
      ok: false,
      reason:
        "Ongeldige URL: alleen links van je eigen Magister-domein zijn toegestaan.",
    };
  } catch {
    const lower = u.toLowerCase();
    if (lower.includes("://")) return { ok: false, reason: REJECT_REASON };
    for (const scheme of ["file:", "ftp:", "data:", "javascript:", "blob:"]) {
      if (lower.startsWith(scheme)) return { ok: false, reason: REJECT_REASON };
    }
    return { ok: true, kind: "relative" };
  }
}

function defaultPort(protocol: string): string {
  return protocol === "http:" ? "80" : "443";
}

function extensionOf(filename: string): string {
  const base = (filename ?? "").toLowerCase().split("?")[0].split("#")[0];
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1);
}

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "tiff",
  "tif",
  "svg",
]);
const TEXT_EXTS = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "rtf",
  "csv",
  "log",
  "json",
  "xml",
  "html",
  "htm",
  "yaml",
  "yml",
  "css",
  "js",
  "ts",
]);

/**
 * Why a file can't be read, or null when it can. `pptxSupported` is false on
 * web (no extractor loaded) and true on desktop.
 */
export function unsupportedReason(
  filename: string,
  contentType: string,
  pptxSupported: boolean,
): string | null {
  const ext = extensionOf(filename);
  const ct = (contentType ?? "").toLowerCase();
  if (IMAGE_EXTS.has(ext) || ct.startsWith("image/")) {
    return "afbeeldingen worden niet gelezen (alleen tekst)";
  }
  if (
    ext === "xlsx" ||
    ext === "xls" ||
    ct.includes("spreadsheetml") ||
    ct.includes("excel")
  ) {
    return "spreadsheets worden nog niet ondersteund";
  }
  if ((ext === "pptx" || ct.includes("presentationml")) && !pptxSupported) {
    return "presentaties worden op web nog niet ondersteund";
  }
  return null;
}

/** True for formats this engine can extract (used for `readable`). */
export function isReadableExtension(
  filename: string,
  pptxSupported: boolean,
): boolean {
  if (unsupportedReason(filename, "", pptxSupported) !== null) return false;
  const ext = extensionOf(filename);
  return (
    TEXT_EXTS.has(ext) || ext === "pdf" || ext === "docx" || ext === "pptx"
  );
}

export function isEmptyText(text: string): boolean {
  return text.trim().length === 0;
}

/** Cap extracted text for the cache. Returns [capped, truncated]. */
export function capExtracted(text: string): [string, boolean] {
  const chars = Array.from(text);
  if (chars.length <= EXTRACT_MAX_CHARS) return [text, false];
  return [chars.slice(0, EXTRACT_MAX_CHARS).join(""), true];
}

/** Page through extracted text (char offsets, surrogate-safe). */
export function pageText(
  text: string,
  offset: number,
  maxChars: number,
): { page: string; nextOffset: number | null; total: number } {
  const chars = Array.from(text);
  const total = chars.length;
  const start = Math.min(Math.max(0, offset), total);
  const end = Math.min(start + Math.max(1, maxChars), total);
  return {
    page: chars.slice(start, end).join(""),
    nextOffset: end < total ? end : null,
    total,
  };
}

// ─── Registry + cache (session-scoped) ─────────────────────────────────────

export interface FileRef {
  url: string;
  name: string;
  source: string;
}

export interface CachedText {
  url: string;
  name: string;
  text: string;
  total_chars: number;
  size_bytes: number;
  truncated: boolean;
}

const registry = new Map<string, FileRef>();
const textCache = new Map<string, CachedText>();

function evictOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}

/** Register a listed file for later `file_id` reads. */
export function registryPut(fileId: string, ref: FileRef): void {
  if (registry.has(fileId)) registry.delete(fileId);
  registry.set(fileId, ref);
  evictOldest(registry, REGISTRY_LIMIT);
}

export function registryGet(fileId: string): FileRef | null {
  return registry.get(fileId) ?? null;
}

/** Cached text hit requires the same source URL (stale ids re-download). */
export function cacheGet(fileId: string, url: string): CachedText | null {
  const entry = textCache.get(fileId);
  return entry && entry.url === url ? entry : null;
}

export function cachePut(fileId: string, entry: CachedText): void {
  if (textCache.has(fileId)) textCache.delete(fileId);
  textCache.set(fileId, entry);
  evictOldest(textCache, TEXT_CACHE_LIMIT);
}

/** Test hooks. */
export function __registryLen(): number {
  return registry.size;
}
export function __cacheLen(): number {
  return textCache.size;
}
export function __clearFileState(): void {
  registry.clear();
  textCache.clear();
}

// ─── Extraction (lazy heavy deps) ──────────────────────────────────────────

export interface PdfTextLoader {
  getText(data: Uint8Array): string | Promise<string>;
}

let pdfLoader: PdfTextLoader | null = null;

/** Test hook: inject a fake PDF extractor (pdfjs needs a worker at runtime). */
export function __setPdfLoader(loader: PdfTextLoader | null): void {
  pdfLoader = loader;
}

async function defaultPdfLoader(): Promise<PdfTextLoader> {
  const pdfjs = (await import("pdfjs-dist")) as unknown as {
    getDocument: (opts: unknown) => { promise: Promise<PdfDoc> };
    GlobalWorkerOptions: { workerSrc: string };
  };
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    // Bundle the worker as an asset URL (Vite ?url) so text extraction
    // works off the main thread without a CDN.
    const worker =
      (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")) as unknown as {
        default: string;
      };
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  return {
    getText: async (data: Uint8Array): Promise<string> => {
      const doc = await pdfjs.getDocument({ data }).promise;
      const parts: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        parts.push(
          content.items
            .map((it) => (it as { str?: string }).str ?? "")
            .join(" "),
        );
      }
      return parts.join("\n\n");
    },
  };
}

interface PdfDoc {
  numPages: number;
  getPage(i: number): Promise<PdfPage>;
}

interface PdfPage {
  getTextContent(): Promise<{ items: unknown[] }>;
}

/** Extract plain text from attachment bytes (web engines). */
export async function extractText(
  bytes: Uint8Array,
  filename: string,
  contentType: string,
): Promise<string> {
  const lower = (filename ?? "").toLowerCase();
  const ext = extensionOf(lower);
  const ct = (contentType ?? "").toLowerCase();

  if (ext === "pdf" || ct.includes("application/pdf") || ct.includes("pdf")) {
    const loader = pdfLoader ?? (await defaultPdfLoader());
    return loader.getText(bytes);
  }
  if (
    ext === "docx" ||
    ct.includes("wordprocessingml") ||
    ct.includes("officedocument.wordprocessingml") ||
    ct.includes("docx")
  ) {
    const mammoth = (await import("mammoth")) as unknown as {
      extractRawText: (opts: {
        buffer: ArrayBuffer;
      }) => Promise<{ value: string }>;
    };
    const copy = new Uint8Array(bytes);
    const out = await mammoth.extractRawText({
      buffer: copy.buffer as ArrayBuffer,
    });
    return out.value ?? "";
  }
  if (
    TEXT_EXTS.has(ext) ||
    ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("html") ||
    ct.includes("csv")
  ) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  // Unknown type: try UTF-8; NUL bytes mean binary we don't support.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!text.includes("\u0000")) return text;
  throw new Error(
    `Niet-ondersteund bestandstype '${filename}' (${contentType || "onbekend type"}). Alleen PDF, Word (.docx) en tekstbestanden kunnen op web worden gelezen.`,
  );
}
