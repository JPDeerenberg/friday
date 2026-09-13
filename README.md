# Friday

Friday is a high-performance, cross-platform agenda and school management application built with Tauri v2 and Svelte 5. Designed specifically for students, it provides a seamless and lightweight experience for managing academic schedules, assignments, and grades.

---

## Key Features

- Native Performance: Lightning-fast experience on all platforms thanks to the Rust backend.
- Multi-Platform Support: Native builds for Windows (.exe), Linux (.deb/AppImage), and Android (.apk).
- Academic Hub: Comprehensive tools for managing activities, assignments, grades, and messages.
- Modern UI: Fluid, responsive interface built with Svelte 5 and Tailwind CSS.
- Deep Link Integration: Seamless authentication and redirects via custom URI schemes (`m6loapp://`).

---

## Tech Stack

- Frontend: SvelteKit (Svelte 5), Vite, Tailwind CSS 4
- Backend: Rust (Tauri v2)
- Package Manager: pnpm

---

## Getting Started

### Prerequisites

Ensure you have the following installed:

- Node.js (v20+) & pnpm (v9+)
- Rust Toolchain (Stable)
- Android SDK & JDK 17 (For Android builds)

### Installation

1.  Clone the repository:

    ```bash
    git clone https://github.com/jpdeerenberg/agenda-tauri.git
    cd agenda-tauri
    ```

2.  Install dependencies:
    ```bash
    pnpm install
    ```

### Development

Run the application in development mode:

```bash
pnpm tauri dev
```

### Building for Production

- Desktop: `pnpm tauri build`
- Android: `pnpm tauri android build --apk`

---

## Web version (iOS / browser) — self-hosting

The same SvelteKit app also runs as an installable web app (Add to Home
Screen). It needs the tiny stateless `web-api` next to it — no database, no
sessions on the server; Magister tokens stay in the browser.

**Production (any $4–6/mo VPS with Docker, one domain):**

```bash
cp .env.example .env   # fill in DOMAIN=
docker compose up -d --build
```

Caddy terminates HTTPS automatically and serves the static frontend;
`/api/*` proxies to `web-api`. Resource use is minimal (tens of MB RAM).

**Local development:**

```bash
# Terminal 1 — API on :3000
cd crates/web-api && PORT=3000 cargo run
# Terminal 2 — frontend on :1420 (reachable on your LAN for phone testing)
pnpm dev
```

Open `http://<your-lan-ip>:1420`, log in with school + Magister username +
password. The password is used for one login call only and never stored.

> Note: using an unofficial client may conflict with Magister's terms of
> service — self-hosters accept that responsibility (see also MagisterPy).

---

## Acknowledgements

This project wouldn't be possible without the inspiration and foundational work from other open-source projects.

Special thanks to Discipulus for its impressive alternative Magister client, which served as a significant inspiration for Friday's development and logic.

---

## License

This project is licensed under the MIT License. See the LICENSE file for details.
