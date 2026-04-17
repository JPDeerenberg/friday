import test from 'node:test';
import assert from 'node:assert';
import { loadSettings, DEFAULT_SETTINGS } from './stores.ts';

// Mock localStorage
const mockLocalStorage = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value.toString(); },
    clear: () => { store = {}; },
    removeItem: (key) => { delete store[key]; }
  };
})();

// Global mocks
global.window = {};
global.localStorage = mockLocalStorage;

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
