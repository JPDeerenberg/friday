/**
 * Opening a source ("bron") or attachment from a list: a link opens in the
 * browser, a file is downloaded (and opened where the platform can).
 *
 * The pages used to render `<a href="/api/…" target="_blank">`. That points at a
 * relative Magister path: it needs the login token, so it can never work from a
 * browser tab, and an Android WebView ignores `target="_blank"` altogether — the
 * button simply did nothing.
 */
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { downloadFile, getLeermiddelLaunchUrl } from "$lib/api";
import {
  pickDownloadHref,
  describeDownload,
  type AttachmentLink,
} from "$lib/attachments";

export interface OpenableBron {
  Naam: string;
  /** 0 = folder, 1 = file, 3 = web link */
  BronSoort?: number;
  Links?: ReadonlyArray<AttachmentLink> | null;
}

/** Opens a web address outside the app. */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Opens a link-type source or downloads a file-type one. Throws an Error with a
 * readable message when it fails; shows a note when the file was saved but
 * nothing could open it.
 */
export async function openBron(
  bron: OpenableBron,
  downloadDir: string,
): Promise<void> {
  const href = pickDownloadHref(bron.Links);
  if (!href) throw new Error("Deze bron heeft geen link.");

  if (bron.BronSoort === 3) {
    // Magister's link for a web-link source answers with the target address.
    await openExternalUrl(await getLeermiddelLaunchUrl(href));
    return;
  }
  const outcome = await downloadFile(href, bron.Naam, downloadDir);
  const note = describeDownload(outcome);
  if (note) alert(note);
}
