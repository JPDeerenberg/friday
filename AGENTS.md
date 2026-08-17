# Friday — AI Agent Guidelines

See [README.md](./README.md) for general project overview and setup instructions.

---

## Build & Test

```bash
pnpm install              # Install dependencies
pnpm dev                  # Start Vite dev server (ported to 1420)
pnpm tauri dev            # Run full Tauri app in dev mode
pnpm build                # Build frontend only (Vite)
pnpm check                # Type-check (svelte-check + TypeScript)
pnpm tauri build          # Build desktop production binary
pnpm tauri android build --apk  # Build Android APK
```

- **Frontend tests**: `node src/lib/stores.test.ts` (Node.js built-in `test` module + `node:assert`)
- **Backend tests**: `cargo test` in `src-tauri/` (uses `wiremock`)

When everything is valid, update the version and Commit.

---

## Architecture

- **Frontend**: SvelteKit 5 with `@sveltejs/adapter-static` (SPA mode, fallback `index.html`), Tailwind CSS 4, Vite 6.
- **Backend**: Rust (Tauri v2) — commands registered in `src-tauri/src/lib.rs` via `generate_handler!`.
- **Routing**: Custom client-side routing via Svelte writable stores (`$currentPage`), **not** SvelteKit file-based routing. See `src/routes/+page.svelte`.
- **State**: Global state lives in `src/lib/stores.ts` (Svelte writable stores). No external state library.
- **Styling**: Tailwind CSS 4 with Material 3 semantic color tokens (`--m3-primary`, `--m3-on-primary`, etc.). Dark theme by default. AMOLED mode via `.mode-amoled` class.
- **Data flow**: Frontend calls Tauri `invoke()` (see `src/lib/api.ts`) → Rust command (see `src-tauri/src/commands/`) → Magister REST API.
- **Platforms**: Desktop (Linux/Windows) + Android. Deep link auth via `m6loapp://` scheme.
- **Android background sync**: `WorkManager` (`SyncWorker.kt`) is the sole background sync
  driver — periodic, 15-minute minimum interval (OS-enforced floor for `PeriodicWorkRequest`,
  also intentionally avoids Magister API rate limits). It calls into Rust via JNI
  (`Java_com_joris_friday_SyncWorker_runSync` in `src-tauri/src/jni.rs`) to fetch messages,
  grades, assignments, and calendar data, then diffs the result against
  `sync_state.json` (managed by `SyncStateManager.kt`) to detect what's new, and fires
  Android notifications for genuinely new items via `NotificationHelper.kt`.
  **There is no foreground `SyncService`** — it was removed because running it alongside
  `WorkManager` caused a race condition on the shared state file (duplicate/missing
  notifications) and doubled network/CPU cost for no benefit. Do not reintroduce a second,
  independently-scheduled sync driver; if background sync needs to change, change
  `SyncWorker`/`WorkManager` scheduling, not a parallel mechanism.
- **DND scheduling**: `DndScheduler.kt` reads calendar data after each sync and schedules
  precise `AlarmManager` do-not-disturb windows around lessons; `DndReceiver.kt` handles the
  on/off/safety-timeout alarms.

### Key files

| Area                     | File(s)                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| Commands (Rust)          | `src-tauri/src/commands/*.rs`                                            |
| Models (Rust)            | `src-tauri/src/models/*.rs`                                              |
| AI attachment reading    | `src-tauri/src/ai/attachment_reader.rs`                                 |
| AI grade calculations    | `src-tauri/src/ai/grade_calc.rs` (Rust port of `src/lib/grades/predictor.ts` — keep in sync) |
| Shared client            | `src-tauri/src/client.rs`                                               |
| Auth (Rust)              | `src-tauri/src/auth.rs`                                                 |
| JNI bridge (Rust ↔ Kotlin) | `src-tauri/src/jni.rs`                                                |
| API layer (TS)           | `src/lib/api.ts`                                                         |
| State (TS)               | `src/lib/stores.ts`                                                      |
| Components                | `src/lib/components/*.svelte`                                           |
| Pages                     | `src/routes/*.svelte`                                                   |
| Design tokens             | `src/app.css`                                                            |
| Android background sync  | `src-tauri/gen/android/app/src/main/java/com/joris/friday/SyncWorker.kt` |
| Android sync state/diff  | `src-tauri/gen/android/app/src/main/java/com/joris/friday/SyncStateManager.kt` |
| Android notifications    | `src-tauri/gen/android/app/src/main/java/com/joris/friday/NotificationHelper.kt` |
| Android DND scheduling   | `src-tauri/gen/android/app/src/main/java/com/joris/friday/DndScheduler.kt`, `DndReceiver.kt` |
| Android entry point      | `src-tauri/gen/android/app/src/main/java/com/joris/friday/MainActivity.kt` |

---

## Conventions

### Frontend (Svelte 5 / TypeScript)

- **Use Svelte 5 runes**: `$state()` for local state, `$derived()` for computed values, `$effect()` for side effects. Avoid legacy `let` bindings for reactive state.
- **API calls**: Import from `$lib/api.ts`. All functions are `async` and return `Promise<T>`. Wrap in try/catch; errors are strings.
- **Use `Promise.allSettled()`** for parallel data fetching with per-section error handling.
- **Stores**: Import from `$lib/stores.ts`. Subscribe with `$storeName` syntax in templates.
- **Tailwind**: Utility-first. Use `@apply` sparingly. Reference Material 3 tokens for semantic colors.
- **Caching**: Dashboard data cached to localStorage. Settings persist via `localStorage` merge strategy in stores.

### Backend (Rust)

- **Tauri commands**: Annotate `#[tauri::command]`, accept `State<'_, SharedClient>`, return `Result<T, String>`.
- **Error handling**: Use `.map_err(|e| e.to_string())?` to propagate errors as strings to the frontend.
- **Shared state**: `type SharedClient = Arc<Mutex<MagisterClient>>` — always lock with `.lock().await`.
- **Serde**: Use `#[serde(rename = "PascalCase")]` to map Magister API's PascalCase fields to Rust's snake_case.
- **Models**: Response wrappers follow `*Response { #[serde(rename = "Items")] pub items: Vec<T> }` pattern.
- **HTTP**: Use `client.get(&url).await` (reqwest wrapper) which auto-injects auth tokens and refreshes if expired.

### Android (Kotlin, `src-tauri/gen/android/`)

- **One background sync driver only**: `WorkManager`/`SyncWorker` — do not add a second
  scheduler (foreground `Service`, `AlarmManager` polling loop, etc.) alongside it. Two
  independent schedulers hitting the same state file without locking is what caused the
  unreliable-notifications bug (duplicate/missing notifications depending on timing).
- **Sync interval floor is 15 minutes** (`PeriodicWorkRequest.MIN_PERIODIC_INTERVAL_MILLIS`).
  Any UI or command that sets a sync interval must clamp to this minimum in both the
  frontend (`Settings.svelte`) and the Kotlin/Rust layer — don't trust a single clamp point.
- **`SyncStateManager` is a shared singleton `object`** read/written from background sync
  work. Any code path that reads-then-writes `sync_state.json` (or the in-memory
  `cachedState` field) must go through its existing locking — don't add a second code path
  that touches that file directly.
- **JNI native methods** (`Java_com_joris_friday_*`) live in `src-tauri/src/jni.rs`; the
  Rust side reuses one Tokio runtime rather than constructing a new one per call — keep it
  that way when adding new native calls.

### General

- **Language**: Dutch (UI text, API interactions with Magister).
- **Events**: Tauri events for auth flow (`auth-callback`, `auth-success`, `auth-error`). Listen in `$effect`, unsubscribe on cleanup.
- **Packages**: Use `pnpm` (not npm/yarn). Rust deps in `src-tauri/Cargo.toml`.
