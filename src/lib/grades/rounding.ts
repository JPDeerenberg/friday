/**
 * Rounding the way Dutch schools do it: half rounds up ("5,45 -> 5,5").
 * `Number.prototype.toFixed` does not (1.005.toFixed(2) === "1.00" and
 * 5.45.toFixed(1) === "5.5" or "5.4" depending on binary representation), so a
 * grade could show as 5.5 yet be judged insufficient.
 */

export type RoundingMode = 'decimals' | 'whole' | 'half';

/** Round half up to `decimals` places, immune to binary floating point noise. */
export function roundHalfUp(value: number, decimals = 0): number {
  if (!Number.isFinite(value)) return value;
  const f = Math.pow(10, decimals);
  // 1e-9 swallows representation error (5.4499999999 stays "5.45").
  return Math.round(value * f + (value >= 0 ? 1e-9 : -1e-9)) / f;
}

/** Round to the nearest multiple of `step` (0.5 -> halve cijfers), half up. */
export function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || step <= 0) return value;
  return roundHalfUp(value / step, 0) * step;
}

/** Apply a rounding mode and return the number. */
export function applyRounding(value: number, mode: RoundingMode, decimals: number): number {
  if (mode === 'whole') return roundHalfUp(value, 0);
  if (mode === 'half') return roundToStep(value, 0.5);
  return roundHalfUp(value, decimals);
}

/** Format for display. */
export function formatRounded(value: number, mode: RoundingMode = 'decimals', decimals = 1): string {
  if (!Number.isFinite(value)) return '-';
  const r = applyRounding(value, mode, decimals);
  if (mode === 'whole') return r.toFixed(0);
  if (mode === 'half') return r.toFixed(1);
  return r.toFixed(Math.max(0, Math.min(4, decimals)));
}

/**
 * The raw value from which a number counts as "voldoende".
 *
 * If the user judges the rounded number (what they see), then anything that
 * rounds to the threshold passes: with threshold 5.5 and 1 decimal, 5.45 shows
 * as "5.5" and must be voldoende, so the effective limit is 5.45.
 */
export function effectivePassLimit(
  threshold: number,
  judgeRounded: boolean,
  mode: RoundingMode,
  decimals: number,
): number {
  if (!judgeRounded) return threshold;
  if (mode === 'whole') return threshold - 0.5;
  if (mode === 'half') return threshold - 0.25;
  return threshold - 0.5 * Math.pow(10, -decimals);
}
