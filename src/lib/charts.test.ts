import test from 'node:test';
import assert from 'node:assert';
import { buildSmoothPath, computeChartData, buildTrendPath } from './charts.ts';

test('buildSmoothPath returns an empty string for no points', () => {
  assert.strictEqual(buildSmoothPath([]), '');
});

test('buildSmoothPath returns a move command for a single point', () => {
  assert.strictEqual(buildSmoothPath([{ x: 10, y: 20 }]), 'M 10,20');
});

test('buildSmoothPath generates a smooth cubic path for multiple points', () => {
  const path = buildSmoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
  assert.ok(path.startsWith('M 0,0'));
  assert.ok(path.includes(' C '));
});

test('computeChartData returns null for fewer than two values', () => {
  assert.strictEqual(computeChartData([]), null);
  assert.strictEqual(computeChartData([6]), null);
});

test('computeChartData builds evenly spaced points within fixed bounds by default', () => {
  const data = computeChartData([6, 7, 8]);
  assert.ok(data);
  assert.deepStrictEqual(data.values, [6, 7, 8]);
  assert.strictEqual(data.w, 100);
  assert.strictEqual(data.h, 40);
  assert.strictEqual(data.minY, 1);
  assert.strictEqual(data.maxY, 10);
  assert.strictEqual(data.points.length, 3);
  assert.deepStrictEqual(data.points[0], { x: 0, y: 40 - ((6 - 1) / 9) * 40 });
  assert.strictEqual(data.points[1].x, 50);
});

test('computeChartData zooms bounds to the value range when zoom is enabled', () => {
  const data = computeChartData([6, 7, 8], { zoom: true });
  assert.ok(data);
  assert.strictEqual(data.minY, 5.5);
  assert.strictEqual(data.maxY, 8.5);
});

test('buildTrendPath returns an empty string for fewer than two values', () => {
  assert.strictEqual(buildTrendPath([]), '');
  assert.strictEqual(buildTrendPath([6]), '');
});

test('buildTrendPath builds a smooth path zoomed to the value range', () => {
  const path = buildTrendPath([6, 7, 8]);
  assert.ok(path.startsWith('M '));
  assert.ok(path.includes(' C '));
});
