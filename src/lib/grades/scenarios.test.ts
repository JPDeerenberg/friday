import test from 'node:test';
import assert from 'node:assert';
import { bestWorstCase, testsNeeded, effortToPass } from './scenarios.ts';

test('bestWorstCase spans the reachable range', () => {
  const r = bestWorstCase({ totalPoints: 60, totalWeight: 10 }, 5)!;
  assert.strictEqual(r.current, 6);
  assert.ok(Math.abs(r.worst - (60 + 5) / 15) < 1e-9);
  assert.ok(Math.abs(r.best - (60 + 50) / 15) < 1e-9);
  assert.strictEqual(r.weightAfter, 15);
});

test('bestWorstCase edge cases', () => {
  assert.strictEqual(bestWorstCase({ totalPoints: 0, totalWeight: 0 }, 0), null);
  const noGrades = bestWorstCase({ totalPoints: 0, totalWeight: 0 }, 2)!;
  assert.strictEqual(noGrades.current, null);
  assert.strictEqual(noGrades.worst, 1);
  assert.strictEqual(noGrades.best, 10);
});

test('testsNeeded counts tests at a given grade', () => {
  const s = { totalPoints: 50, totalWeight: 10 }; // avg 5.0
  // 2 tests of 8: (50+16)/12 = 5.5 -> exactly the target
  assert.strictEqual(testsNeeded(s, 5.5, 8), 2);
  // 1 test of 8: 58/11 = 5.27 -> not enough
  assert.ok((50 + 8) / 11 < 5.5);
  assert.strictEqual(testsNeeded(s, 5.0, 3), 0); // already there
  assert.strictEqual(testsNeeded(s, 6, 5.5), null); // a grade below the target can never lift the average to it
  assert.strictEqual(testsNeeded(s, 6, 10, 1, 1), null); // needs more tests than the cap allows? 1 test of 10 = 60/11 < 6
});

test('effortToPass lists failing subjects, cheapest rescue first, infeasible last', () => {
  const rows = effortToPass(
    [
      { name: 'wi', totalPoints: 50, totalWeight: 10 },   // 5.0 -> next must be (5.5*11-50)/1 = 10.5 ... infeasible
      { name: 'en', totalPoints: 55, totalWeight: 10 },   // 5.5 passes
      { name: 'ne', totalPoints: 53, totalWeight: 10 },   // 5.3 -> (60.5-53)=7.5
      { name: 'bi', totalPoints: 50, totalWeight: 9 },    // 5.55 passes
      { name: 'ak', totalPoints: 52, totalWeight: 10 },   // 5.2 -> 8.5
    ],
    5.5,
    1,
  );
  assert.deepStrictEqual(rows.map((r) => r.name), ['ne', 'ak', 'wi']);
  assert.ok(Math.abs(rows[0].required - 7.5) < 1e-9);
  assert.strictEqual(rows[2].feasible, false);
});

test('effortToPass ignores subjects without weight', () => {
  assert.deepStrictEqual(effortToPass([{ name: 'x', totalPoints: 0, totalWeight: 0 }], 5.5), []);
});
