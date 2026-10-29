// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    // Subpath hosting is optional: set BASE_PATH when the static build is
    // served from a subdirectory (e.g. self-hosted Caddy under a path).
    // Default empty (root-based): Tauri, dev, and the GitHub Pages custom
    // domain fridayapp.nl all serve from root.
    paths: {
      base: process.env.BASE_PATH ?? "",
    },
  },
};

export default config;
