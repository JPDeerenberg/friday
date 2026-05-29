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

---

## Architecture

- **Frontend**: SvelteKit 5 with `@sveltejs/adapter-static` (SPA mode, fallback `index.html`), Tailwind CSS 4, Vite 6.
- **Backend**: Rust (Tauri v2) — commands registered in `src-tauri/src/lib.rs` via `generate_handler!`.
- **Routing**: Custom client-side routing via Svelte writable stores (`$currentPage`), **not** SvelteKit file-based routing. See `src/routes/+page.svelte`.
- **State**: Global state lives in `src/lib/stores.ts` (Svelte writable stores). No external state library.
- **Styling**: Tailwind CSS 4 with Material 3 semantic color tokens (`--m3-primary`, `--m3-on-primary`, etc.). Dark theme by default. AMOLED mode via `.mode-amoled` class.
- **Data flow**: Frontend calls Tauri `invoke()` (see `src/lib/api.ts`) → Rust command (see `src-tauri/src/commands/`) → Magister REST API.
- **Platforms**: Desktop (Linux/Windows) + Android. Deep link auth via `m6loapp://` scheme.

### Key files

| Area            | File(s)                       |
| --------------- | ----------------------------- |
| Commands (Rust) | `src-tauri/src/commands/*.rs` |
| Models (Rust)   | `src-tauri/src/models/*.rs`   |
| Shared client   | `src-tauri/src/client.rs`     |
| Auth (Rust)     | `src-tauri/src/auth.rs`       |
| API layer (TS)  | `src/lib/api.ts`              |
| State (TS)      | `src/lib/stores.ts`           |
| Components      | `src/lib/components/*.svelte` |
| Pages           | `src/routes/*.svelte`         |
| Design tokens   | `src/app.css`                 |

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

### General

- **Language**: Dutch (UI text, API interactions with Magister).
- **Events**: Tauri events for auth flow (`auth-callback`, `auth-success`, `auth-error`). Listen in `$effect`, unsubscribe on cleanup.
- **Packages**: Use `pnpm` (not npm/yarn). Rust deps in `src-tauri/Cargo.toml`.
