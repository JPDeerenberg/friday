import test from 'node:test';
import assert from 'node:assert';
import { roundHalfUp, roundToStep, formatRounded, effectivePassLimit } from './rounding.ts';

test('roundHalfUp rounds .5 up and survives floating point noise', () => {
  assert.strictEqual(roundHalfUp(5.45, 1), 5.5);
  assert.strictEqual(roundHalfUp(1.005, 2), 1.01);
  assert.strictEqual(roundHalfUp(5.449999, 1), 5.4);
  assert.strictEqual(roundHalfUp(5.5, 0), 6);
  assert.strictEqual(roundHalfUp(0.15 + 0.3, 1), 0.5);
});

test('roundToStep gives halve cijfers', () => {
  assert.strictEqual(roundToStep(6.74, 0.5), 6.5);
  assert.strictEqual(roundToStep(6.75, 0.5), 7);
});

test('formatRounded handles all modes', () => {
  assert.strictEqual(formatRounded(5.45, 'decimals', 1), '5.5');
  assert.strictEqual(formatRounded(5.45, 'decimals', 0), '5');
  assert.strictEqual(formatRounded(5.5, 'whole', 1), '6');
  assert.strictEqual(formatRounded(6.3, 'half', 1), '6.5');
  assert.strictEqual(formatRounded(NaN), '-');
});

test('effectivePassLimit: judging the rounded number lowers the limit', () => {
  assert.strictEqual(effectivePassLimit(5.5, false, 'decimals', 1), 5.5);
  assert.ok(Math.abs(effectivePassLimit(5.5, true, 'decimals', 1) - 5.45) < 1e-9);
  assert.strictEqual(effectivePassLimit(5.5, true, 'whole', 1), 5);
  assert.strictEqual(effectivePassLimit(5.5, true, 'half', 1), 5.25);
  // 5.45 shows as 5.5 with 1 decimal -> must pass when judging the rounded value
  assert.ok(5.45 >= effectivePassLimit(5.5, true, 'decimals', 1) - 1e-9);
});
