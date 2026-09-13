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
  plugins: [tailwindcss(), sveltekit()],

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
