import test from 'node:test';
import assert from 'node:assert';
import { computeStats, getDistribution, getTrendDirection, getTrendLabel, isPassing, pct, getNumericValue } from './stats.ts';

test('computeStats returns zeroed values for empty input', () => {
  const s = computeStats([]);
  assert.deepStrictEqual(s, { median: 0, stdDev: 0, min: 0, max: 0, range: 0, q1: 0, q3: 0 });
});

test('computeStats computes median/stdDev/min/max/range/q1/q3 for a grade set', () => {
  const values = [5.5, 6.5, 7.5, 8.5];
  const s = computeStats(values);
  assert.strictEqual(s.median, 7.0);
  assert.strictEqual(s.min, 5.5);
  assert.strictEqual(s.max, 8.5);
  assert.strictEqual(s.range, 3.0);
  assert.strictEqual(s.q1, 6.5);
  assert.strictEqual(s.q3, 8.5);
  assert.ok(Math.abs(s.stdDev - Math.sqrt(1.25)) < 1e-9);
});

test('computeStats handles odd-length sets', () => {
  const s = computeStats([6, 7, 8]);
  assert.strictEqual(s.median, 7);
  assert.strictEqual(s.stdDev, Math.sqrt(2 / 3));
});

test('getDistribution buckets values 1..10', () => {
  const dist = getDistribution([1, 2.5, 6.7, 9.9]);
  assert.strictEqual(dist.length, 9);
  assert.strictEqual(dist[0].label, '1-2');
  assert.strictEqual(dist[0].count, 1);
  assert.strictEqual(dist[1].count, 1);
  assert.strictEqual(dist[5].count, 1);
  assert.strictEqual(dist[8].count, 1);
  assert.strictEqual(dist[0].pct, 25);
});

test('getDistribution handles empty input', () => {
  const dist = getDistribution([]);
  assert.strictEqual(dist.length, 9);
  assert.ok(dist.every(b => b.count === 0 && b.pct === 0));
});

test('getTrendDirection returns 0 for fewer than 3 values', () => {
  assert.strictEqual(getTrendDirection([]), 0);
  assert.strictEqual(getTrendDirection([6]), 0);
  assert.strictEqual(getTrendDirection([6, 7]), 0);
});

test('getTrendDirection detects improving, declining and stable trends', () => {
  assert.strictEqual(getTrendDirection([5, 5, 7, 8]), 1);
  assert.strictEqual(getTrendDirection([8, 7, 5, 4]), -1);
  assert.strictEqual(getTrendDirection([6, 6.5, 6.4, 6.6]), 0);
});

test('getTrendLabel maps directions to labels', () => {
  assert.strictEqual(getTrendLabel(1), 'Stijgend 📈');
  assert.strictEqual(getTrendLabel(-1), 'Dalend 📉');
  assert.strictEqual(getTrendLabel(0), 'Stabiel ➡️');
});

test('isPassing compares a grade against the threshold', () => {
  assert.strictEqual(isPassing(6.5, 5.5), true);
  assert.strictEqual(isPassing(5.5, 5.5), true);
  assert.strictEqual(isPassing(5.4, 5.5), false);
});

test('pct clamps a 1-10 grade to a 0-100 percent position', () => {
  assert.strictEqual(pct(5), 50);
  assert.strictEqual(pct(10), 100);
  assert.strictEqual(pct(11), 100);
  assert.strictEqual(pct(-1), 0);
  assert.strictEqual(pct(NaN), 0);
});

test('getNumericValue parses the Dutch decimal separator', () => {
  assert.strictEqual(getNumericValue('7,5'), 7.5);
  assert.strictEqual(getNumericValue('8.5'), 8.5);
});
