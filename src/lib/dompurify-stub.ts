/**
 * Test-only DOMPurify stand-in. The real `dompurify` needs a browser DOM at
 * import time, which plain `node` doesn't have — so unit tests remap the
 * `dompurify` specifier to this module (see test-hooks-register.ts).
 *
 * `sanitize` is deliberately marked: it prefixes output so tests can
 * prove the sanitization boundary in web-tier-b.ts is actually applied,
 * without testing DOMPurify itself (that's the browser's job).
 */
const stub = {
  sanitize: (dirty: string): string => `stub-sanitized:${dirty}`,
  addHook: (): void => undefined,
};

export default stub;
