# Friday — AI Agent Guidelines

> Companion for humans: [README.md](./README.md) (live demo, self-hosting, contributing).
> This file is the operational reference for AI coding agents working in this repo.

## 1. Quick commands

```bash
pnpm install                    # install frontend deps (pnpm only, never npm/yarn)
pnpm dev                        # Vite dev server on :1420 (LAN-reachable, phone testing)
pnpm build                      # frontend-only static build → build/
pnpm check                      # svelte-kit sync + svelte-check (type-check)
pnpm test                       # all 6 frontend test files (node built-in test runner)
pnpm tauri dev                  # full desktop app (frontend + Rust backend)
pnpm tauri build                # desktop production binary
pnpm tauri android build --apk  # Android APK (needs Android SDK + JDK 17)

cd src-tauri && cargo check --lib   # fast Rust compile check (~30s)
cd src-tauri && cargo test --lib    # Rust tests (wiremock; full build takes several minutes)
cd crates/web-api && PORT=3000 cargo run   # stateless web API for web dev
```

- Node 20+, pnpm 9+, stable Rust toolchain. Android builds need Android SDK + JDK 17.
- `pnpm test` runs: `stores`, `web-tier-b`, `web-ai-tools`, `ai`, `web-planner`, `web-stores` (all `*.test.ts` via plain `node`, some with `test-hooks-register.ts` for DOM shims).
- When everything is valid: bump version (`package.json` + `src-tauri/Cargo.toml` + `src-tauri/Cargo.lock`) and commit. `src-tauri/tauri.conf.json` version field is stale — leave it.

## 2. What this repo is

Friday is a Magister school client (agenda, grades, messages, assignments, absences) with three distributable forms from one SvelteKit codebase:

| Form | How it runs | Auth | Backend |
|---|---|---|---|
| **Desktop** (Windows/Linux via `pnpm tauri build`) | Tauri v2 webview + Rust | OAuth in system browser, `m6loapp://` deep-link callback | Rust commands in `src-tauri/` |
| **Android** (APK via `pnpm tauri android build --apk`, CI release) | Tauri v2 + Kotlin | Same OAuth deep-link | Rust + Kotlin (`SyncWorker`, JNI) |
| **Web / PWA** (live at https://jpdeerenberg.github.io/friday, self-hostable) | Static SvelteKit SPA + stateless `web-api` | School + username + password form (one login call, never stored) | `crates/web-api` (Axum, no DB, no sessions) |

Dutch UI throughout. Unofficial Magister client — see README disclaimer.

## 3. Repo map

```
src/                          SvelteKit SPA (adapter-static, SPA fallback index.html)
  routes/                     dashboard, calendar, grades, messages, assignments,
                              afwezigheid, activiteiten, bronnen, leermiddelen,
                              studiewijzers, ai-schedule, profile, settings, login
  lib/                        api.ts (Tauri invoke wrappers), backend.ts (Tauri/Web seam),
                              web-session.ts / web-tier-b.ts (web transport + aggregation),
                              stores.ts (global state), cache.ts (IndexedDB), grades/,
                              components/*.svelte (M3 design system), ai.ts, web-planner.ts
  app.css / app.html / service-worker.js / ...
static/                       icons, manifest.webmanifest (PWA, nl)
src-tauri/src/                Rust backend (Tauri v2)
  lib.rs / main.rs            command registration via generate_handler!
  commands/*.rs               activities, ai, ai_schedule, assignments, auth, bronnen,
                              calendar, diagnostics, export, grades, leermiddelen,
                              messages, studiewijzers, notifications
  models/*.rs                 PascalCase Magister JSON → snake_case (serde renames)
  client.rs                   token lifecycle + HTTP (see §5 — read before touching auth)
  auth.rs / tls.rs / secure_store.rs / jni.rs
  ai/                         attachment_reader, grade_calc, schedule, tools, providers
crates/
  magister-core/              shared protocol: auth flow, TLS, TokenSet, jsparser
  web-api/                    stateless Axum API: /health, /ping, /api/auth/*,
                              /api/magister/* proxy, AI endpoints (Dockerfile included)
  spike-password-login/       one-off login experiment, not shipped
src-tauri/gen/android/        Kotlin: MainActivity, SyncWorker, SyncAlarmReceiver,
                              SyncStateManager, NotificationHelper, DndScheduler/Receiver
Dockerfile.web / Caddyfile / docker-compose.yml   VPS self-host stack
crates/web-api/Dockerfile / render.yaml           free-tier self-host pieces
.github/workflows/
  deploy-web.yml              main → GitHub Pages (/friday/, VITE_API_URL baked at build)
  release.yml                 manual dispatch → draft GitHub release (Windows, Linux, Android)
fixes/                        diagnosis docs (e.g. FRIDAY_AUTH_LOGOUT_DIAGNOSIS.md) — read
                              the relevant one before touching auth/sync
```

## 4. Architecture & data flow

- **Routing**: custom, not file-based. `src/routes/+page.svelte` lazy-loads page components keyed by `$currentPage` store (`src/lib/stores.ts`: `currentPage`, `navigationStack`, `resumedAt`, `restoreStatus`). `+layout.svelte` owns auth-callback events and the hidden→visible resume signal.
- **Desktop/Android data path**: Svelte → `src/lib/api.ts` (`invoke()`) → Rust command (`src-tauri/src/commands/`) → `MagisterClient` (`client.rs`) → Magister REST. All commands `async`, errors are `Result<T, String>`.
- **Web data path**: Svelte → `backend.ts`/`web-session.ts` (`fetch`) → `web-api` (`/api/magister/*` Tier-A passthrough, `/api/auth/*` grants) → Magister. Tokens stay in browser IndexedDB; server holds nothing. Tier-B aggregation (grades shaping, planner) runs in TypeScript (`web-tier-b.ts`); Tier-C (auth/AI/export) has dedicated endpoints.
- **Build variants**: `BASE_PATH` env controls subpath. GitHub Pages sets `BASE_PATH=/friday`; Tauri/Caddy/dev leave it empty (root-based). `VITE_API_URL` is baked at web build time (`/api` default for same-origin Caddy, full URL for split Pages+Render hosting). `vite.config.js` proxies `/api` → `WEB_API_TARGET` (default `localhost:3000`) in dev.
- **State & caching**: global state in `src/lib/stores.ts` (writable stores, `$store` in templates). App data cached to IndexedDB via `idb` (`cacheGet`/`cacheRefresh`, 5–30 min TTL, stale-while-revalidate). Settings in `localStorage` (merge strategy). Dashboard fans out with `Promise.allSettled()` (per-section errors).
- **Styling**: Tailwind CSS 4 + Material 3 semantic tokens (`--m3-*` in `src/app.css`). Dark default, AMOLED via `.mode-amoled`. Utility-first, `@apply` sparingly. Shared primitives in `src/lib/components/` (Button, Card, Chip, Switch, …).

## 5. Auth & token lifecycle — read this before touching `client.rs`

`client.rs` is the highest-risk file in the repo. Two fixed logout bugs document the invariants (see `fixes/FRIDAY_AUTH_LOGOUT_DIAGNOSIS.md`):

- **`force_refresh(client, stale_access_token)` must keep its staleness guard.** N concurrent 401s (Dashboard fires ~6) queue on the client mutex; only the caller whose token is still live may trigger a real `refresh_token` grant. Removing the guard turns one expiry into N sequential token rotations and invites rate-limiting + races.
- **`acquire_refresh_lock` timeout is 30s — do not lower it.** The foreground app and background `SyncWorker` are separate processes sharing one rotating refresh token via the `token_refresh.lock` file. `AuthFlow::refresh_token()` has no internal timeout; a legitimate refresh under degraded network easily exceeds 5s. Failing open early causes a genuine `invalid_grant` → `restore_session()` wipes tokens (correct behavior for a dead session, catastrophic for a live one).
- Only `force_refresh` (used by lock-free `get_with_shared`/`get_bytes_with_shared`) force-expires. The `get`/`post`/`put`/`delete`/`patch` methods run under an already-held lock — leave them as-is. `jni.rs do_sync` batches one retry per sync, not per fetch.
- `TokenSet` shape/expiry lives in `magister-core` (`tokens.rs`); `client.rs` re-exports it. `TokenSetPersistence` splits secrets (OS keyring via `secure_store`) from metadata (`tokens.json`). `load_detailed()` distinguishes logged-out (`Ok(None)`) from transient store failure (`Err` → UI `unavailable`, retry, never wipe). `restore_session` wipes only on `is_rejected()` (`TokenRefreshRejected`/`NotAuthenticated`), never on transient failures.
- `GET` path is lock-free by design (`RequestContext`: clone http+token, drop lock, fetch unlocked, one forced-refresh-and-retry). Writes and OAuth stay fully serialized under the client mutex.

## 6. Android sync & DND — do not add schedulers

Two drivers, one execution path. Keep it that way:

- **Primary**: self-rescheduling `AlarmManager` exact-alarm chain (`SyncAlarmReceiver`, `setExactAndAllowWhileIdle`, re-armed at `now + interval`). **Backstop**: slow `PeriodicWorkRequest` (60 min) in case the chain is cancelled. Both funnel into `SyncWorker.doRemoteWork()` under `syncLock` + `SyncStateManager`'s `@Synchronized` read-diff-write. There is **no foreground `SyncService`** (removed deliberately). Never add a third scheduler or enqueue a `SyncWorker` on app resume — two unsynchronized writers to `sync_state.json` caused the historical duplicate/missing-notifications bug.
- **Interval floor 15 min** (`MIN_PERIODIC_INTERVAL_MILLIS`). Clamp in both `Settings.svelte` and Kotlin/Rust.
- **Exact alarms**: both sync and DND use `setExactAndAllowWhileIdle()`. On Android 13+ (`targetSdk 36`) this needs user-granted `SCHEDULE_EXACT_ALARM`; `MainActivity.onResume()` prompts once and re-arms. Without grant it falls back to inexact (Doze may defer hours). Never declare `USE_EXACT_ALARM` (Play Store risk).
- **`SyncStateManager` is a shared singleton `object`** — every read-then-write of `sync_state.json`/`cachedState` goes through its locking, no side paths.
- **JNI** (`Java_com_joris_friday_*` in `jni.rs`): one shared Tokio runtime, never per-call. `set_data_dir()` (not `AppHandle`) wires the SyncWorker's token store location.

## 7. Conventions

**Frontend (Svelte 5 / TS):** runes (`$state`/`$derived`/`$effect`), no legacy reactive `let`. API via `$lib/api.ts`, try/catch with string errors. `Promise.allSettled()` for parallel fetches. Dutch user-facing text. Sanitize remote HTML at the boundary (`sanitize.ts`, DOMPurify); every `{@html}` gets already-safe markup. Tauri events (`auth-callback`/`auth-success`/`auth-error`) listened in `$effect` with cleanup. Keep `src-tauri/src/ai/grade_calc.rs` in sync with `src/lib/grades/predictor.ts` (Rust port).

**Backend (Rust):** `#[tauri::command]`, `State<'_, SharedClient>`, `Result<T, String>`, `.map_err(|e| e.to_string())?`. Lock via `.lock().await`. Serde `PascalCase` renames; `*Response { Items: Vec<T> }` wrappers. `MagisterClient::new()` has a 30s timeout — reuse it, don't build ad-hoc clients.

**Web/API:** `web-api` stays stateless (no DB, no sessions, per-request Bearer). CORS `ALLOWED_ORIGINS` unset = permissive is intentional. Keep `/health` (JSON) and `/ping` (2-byte `OK` for size-limited uptime monitors).

**Docs:** `fixes/klaar/` holds finished fix notes; the top-level `fixes/*.md` diagnosis files are the record — don't delete them.

## 8. Versioning & commits

- Version lives in three places, bump together: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (`[[package]] name = "friday"` entry).
- Commit style: `fix(scope): … (x.y.z)` / `feat(scope): … (x.y.z)`, e.g. `fix(auth): dedupe concurrent refresh storm (2.9.5)`.
- Only commit/amend/push/PR on explicit request. Before committing: `git status`, `git diff`, stage only intended files, never commit secrets.
