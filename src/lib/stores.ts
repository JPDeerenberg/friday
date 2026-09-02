import { writable } from "svelte/store";
import type { Account } from "$lib/types";

export const isLoggedIn = writable(false);
export const personId = writable<number | null>(null);
export const accountInfo = writable<Account | null>(null);
export const profilePicture = writable<string | null>(null);
export const currentPage = writable<string>("dashboard");
export const navigationStack = writable<string[]>([]);
// Surfaces auth-callback/auth-success/auth-error failures from +layout.svelte
// (the sole owner of processing those events) to whatever screen wants to
// show them — currently Login.svelte.
export const loginError = writable<string>("");

// App resume signal — updated on hidden→visible transition (see
// +layout.svelte). Pages watch this to force-refresh stale cached data
// without requiring manual navigation. Initial value is now() so pages
// that mount after the first resume still have a sensible value.
export const resumedAt = writable<number>(Date.now());

// Restore status: helps +layout distinguish a transient network failure
// (offline at cold boot) from a genuine logout. When `unavailable`, the
// login screen is NOT shown; the app keeps an offline indicator and
// retries on the next resume.
export const restoreStatus = writable<"restored" | "logged_out" | "unavailable" | null>(null);

// Sync status
export const lastSyncTime = writable<Date | null>(null);
export const syncInProgress = writable(false);

export function navigate(pageId: string) {
  currentPage.update((current) => {
    if (current !== pageId) {
      navigationStack.update((stack) => [...stack, current]);
    }
    return pageId;
  });
}

export function goBack() {
  let canExit = false;
  navigationStack.update((stack) => {
    if (stack.length > 0) {
      const prev = stack[stack.length - 1];
      currentPage.set(prev);
      return stack.slice(0, -1);
    }
    canExit = true;
    return stack;
  });
  return canExit;
}

// Persistent Settings
export const DEFAULT_SETTINGS = {
  roundedGraphs: true,
  showSummary: true,
  decimalPoints: 1,
  highlightFailing: true,
  compactView: false,
  insufficientThreshold: 5.5,
  zoomGraph: false,
  showWeekend: true,
  weekView: "auto",
  themeColor: "violet",
  backgroundMode: "normal",
  // Notification toggles
  notifyMessages: true,
  notifyGrades: true,
  notifyDeadlines: true,
  notifyCalendar: true,
  notifyAutoDnd: false,
  hideCancelled: false,
  combineLessons: false,
  showBreakSeparator: false,
  breakThresholdMinutes: 20,
  downloadDir: "",
};

// Load settings from localStorage
export function loadSettings() {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;

  const savedSettings = localStorage.getItem("user_settings");
  if (savedSettings) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) };
    } catch (e) {
      return DEFAULT_SETTINGS;
    }
  }
  return DEFAULT_SETTINGS;
}

export const userSettings = writable(loadSettings());

const NOTIFICATION_SETTING_KEYS = [
  "notifyMessages",
  "notifyGrades",
  "notifyDeadlines",
  "notifyCalendar",
  "notifyAutoDnd",
] as const;

function pickNotificationSettings(
  settings: typeof DEFAULT_SETTINGS,
): Record<(typeof NOTIFICATION_SETTING_KEYS)[number], boolean> {
  return {
    notifyMessages: settings.notifyMessages,
    notifyGrades: settings.notifyGrades,
    notifyDeadlines: settings.notifyDeadlines,
    notifyCalendar: settings.notifyCalendar,
    notifyAutoDnd: settings.notifyAutoDnd,
  };
}

if (typeof window !== "undefined") {
  let lastSyncedNotifPrefs: Record<
    (typeof NOTIFICATION_SETTING_KEYS)[number],
    boolean
  > | null = null;

  userSettings.subscribe((val) => {
    localStorage.setItem("user_settings", JSON.stringify(val));

    // Sync notification preferences to Android only when an actual
    // notification-related value changed (not on every settings write).
    const notifPrefs = pickNotificationSettings(val);
    const changed =
      lastSyncedNotifPrefs === null ||
      NOTIFICATION_SETTING_KEYS.some((key) => notifPrefs[key] !== lastSyncedNotifPrefs![key]);
    if (changed) {
      lastSyncedNotifPrefs = notifPrefs;
      syncPreferencesToAndroid(val);
    }
  });
}

// Sync preferences to Android via Tauri bridge
function syncPreferencesToAndroid(settings: typeof DEFAULT_SETTINGS) {
  // Store in localStorage for Android to read
  localStorage.setItem(
    "friday_notification_prefs",
    JSON.stringify({
      notifyMessages: settings.notifyMessages ?? true,
      notifyGrades: settings.notifyGrades ?? true,
      notifyDeadlines: settings.notifyDeadlines ?? true,
      notifyCalendar: settings.notifyCalendar ?? true,
      notifyAutoDnd: settings.notifyAutoDnd ?? false,
    }),
  );

  // Also sync via Tauri command
  if (typeof window !== "undefined" && (window as any).__TAURI__) {
    import("./api")
      .then(async (api) => {
        const params = {
          notifyMessages: settings.notifyMessages ?? true,
          notifyGrades: settings.notifyGrades ?? true,
          notifyDeadlines: settings.notifyDeadlines ?? true,
          notifyCalendar: settings.notifyCalendar ?? true,
          notifyAutoDnd: settings.notifyAutoDnd ?? false,
        };

        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await api.syncNotificationPreferences(
              params.notifyMessages,
              params.notifyGrades,
              params.notifyDeadlines,
              params.notifyCalendar,
              params.notifyAutoDnd,
            );

            // After successfully syncing preferences, trigger an immediate background sync
            // so the Android background worker can re-evaluate DND scheduling.
            try {
              await api.triggerSync();
            } catch (e) {
              console.warn("triggerSync failed", e);
            }
            return;
          } catch (e) {
            console.warn(
              `syncNotificationPreferences attempt ${attempt} failed`,
              e,
            );
            if (attempt < maxAttempts) {
              // exponential-ish backoff
              await new Promise((res) => setTimeout(res, attempt * 300));
              continue;
            }
            console.error(
              "Failed to sync notification preferences after retries",
              e,
            );
          }
        }
      })
      .catch((e) => {
        console.error("Failed to import api for notification sync", e);
      });
  }
}
