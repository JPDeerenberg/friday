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
    // Subpath hosting (GitHub Pages project site at /friday/): the Pages
    // workflow sets BASE_PATH=/friday. Default empty everywhere else
    // (Tauri, Caddy same-origin, vite dev) so those outputs stay root-based.
    paths: {
      base: process.env.BASE_PATH ?? "",
    },
  },
};

export default config;
