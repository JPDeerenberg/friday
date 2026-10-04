/**
 * Resolve hook: remap bare `dompurify` imports to the test stub so
 * `src/lib/sanitize.ts` (and therefore `web-tier-b.ts`) loads under plain
 * `node`. Registered via test-hooks-register.ts with `node --import`.
 *
 * Plus a `load` hook for `*.md?raw` text imports (Vite `?raw` has no node
 * equivalent): serves the file content as a default-exported string so
 * `shared/ai-spec/prompt.nl.md?raw` loads in tests exactly like in the
 * bundler.
 */
import { readFile } from "node:fs/promises";

export async function resolve(
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (s: string, c?: unknown) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === "dompurify") {
    return {
      url: new URL("./dompurify-stub.ts", import.meta.url).href,
      shortCircuit: true,
    };
  }
  if (specifier.includes("?raw")) {
    const [path] = specifier.split("?");
    const resolved = await nextResolve(path, context);
    return { url: `${resolved.url}?raw`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(
  url: string,
  context: { format?: string },
  nextLoad: (
    u: string,
    c?: unknown,
  ) => Promise<{ format: string; source: unknown }>,
): Promise<{ format: string; source: unknown; shortCircuit?: boolean }> {
  if (url.endsWith("?raw")) {
    const fileUrl = url.slice(0, -"?raw".length);
    const text = await readFile(new URL(fileUrl), "utf8");
    return {
      format: "module",
      source: `export default ${JSON.stringify(text)};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
