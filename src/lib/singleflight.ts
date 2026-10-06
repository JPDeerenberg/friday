/**
 * Single-flight + min-interval gate for dashboard-style page loaders.
 *
 * - `shouldRefresh(lastSuccessAt, now, minIntervalMs)`: pure predicate —
 *   true on first load (null) or when the last success is older than the
 *   interval. Keeps resume refreshes from re-firing within 45 s of a good load.
 * - `createSingleFlight()`: collapses concurrent calls into one shared
 *   in-flight promise. A call made while one is running returns the same
 *   promise instead of firing another network fan-out.
 */

export const DASHBOARD_MIN_INTERVAL_MS = 45_000;

export function shouldRefresh(
  lastSuccessAt: number | null,
  now: number,
  minIntervalMs: number = DASHBOARD_MIN_INTERVAL_MS,
): boolean {
  if (lastSuccessAt === null || lastSuccessAt === undefined) return true;
  return now - lastSuccessAt >= minIntervalMs;
}

export function createSingleFlight<T>() {
  let inFlight: Promise<T> | null = null;
  return {
    get hasInFlight(): boolean {
      return inFlight !== null;
    },
    run(fn: () => Promise<T>): Promise<T> {
      if (inFlight) return inFlight;
      inFlight = fn().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    /** Test-only: force-clear the in-flight slot. */
    _reset(): void {
      inFlight = null;
    },
  };
}

export type SingleFlight<T> = ReturnType<typeof createSingleFlight<T>>;
