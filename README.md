# Friday — Magister app (desktop, Android & web)

Friday is an unofficial, open-source Magister client for students: agenda, cijfers, berichten, huiswerk, afwezigheid and more — in one fast, dark, Dutch app.

- **Try the web version now:** **https://jpdeerenberg.github.io/friday** — works in any modern browser, installable as an app (Add to Home Screen, also on iOS). Log in with your school + Magister username + password.
- **Native apps:** download Windows, Linux and Android builds from [GitHub Releases](https://github.com/JPDeerenberg/agenda-tauri/releases).

> ⚠️ **Disclaimer:** Friday is an unofficial client and is not affiliated with Magister or Iddink. Using it may conflict with your school's or Magister's terms of service — you are responsible for that choice. Your password is only ever used for the single login call and is never stored (see [How login works](#how-login-works)).

---

## What Friday does

- **Agenda** — day/week overview, between-hours insight, current-time line
- **Cijfers** — per-subject and recent grades, SE/CE overview, average & pass/fail stats, grade calculator with predictions
- **Berichten** — inbox, folders, rich-text composing and attachments
- **Opdrachten** — homework/tests, deadlines, submitted status
- **Afwezigheid, activiteiten, bronnen, leermiddelen, studiewijzers** — the rest of Magister, in the same UI
- **AI assistant + Friday's Plan** — chat over your school data (read-only tools + confirm-before-write) and automatic study planning from your agenda and deadlines (opt-in, needs an API key)
- **Exports** — agenda/grades export (incl. Android share to Downloads)
- **Android extras** — background sync with grade/homework notifications and automatic Do-Not-Disturb around lessons
- **Offline-friendly** — short-lived cache with stale-while-revalidate, so reopening the app feels instant

---

## Use the hosted web version

The link above runs entirely as a static site + a tiny stateless API:

1. Open **https://jpdeerenberg.github.io/friday**.
2. Pick your school, enter your Magister username + password, log in.
3. Optional: _Share → Add to Home Screen_ for a fullscreen PWA experience.

How your data is handled there: the frontend talks to `https://friday-api-n772.onrender.com/api` (Render free tier). The server keeps **no database and no sessions** — it only forwards your requests to Magister. Your tokens live in **your browser's IndexedDB**, your password is used for the one login call and then discarded.


---

## Host it yourself

You have two options. Both use the same code in this repo; pick one.

### Option A — full stack on a VPS (recommended, ~€4–6/mo)

Frontend + API on one machine, one domain, automatic HTTPS via Caddy. The server holds nothing — no database or volumes needed.

```bash
cp .env.example .env   # set DOMAIN=friday.example.com
docker compose up -d --build
```

- Caddy serves the static SvelteKit build and proxies `/api/*` to `web-api` on the same origin.
- Requirements: a VPS with ports 80/443 open and a DNS A-record pointing at it.
- Update later with `docker compose pull && docker compose up -d --build`.

| Variable | Required | What it does |
|---|---|---|
| `DOMAIN` | yes | Bare domain (no scheme); Caddy provisions/renews HTTPS for it |
| `ALLOWED_ORIGINS` | no | Comma-separated origins allowed to call the API. Unset = permissive, which is safe because auth is per-request Bearer headers, never cookies |
| `RUST_LOG` | no | Log verbosity for `web-api` (default `info`) |

### Option B — free tier (GitHub Pages + Render, $0)

Split hosting: static frontend on Pages, API on Render.

1. **API:** in Render, _Blueprints → New_, point it at your fork — `render.yaml` in the repo root defines a free Frankfurt Docker service (`dockerfilePath: ./crates/web-api/Dockerfile`, health check `/health`). Note the public URL, e.g. `https://friday-api-xyz.onrender.com`.
2. **Frontend:** fork the repo, enable Pages (Settings → Pages → _Deploy from a branch_, `gh-pages`). The `deploy-web.yml` workflow builds on every `main` push with `BASE_PATH=/friday` and bakes in the API URL.
3. Set the API URL via repo Settings → _Variables → Actions_ → `VITE_API_URL=https://<your-service>.onrender.com/api`. Without it, the build falls back to the default in `deploy-web.yml`.
4. Your app is live at `https://<you>.github.io/friday/`.

To move the Render region later you must recreate the service (Render forbids changing region afterwards) — Frankfurt is closest to Magister (NL).

---

## Local development

Prerequisites: **Node 20+**, **pnpm 9+**, **stable Rust**. Android APKs additionally need the **Android SDK + JDK 17**.

```bash
pnpm install          # frontend deps (pnpm only — not npm/yarn)

# Desktop app (Tauri: webview + Rust backend)
pnpm tauri dev

# Web app (two terminals):
cd crates/web-api && PORT=3000 cargo run   # API on :3000
pnpm dev                                   # frontend on :1420, LAN-reachable for phone testing
```

Open `http://<your-lan-ip>:1420` on your phone, log in with school + username + password.

Useful commands:

```bash
pnpm build                      # static frontend build → build/
pnpm check                      # svelte-kit sync + svelte-check type-check
pnpm test                       # frontend tests (node built-in runner, 6 files)
pnpm tauri build                # desktop production binary
pnpm tauri android build --apk  # Android APK
cd src-tauri && cargo check --lib   # fast Rust check (~30s)
cd src-tauri && cargo test --lib    # Rust tests (wiremock; full build takes minutes)
```

Releases are built by CI (`release.yml`, manual dispatch → draft GitHub release with Windows, Linux and Android artifacts; `deploy-web.yml` ships `main` to Pages without touching the release flow).

---

## How it's built

One SvelteKit codebase (Svelte 5 runes, Tailwind 4, Material-3 tokens), three distributable forms:

```
Browser / PWA ──fetch──▶ crates/web-api (Axum, stateless) ──▶ Magister REST
Desktop / Android ──invoke──▶ src-tauri (Tauri v2 commands) ──▶ Magister REST
```

- **Routing** is custom (`$currentPage` store, lazy-loaded pages), not SvelteKit file routing — one SPA shell in `src/routes/+page.svelte`.
- **State** lives in `src/lib/stores.ts`; app data is cached in IndexedDB (5–30 min TTL, stale-while-revalidate), settings in `localStorage`.
- **Desktop/Android data path:** Svelte → `src/lib/api.ts` (`invoke`) → Rust command in `src-tauri/src/commands/*` → `MagisterClient` → Magister REST.
- **Web data path:** Svelte → `backend.ts`/`web-session.ts` (`fetch`) → `web-api` Tier-A passthrough (`/api/magister/*`) or dedicated auth/AI endpoints; grades/planner aggregation runs in TypeScript (`web-tier-b.ts`).

### How login works

| App | Flow |
|---|---|
| Desktop / Android | OAuth in the system browser, `m6loapp://` deep-link callback; tokens in the OS keyring (`secure_store`), metadata in `tokens.json` |
| Web | School + username + password form → one `/api/auth/login` call; tokens in browser IndexedDB; the server stores nothing |

Refresh tokens rotate (single-use). The Rust client deduplicates concurrent refreshes (Dashboard fans out ~6 requests on resume) and serializes foreground-app vs Android `SyncWorker` refreshes through a 30s cross-process file lock — otherwise the loser gets a genuine `invalid_grant` and is logged out.

### Project layout

```
src/                 SvelteKit SPA — routes/* (dashboard, calendar, grades, messages,
                     assignments, afwezigheid, …), lib/* (api, stores, cache, ai, planner)
static/              icons + PWA manifest
src-tauri/src/       Rust backend — commands/*, models/*, client.rs (tokens+HTTP),
                     auth.rs, tls.rs, secure_store.rs, ai/*, jni.rs
src-tauri/gen/android/  Kotlin — MainActivity, SyncWorker, SyncAlarmReceiver,
                        SyncStateManager, NotificationHelper, DndScheduler/Receiver
crates/magister-core/   shared protocol (auth flow, TLS, TokenSet)
crates/web-api/         stateless Axum API (/health, /ping, /api/auth/*, /api/magister/*)
Dockerfile.web / Caddyfile / docker-compose.yml    VPS stack
crates/web-api/Dockerfile / render.yaml            free-tier pieces
.github/workflows/     deploy-web.yml (Pages), release.yml (desktop+Android)
```

---

## Contributing

Issues and PRs are welcome — this is a one-maintainer student project, so small, focused PRs land fastest.

1. Fork, create a branch, `pnpm install`.
2. Match the existing style: Svelte 5 runes, Tailwind utility-first with `--m3-*` tokens, Dutch UI text, `Promise.allSettled()` for parallel fetches, Rust commands as `#[tauri::command] … -> Result<T, String>`.
3. Run the checks for what you touched: `pnpm check`, `pnpm test`, and/or `cargo check --lib` / `cargo test --lib` in `src-tauri/`.
4. Keep the Rust↔TS mirrors in sync (`ai/grade_calc.rs` ↔ `lib/grades/predictor.ts`) and never weaken the auth invariants in `client.rs` (see `AGENTS.md` §5 and the diagnosis doc above).
5. Bump the version in all three places (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`) and use `fix(scope): … (x.y.z)` / `feat(scope): … (x.y.z)` commit messages.

`AGENTS.md` in the repo root is the detailed reference for AI coding agents (architecture, Android sync rules, auth pitfalls) — worth skimming even as a human contributor.

---

## Acknowledgements

- [Discipulus](https://github.com/Discipulus) — alternative Magister client that heavily inspired Friday's development and logic.
- [MagisterPy](https://github.com/magisterpy) — prior art on the unofficial Magister API (self-hosters share the same ToS responsibility).

## License

MIT — see [LICENSE](./LICENSE). Copyright © 2024 Joris Deerenberg.
