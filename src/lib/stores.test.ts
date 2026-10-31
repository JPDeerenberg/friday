import test from "node:test";
import assert from "node:assert";

interface MockStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  clear: () => void;
  removeItem: (key: string) => void;
}

// Mock localStorage
const mockLocalStorage: MockStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    clear: () => {
      store = {};
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
})();

// Global mocks (must be set before importing stores so its subscribe registers)
global.window = {} as unknown as Window & typeof globalThis;
global.localStorage = mockLocalStorage as unknown as Storage;

const {
  loadSettings,
  DEFAULT_SETTINGS,
  userSettings,
  START_PAGE_OPTIONS,
  getStartPage,
} = await import("./stores.ts");

test("loadSettings returns DEFAULT_SETTINGS when localStorage is empty", () => {
  mockLocalStorage.clear();
  const settings = loadSettings();
  assert.deepStrictEqual(settings, DEFAULT_SETTINGS);
});

test("loadSettings merges valid JSON from localStorage", () => {
  mockLocalStorage.clear();
  const saved = { themeColor: "blue", compactView: true };
  mockLocalStorage.setItem("user_settings", JSON.stringify(saved));

  const settings = loadSettings();
  assert.strictEqual(settings.themeColor, "blue");
  assert.strictEqual(settings.compactView, true);
  assert.strictEqual(settings.roundedGraphs, DEFAULT_SETTINGS.roundedGraphs);
});

test("loadSettings returns DEFAULT_SETTINGS when JSON is invalid", () => {
  mockLocalStorage.clear();
  mockLocalStorage.setItem("user_settings", "invalid-json");

  const settings = loadSettings();
  assert.deepStrictEqual(settings, DEFAULT_SETTINGS);
});

test("loadSettings merges partial JSON and preserves other defaults", () => {
  mockLocalStorage.clear();
  const saved = { decimalPoints: 2 };
  mockLocalStorage.setItem("user_settings", JSON.stringify(saved));

  const settings = loadSettings();
  assert.strictEqual(settings.decimalPoints, 2);
  assert.strictEqual(settings.showSummary, DEFAULT_SETTINGS.showSummary);
});

function countNotificationPrefSyncs(fn: () => void): number {
  let count = 0;
  const originalSetItem = mockLocalStorage.setItem;
  mockLocalStorage.setItem = (key: string, value: string) => {
    if (key === "friday_notification_prefs") count++;
    originalSetItem(key, value);
  };
  try {
    fn();
  } finally {
    mockLocalStorage.setItem = originalSetItem;
  }
  return count;
}

test("changing a non-notification setting does not trigger notification-preference sync", () => {
  mockLocalStorage.clear();
  userSettings.set({ ...DEFAULT_SETTINGS });

  const calls = countNotificationPrefSyncs(() => {
    userSettings.set({ ...DEFAULT_SETTINGS, themeColor: "blue" });
  });
  assert.strictEqual(calls, 0);
});

test("changing a notification setting triggers notification-preference sync exactly once", () => {
  mockLocalStorage.clear();
  userSettings.set({ ...DEFAULT_SETTINGS });

  const calls = countNotificationPrefSyncs(() => {
    userSettings.set({ ...DEFAULT_SETTINGS, notifyMessages: false });
  });
  assert.strictEqual(calls, 1);
});

test("startPage defaults to dashboard", () => {
  mockLocalStorage.clear();
  assert.strictEqual(DEFAULT_SETTINGS.startPage, "dashboard");
  const settings = loadSettings();
  assert.strictEqual(settings.startPage, "dashboard");
  assert.ok(START_PAGE_OPTIONS.some((o) => o.value === "dashboard"));
});

test("loadSettings keeps a valid stored startPage", () => {
  mockLocalStorage.clear();
  mockLocalStorage.setItem(
    "user_settings",
    JSON.stringify({ startPage: "calendar" }),
  );

  const settings = loadSettings();
  assert.strictEqual(settings.startPage, "calendar");
});

test("loadSettings falls back to dashboard for an invalid stored startPage", () => {
  mockLocalStorage.clear();
  mockLocalStorage.setItem(
    "user_settings",
    JSON.stringify({ startPage: "not-a-page" }),
  );

  const settings = loadSettings();
  assert.strictEqual(settings.startPage, "dashboard");
});

test("getStartPage returns the stored value when valid and dashboard otherwise", () => {
  mockLocalStorage.clear();
  userSettings.set({ ...DEFAULT_SETTINGS, startPage: "grades" });
  assert.strictEqual(getStartPage(), "grades");

  userSettings.set({ ...DEFAULT_SETTINGS, startPage: "bogus" });
  assert.strictEqual(getStartPage(), "dashboard");
});

test("loadSettings repairs invalid grade-math settings and keeps valid ones", () => {
  mockLocalStorage.clear();
  mockLocalStorage.setItem(
    "user_settings",
    JSON.stringify({
      letterGradeRules: [
        { token: " V ", status: "pass", value: null },
        { token: "7", status: "pass", value: 7 },
        { token: "v", status: "fail", value: null },
      ],
      retakeRule: "nonsense",
      gradeRounding: "huh",
      judgeRounded: "yes",
      compensation: { minTotal: "x", points: { "5": -2 } },
      compensationExcluded: ["LO", 4],
    }),
  );
  const s = loadSettings();
  assert.deepStrictEqual(s.letterGradeRules, [
    { token: "V", status: "pass", value: null },
  ]);
  assert.strictEqual(s.retakeRule, "magister");
  assert.strictEqual(s.gradeRounding, "decimals");
  assert.strictEqual(s.judgeRounded, false);
  assert.strictEqual(s.compensation.points["5"], -2);
  assert.strictEqual(s.compensation.minTotal, 0);
  assert.deepStrictEqual(s.compensationExcluded, ["LO"]);
});
