import test from 'node:test';
import assert from 'node:assert';

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
    setItem: (key: string, value: string) => { store[key] = value.toString(); },
    clear: () => { store = {}; },
    removeItem: (key: string) => { delete store[key]; }
  };
})();

// Global mocks (must be set before importing stores so its subscribe registers)
global.window = {} as unknown as Window & typeof globalThis;
global.localStorage = mockLocalStorage as unknown as Storage;

const { loadSettings, DEFAULT_SETTINGS, userSettings } = await import('./stores.ts');

test('loadSettings returns DEFAULT_SETTINGS when localStorage is empty', () => {
  mockLocalStorage.clear();
  const settings = loadSettings();
  assert.deepStrictEqual(settings, DEFAULT_SETTINGS);
});

test('loadSettings merges valid JSON from localStorage', () => {
  mockLocalStorage.clear();
  const saved = { themeColor: 'blue', compactView: true };
  mockLocalStorage.setItem('user_settings', JSON.stringify(saved));

  const settings = loadSettings();
  assert.strictEqual(settings.themeColor, 'blue');
  assert.strictEqual(settings.compactView, true);
  assert.strictEqual(settings.roundedGraphs, DEFAULT_SETTINGS.roundedGraphs);
});

test('loadSettings returns DEFAULT_SETTINGS when JSON is invalid', () => {
  mockLocalStorage.clear();
  mockLocalStorage.setItem('user_settings', 'invalid-json');

  const settings = loadSettings();
  assert.deepStrictEqual(settings, DEFAULT_SETTINGS);
});

test('loadSettings merges partial JSON and preserves other defaults', () => {
  mockLocalStorage.clear();
  const saved = { decimalPoints: 2 };
  mockLocalStorage.setItem('user_settings', JSON.stringify(saved));

  const settings = loadSettings();
  assert.strictEqual(settings.decimalPoints, 2);
  assert.strictEqual(settings.showSummary, DEFAULT_SETTINGS.showSummary);
});

function countNotificationPrefSyncs(fn: () => void): number {
  let count = 0;
  const originalSetItem = mockLocalStorage.setItem;
  mockLocalStorage.setItem = (key: string, value: string) => {
    if (key === 'friday_notification_prefs') count++;
    originalSetItem(key, value);
  };
  try {
    fn();
  } finally {
    mockLocalStorage.setItem = originalSetItem;
  }
  return count;
}

test('changing a non-notification setting does not trigger notification-preference sync', () => {
  mockLocalStorage.clear();
  userSettings.set({ ...DEFAULT_SETTINGS });

  const calls = countNotificationPrefSyncs(() => {
    userSettings.set({ ...DEFAULT_SETTINGS, themeColor: 'blue' });
  });
  assert.strictEqual(calls, 0);
});

test('changing a notification setting triggers notification-preference sync exactly once', () => {
  mockLocalStorage.clear();
  userSettings.set({ ...DEFAULT_SETTINGS });

  const calls = countNotificationPrefSyncs(() => {
    userSettings.set({ ...DEFAULT_SETTINGS, notifyMessages: false });
  });
  assert.strictEqual(calls, 1);
});
