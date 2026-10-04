/**
 * Regression: web logouts caused by concurrent refreshes of a single-use refresh token.
 *
 * Magister rotates the refresh token on every grant, so only the FIRST grant with a
 * given token succeeds. Before the fix every concurrent caller (dashboard fan-out,
 * resume, second tab) fired its own grant; the losers got 401 and wiped the session.
 *
 * Run: node --import ./src/lib/test-hooks-register.ts src/lib/web-session.test.ts
 */
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert";

import {
  loadWebSession,
  saveWebSession,
  webRequest,
  restoreWebSession,
} from "./web-session.ts";

function expired(refreshToken: string) {
  return {
    accessToken: "a-" + refreshToken,
    refreshToken,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    apiEndpoint: "https://x.magister.net/api",
    personId: 1,
  };
}

/** Fake web-api: single-use refresh tokens, like Magister. */
function installFakeServer() {
  let current = "r1";
  let n = 1;
  const calls = { refresh: 0, rejected: 0 };
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const u = String(url);
    if (u.endsWith("/auth/refresh")) {
      calls.refresh++;
      const { refreshToken } = JSON.parse(String(init?.body ?? "{}"));
      await new Promise((r) => setTimeout(r, 20)); // network latency → real concurrency
      if (refreshToken !== current) {
        calls.rejected++;
        return new Response(JSON.stringify({ error: "Sessie verlopen" }), {
          status: 401,
        });
      }
      n++;
      current = "r" + n;
      return new Response(
        JSON.stringify({
          accessToken: "a-" + current,
          refreshToken: current,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          apiEndpoint: "https://x.magister.net/api",
          personId: null,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

test("concurrent requests on an expired token refresh once and stay logged in", async () => {
  const calls = installFakeServer();
  await saveWebSession(expired("r1"));

  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      webRequest<{ ok: boolean }>("GET", `thing/${i}`),
    ),
  );

  assert.ok(results.every((r) => r.ok));
  assert.strictEqual(
    calls.refresh,
    1,
    "one expiry must cost exactly one refresh grant",
  );
  assert.strictEqual(calls.rejected, 0);
  const stored = await loadWebSession();
  assert.ok(stored, "session must survive");
  assert.strictEqual(stored!.refreshToken, "r2");
});

test("restore + requests racing on resume do not log the user out", async () => {
  const calls = installFakeServer();
  await saveWebSession(expired("r1"));

  const [status] = await Promise.all([
    restoreWebSession(),
    webRequest("GET", "account?noCache=0"),
    webRequest("GET", "personen/1/afspraken"),
  ]);

  assert.strictEqual(status, "restored");
  assert.strictEqual(calls.rejected, 0);
  assert.ok(await loadWebSession());
});

test("a genuinely dead refresh token still logs out", async () => {
  installFakeServer();
  await saveWebSession(expired("dead")); // server only knows "r1"
  const status = await restoreWebSession();
  assert.strictEqual(status, "logged_out");
  assert.strictEqual(await loadWebSession(), null);
});
