import { sanitizeHtml } from '$lib/sanitize';

type MarkedInstance = {
  parse: (src: string) => string;
  setOptions: (opts: Record<string, unknown>) => void;
  use: (...args: unknown[]) => void;
};

// Lazy singleton — `marked` chunk (≈10kB gz) is fetched only when first needed,
// never in initial layout bundle for users who never open AI.
let markedInstance: MarkedInstance | null = null;
let loading: Promise<MarkedInstance> | null = null;

// Per-content cache: O(1) lookup avoids re-parsing on every Svelte reactive cycle.
// Key is raw markdown string. Value is already sanitized HTML.
const htmlCache = new Map<string, string>();

async function getMarked(): Promise<MarkedInstance> {
  if (markedInstance) return markedInstance;
  if (loading) return loading;
  loading = import('marked').then((mod) => {
    const m = (mod as unknown as { marked: MarkedInstance }).marked as MarkedInstance;
    m.setOptions({
      gfm: true,
      breaks: true,
      mangle: false,
      headerIds: false,
    });
    markedInstance = m;
    return m;
  });
  return loading;
}

/**
 * Eagerly preload the `marked` chunk without blocking.
 * Call when `aiConfigured` becomes true or panel opens — warms cache.
 * Fire-and-forget safe.
 */
export function preloadMarkdown(): void {
  void getMarked().catch(() => {});
}

/**
 * Render markdown to sanitized HTML. Results are cached per distinct input.
 * Only call for `assistant` role — user messages stay plain text.
 */
export async function renderMarkdownAsync(md: string): Promise<string> {
  if (!md) return '';
  const cached = htmlCache.get(md);
  if (cached !== undefined) return cached;

  const marked = await getMarked();
  const raw = marked.parse(md) as string;
  const clean = sanitizeHtml(raw);
  htmlCache.set(md, clean);
  // Simple LRU cap to avoid unbounded growth (30 msgs × ~4k chars = ~120kB)
  if (htmlCache.size > 100) {
    const firstKey = htmlCache.keys().next().value;
    if (firstKey !== undefined) htmlCache.delete(firstKey);
  }
  return clean;
}

/**
 * Synchronous variant — returns cached HTML or empty string if not yet loaded.
 * Use inside `$derived` when you want zero async in render loop.
 * Caller should have called `preloadMarkdown()` / `renderMarkdownAsync` earlier.
 */
export function getCachedHtml(md: string): string | undefined {
  return htmlCache.get(md);
}

/**
 * Synchronous render if `marked` already loaded, else returns null so caller
 * can fall back to plain text until async completes. Avoids blocking.
 */
export function tryRenderMarkdownSync(md: string): string | null {
  if (!md) return '';
  const cached = htmlCache.get(md);
  if (cached !== undefined) return cached;
  if (!markedInstance) return null;
  const raw = markedInstance.parse(md) as string;
  const clean = sanitizeHtml(raw);
  htmlCache.set(md, clean);
  return clean;
}

export function isMarkdownReady(): boolean {
  return markedInstance !== null;
}

/** For testing: clear cache / reset singleton. */
export function _resetMarkdownForTest(): void {
  htmlCache.clear();
  markedInstance = null;
  loading = null;
}
