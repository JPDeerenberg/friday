export interface GradeStats {
  median: number;
  stdDev: number;
  min: number;
  max: number;
  range: number;
  q1: number;
  q3: number;
}

/** Compute statistics for a set of valid grade values */
export function computeStats(values: number[]): GradeStats {
  if (values.length === 0) return { median: 0, stdDev: 0, min: 0, max: 0, range: 0, q1: 0, q3: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const min = sorted[0];
  const max = sorted[n - 1];
  const range = max - min;
  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  return { median, stdDev, min, max, range, q1, q3 };
}

export interface DistributionBucket {
  label: string;
  count: number;
  pct: number;
}

/** Distribution buckets [1-2, 2-3, ..., 9-10] */
export function getDistribution(values: number[]): DistributionBucket[] {
  const buckets = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  return buckets.map(b => {
    const count = values.filter(v => v >= b && v < b + 1).length;
    return { label: `${b}-${b + 1}`, count, pct: values.length > 0 ? (count / values.length) * 100 : 0 };
  });
}

/** Trend direction: 1 = improving, -1 = declining, 0 = stable */
export function getTrendDirection(values: number[]): number {
  if (values.length < 3) return 0;
  const recent = values.slice(-3);
  const firstHalf = recent.slice(0, 2);
  const secondHalf = recent.slice(-2);
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  const diff = avgSecond - avgFirst;
  if (diff > 0.2) return 1;
  if (diff < -0.2) return -1;
  return 0;
}

export function getTrendLabel(dir: number): string {
  return dir === 1 ? 'Stijgend 📈' : dir === -1 ? 'Dalend 📉' : 'Stabiel ➡️';
}

/** Parse a grade string using the Dutch decimal separator into a number */
export function getNumericValue(str: string): number {
  return parseFloat(str.replace(',', '.'));
}

/** Check whether a numeric grade value meets the given (insufficient) threshold */
export function isPassing(value: number, threshold: number): boolean {
  return value >= threshold;
}

/** Clamp a 1-10 grade value to a 0-100% position for progress bars. */
export function pct(value: number): number {
  if (isNaN(value)) return 0;
  return Math.min(100, Math.max(0, (value / 10) * 100));
}
