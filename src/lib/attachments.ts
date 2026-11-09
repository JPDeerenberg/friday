/**
 * Picking the right link to download an attachment, and telling the user what
 * happened afterwards. Pure functions (no Tauri, no network) so they are easy
 * to test.
 */

export interface AttachmentLink {
  Rel: string;
  Href: string;
}

// Calendar/assignment attachments call it "Contents"; sources (bronnen) call it "content".
const DOWNLOAD_RELS = new Set(["download", "contents", "content", "self"]);

/**
 * Magister gives an attachment several links. `Self` is often only the
 * metadata record, while the `Contents`/`download` link answers with the file
 * (or a redirect to it). Discipulus, which downloads these reliably, takes the
 * longest of the three, because the download link extends the metadata one —
 * we do the same. Falls back to a plain `Url` field when there are no links.
 */
export function pickDownloadHref(
  links: ReadonlyArray<AttachmentLink> | null | undefined,
  fallbackUrl?: string | null,
): string | null {
  const candidates = (links ?? []).filter(
    (l) =>
      l &&
      typeof l.Href === "string" &&
      l.Href !== "" &&
      DOWNLOAD_RELS.has((l.Rel ?? "").toLowerCase()),
  );
  if (candidates.length > 0) {
    // Stable: on equal length the earlier link wins.
    return candidates.reduce((best, l) =>
      l.Href.length > best.Href.length ? l : best,
    ).Href;
  }
  return fallbackUrl ? fallbackUrl : null;
}

export interface DownloadOutcome {
  /** Where the file ended up: a path, a folder name or (browser) the file name. */
  location: string;
  /** An app was launched to show the file (Android). */
  opened: boolean;
  /** Browser build: the browser's own download bar already told the user. */
  inBrowser?: boolean;
  /** Offline: nothing was downloaded, this is where an earlier download went. */
  earlier?: boolean;
}

/** The message to show after a download, or null when nothing needs saying. */
export function describeDownload(outcome: DownloadOutcome): string | null {
  if (outcome.earlier) {
    return `Je bent offline. Dit bestand is eerder opgeslagen in: ${outcome.location}`;
  }
  if (outcome.opened || outcome.inBrowser) return null;
  return `Bestand opgeslagen in: ${outcome.location}`;
}
