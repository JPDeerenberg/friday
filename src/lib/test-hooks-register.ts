/**
 * Entry point for `node --import`: installs the resolve hook in
 * dompurify-resolve-hook.ts before the test module loads.
 *
 * Usage:
 *   node --import ./src/lib/test-hooks-register.ts src/lib/web-tier-b.test.ts
 */
import { register } from "node:module";

register("./dompurify-resolve-hook.ts", import.meta.url);
