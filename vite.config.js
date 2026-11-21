// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import adapter from "@sveltejs/adapter-static";

import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;
// Web dev: forward same-origin /api to the local web-api (default :3000).
// Harmless for Tauri dev — the desktop app never calls /api.
const webApiTarget = process.env.WEB_API_TARGET || "http://localhost:3000";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ fallback: "index.html" }),
      // Subpath hosting is optional: set BASE_PATH when the static build is
      // served from a subdirectory (e.g. self-hosted Caddy under a path).
      // Default empty (root-based): Tauri, dev, and the GitHub Pages custom
      // domain fridayapp.nl all serve from root.
      paths: {
        base: process.env.BASE_PATH
          ? /** @type {`/${string}`} */ (process.env.BASE_PATH)
          : "",
      },
    }),
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Listen on all interfaces so phones/tablets on the same Wi-Fi can
    // open the dev app (e.g. http://192.168.2.161:1420). Tauri dev is
    // unaffected — it connects via localhost anyway.
    host: "0.0.0.0",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      "/api": {
        target: webApiTarget,
        changeOrigin: true,
      },
    },
  },
}));
