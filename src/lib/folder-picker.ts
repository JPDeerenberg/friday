/**
 * "Map kiezen": choosing the folder downloads and exports are saved in.
 *
 * Desktop uses Tauri's dialog plugin. That plugin cannot pick a folder on
 * Android, so the Android app exposes its own picker (the system folder
 * picker, Storage Access Framework) on `window.FridayNative`:
 *
 *  - `pickFolder()` opens the picker and returns immediately;
 *  - `takePickedFolder()` answers "" while the picker is open, then once:
 *    "CANCELLED", "ERROR:<reason>" or `{"uri":"content://…","name":"…"}`.
 *
 * The chosen folder is stored as a `content://` tree URI in the `downloadDir`
 * setting; the Rust side writes into it (see ShareHelper.kt).
 */

export interface PickedFolder {
  uri: string;
  name: string;
}

export interface NativeFolderBridge {
  pickFolder: () => void;
  takePickedFolder: () => string;
}

export type PickAnswer =
  | { kind: "waiting" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string }
  | { kind: "picked"; folder: PickedFolder };

/** Turns the raw string from `takePickedFolder()` into something typed. */
export function parsePickAnswer(raw: string | null | undefined): PickAnswer {
  if (raw == null || raw === "") return { kind: "waiting" };
  if (raw === "CANCELLED") return { kind: "cancelled" };
  if (raw.startsWith("ERROR:")) {
    return { kind: "error", message: raw.slice("ERROR:".length).trim() || "onbekende fout" };
  }
  try {
    const parsed = JSON.parse(raw) as { uri?: unknown; name?: unknown };
    if (typeof parsed.uri === "string" && parsed.uri.startsWith("content://")) {
      const name =
        typeof parsed.name === "string" && parsed.name ? parsed.name : folderLabelFromUri(parsed.uri);
      return { kind: "picked", folder: { uri: parsed.uri, name } };
    }
  } catch {
    // fall through
  }
  return { kind: "error", message: "onverwacht antwoord van de app" };
}

/** True when running inside the Android app's WebView. */
export function isAndroidWebView(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

/** The Android bridge, or null (desktop, web, or an app version without the picker). */
export function getNativeFolderBridge(
  host: unknown = globalThis,
): NativeFolderBridge | null {
  const bridge = (host as { FridayNative?: Partial<NativeFolderBridge> }).FridayNative;
  if (
    bridge &&
    typeof bridge.pickFolder === "function" &&
    typeof bridge.takePickedFolder === "function"
  ) {
    return bridge as NativeFolderBridge;
  }
  return null;
}

export interface PickOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Opens the Android folder picker and waits for the answer.
 * Resolves to the chosen folder, or null when the user cancelled.
 * Rejects with a readable message when the picker failed or never answered.
 */
export async function pickFolderViaBridge(
  bridge: NativeFolderBridge,
  options: PickOptions = {},
): Promise<PickedFolder | null> {
  const intervalMs = options.intervalMs ?? 300;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Drop a stale answer from an earlier, abandoned pick.
  bridge.takePickedFolder();
  bridge.pickFolder();

  let waited = 0;
  while (waited <= timeoutMs) {
    await sleep(intervalMs);
    waited += intervalMs;
    const answer = parsePickAnswer(bridge.takePickedFolder());
    if (answer.kind === "picked") return answer.folder;
    if (answer.kind === "cancelled") return null;
    if (answer.kind === "error") throw new Error(answer.message);
  }
  throw new Error("De mapkiezer gaf geen antwoord.");
}

/**
 * Readable name for a stored download folder. Desktop paths are shown as they
 * are; an Android tree URI such as
 * `content://com.android.externalstorage.documents/tree/primary%3ADownload%2FFriday`
 * becomes `Download/Friday`.
 */
export function folderLabelFromUri(uri: string): string {
  if (!uri.startsWith("content://")) return uri;
  const match = uri.match(/\/tree\/([^/?#]+)/);
  if (!match) return uri;
  let id = match[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    // keep the raw segment
  }
  const colon = id.indexOf(":");
  const volume = colon >= 0 ? id.slice(0, colon) : "";
  const path = colon >= 0 ? id.slice(colon + 1) : id;
  const base = path || "Interne opslag";
  return !volume || volume === "primary" ? base : `${volume}: ${base}`;
}
