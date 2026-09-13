/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

// Friday PWA service worker (SvelteKit built-in — auto-registered).
//
// Caching contract:
// - App shell (`build` + `files`): precached on install, served cache-first.
// - Navigations: network-first, cache fallback (fresh HTML when online).
// - `/api/*` (web-api + Magister data): NEVER cached here. API freshness is
//   owned by IndexedDB (`cache.ts` TTL + stale-while-revalidate); a second,
//   unversioned HTTP cache would only serve stale grades as "fresh".
// - Everything else (fonts, images): network-first, cache fallback.

import { build, files, version } from '$service-worker';

const self = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (globalThis.self));

const CACHE = `friday-${version}`;
const ASSETS = new Set([...build, ...files]);

self.addEventListener('install', (event) => {
  async function addFilesToCache() {
    const cache = await caches.open(CACHE);
    await cache.addAll([...ASSETS]);
  }
  event.waitUntil(addFilesToCache());
});

self.addEventListener('activate', (event) => {
  async function deleteOldCaches() {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  }
  event.waitUntil(deleteOldCaches());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // API traffic is never served from (or written to) this cache.
  if (url.pathname.startsWith('/api/')) return;
  // The gh-pages branch also serves the F-Droid repo (/fdroid/*, multi-MB
  // APKs) — never cache those either.
  if (url.pathname.startsWith('/fdroid/')) return;

  async function respond() {
    const cache = await caches.open(CACHE);

    // Versioned build output + static files: immutable, cache-first.
    if (ASSETS.has(url.pathname)) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }

    try {
      const response = await fetch(req);
      if (
        response instanceof Response &&
        response.status === 200 &&
        response.type === 'basic' &&
        !response.headers.get('cache-control')?.includes('no-store')
      ) {
        cache.put(req, response.clone());
      }
      return response;
    } catch (err) {
      const hit = await cache.match(req);
      if (hit) return hit;
      // Offline navigation with nothing cached: fall back to the app shell.
      if (req.mode === 'navigate') {
        const shell = await cache.match('/');
        if (shell) return shell;
      }
      throw err;
    }
  }

  event.respondWith(respond());
});
