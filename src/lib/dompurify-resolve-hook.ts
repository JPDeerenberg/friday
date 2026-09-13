/**
 * Resolve hook: remap bare `dompurify` imports to the test stub so
 * `src/lib/sanitize.ts` (and therefore `web-tier-b.ts`) loads under plain
 * `node`. Registered via test-hooks-register.ts with `node --import`.
 */
export async function resolve(
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (s: string, c?: unknown) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === "dompurify") {
    return { url: new URL("./dompurify-stub.ts", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
