import test from 'node:test';
import assert from 'node:assert';

// Minimal browser mocks (updates.ts guards window/localStorage access).
const storage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value.toString(); },
    clear: () => { store = {}; },
    removeItem: (key: string) => { delete store[key]; }
  };
})();

global.window = { localStorage: storage } as unknown as Window & typeof globalThis;
global.localStorage = storage as unknown as Storage;

const { normalizeVersion, compareVersions, isNewerVersion, parseRelease, checkForUpdates } =
  await import('./updates.ts');

test('normalizeVersion strips leading v and whitespace', () => {
  assert.strictEqual(normalizeVersion('v2.4.3'), '2.4.3');
  assert.strictEqual(normalizeVersion(' V1.2 '), '1.2');
  assert.strictEqual(normalizeVersion('2.4.3'), '2.4.3');
});

test('compareVersions orders numeric parts', () => {
  assert.strictEqual(compareVersions('2.4.3', '2.4.3'), 0);
  assert.strictEqual(compareVersions('2.4.2', '2.4.3'), -1);
  assert.strictEqual(compareVersions('2.4.4', '2.4.3'), 1);
  assert.strictEqual(compareVersions('2.10.0', '2.9.9'), 1);
  assert.strictEqual(compareVersions('v2.4.3', '2.4.3'), 0);
  assert.strictEqual(compareVersions('2.4', '2.4.0'), 0);
  assert.strictEqual(compareVersions('3.0.0', '2.99.99'), 1);
});

test('isNewerVersion only true when latest is strictly newer', () => {
  assert.strictEqual(isNewerVersion('v2.4.3', '2.4.2'), true);
  assert.strictEqual(isNewerVersion('v2.4.3', '2.4.3'), false);
  assert.strictEqual(isNewerVersion('v2.4.3', '2.4.4'), false);
  assert.strictEqual(isNewerVersion('', '2.4.4'), false);
  assert.strictEqual(isNewerVersion('v2.4.3', ''), false);
});

test('parseRelease falls back to releases page when html_url missing', () => {
  const r = parseRelease({ tag_name: 'v2.4.3' }, '2.4.2');
  assert.strictEqual(r.latest, '2.4.3');
  assert.strictEqual(r.updateAvailable, true);
  assert.ok(r.htmlUrl.includes('JPDeerenberg/friday/releases'));
});

test('checkForUpdates returns fresh cache without fetching', async () => {
  storage.clear();
  const cached = {
    current: '2.4.4', latest: '2.4.3', tag: 'v2.4.3',
    htmlUrl: 'https://github.com/JPDeerenberg/friday/releases/tag/v2.4.3',
    notes: '', publishedAt: '', updateAvailable: false, checkedAt: Date.now(),
  };
  storage.setItem('friday-update-check', JSON.stringify(cached));
  let fetched = false;
  const result = await checkForUpdates({
    fetcher: (async () => { fetched = true; throw new Error('must not fetch'); }) as unknown as typeof fetch,
  });
  assert.strictEqual(fetched, false);
  assert.deepStrictEqual(result, cached);
});

test('checkForUpdates with force hits network and caches', async () => {
  storage.clear();
  const fakeFetch = (async () => ({
    ok: true, status: 200,
    json: async () => ({
      tag_name: 'v2.4.3',
      html_url: 'https://github.com/JPDeerenberg/friday/releases/tag/v2.4.3',
      body: 'notes', published_at: '2026-09-08T19:05:12Z',
    }),
  })) as unknown as typeof fetch;
  const result = await checkForUpdates({ force: true, currentVersion: '2.4.2', fetcher: fakeFetch });
  assert.strictEqual(result.updateAvailable, true);
  assert.strictEqual(result.latest, '2.4.3');
  const stored = JSON.parse(storage.getItem('friday-update-check')!);
  assert.strictEqual(stored.latest, '2.4.3');
});

test('checkForUpdates throws Dutch error on rate limit', async () => {
  storage.clear();
  const fakeFetch = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    checkForUpdates({ force: true, currentVersion: '2.4.4', fetcher: fakeFetch }),
    /GitHub-limiet/,
  );
});
