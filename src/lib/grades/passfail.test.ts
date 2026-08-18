import test from 'node:test';
import assert from 'node:assert';
import { checkPassFail, roundEindcijfer } from './passfail.ts';

test('roundEindcijfer rounds half up (0,5 en hoger naar boven)', () => {
  assert.strictEqual(roundEindcijfer(5.4), 5);
  assert.strictEqual(roundEindcijfer(5.5), 6);
  assert.strictEqual(roundEindcijfer(6.4), 6);
  assert.strictEqual(roundEindcijfer(3.5), 4);
});

test('a clean set of passing grades passes the checker', () => {
  const result = checkPassFail({
    subjects: [
      { name: 'Nederlands', avg: 7 },
      { name: 'Engels', avg: 7 },
      { name: 'Wiskunde', avg: 7 },
      { name: 'Geschiedenis', avg: 7 },
      { name: 'Economie', avg: 7 },
    ],
  });
  assert.strictEqual(result.overall, 'ok');
  const kern = result.checks.find((c) => c.id === 'kernvakken');
  assert.strictEqual(kern?.status, 'ok');
  const comp = result.checks.find((c) => c.id === 'compensatie');
  assert.strictEqual(comp?.status, 'ok');
});

test('a 3.5 in Dutch fails the kernvakkenregel', () => {
  const result = checkPassFail({
    subjects: [
      { name: 'Nederlands', avg: 3.5 },
      { name: 'Engels', avg: 7 },
      { name: 'Wiskunde', avg: 7 },
      { name: 'Geschiedenis', avg: 7 },
    ],
  });
  assert.strictEqual(result.overall, 'fail');
  const kern = result.checks.find((c) => c.id === 'kernvakken');
  assert.strictEqual(kern?.status, 'fail');
});

test('two 5s with average below 6.0 fail the compensatieregel', () => {
  const result = checkPassFail({
    subjects: [
      { name: 'Nederlands', avg: 6.4 }, // rounds to 6
      { name: 'Engels', avg: 6.4 }, // rounds to 6
      { name: 'Wiskunde', avg: 5.4 }, // rounds to 5
      { name: 'Geschiedenis', avg: 5.4 }, // rounds to 5
    ],
  });
  assert.strictEqual(result.overall, 'fail');
  const comp = result.checks.find((c) => c.id === 'compensatie');
  assert.strictEqual(comp?.status, 'fail');
});

test('two 5s with average >= 6.0 pass the compensatieregel', () => {
  const result = checkPassFail({
    subjects: [
      { name: 'Nederlands', avg: 7 },
      { name: 'Engels', avg: 7 },
      { name: 'Wiskunde', avg: 5.4 }, // rounds to 5
      { name: 'Geschiedenis', avg: 5.4 }, // rounds to 5
      { name: 'Economie', avg: 8.4 }, // rounds to 8
    ],
  });
  // finals: 7,7,5,5,8 → avg 6.4 ≥ 6.0 → compensatieregel ok
  const comp = result.checks.find((c) => c.id === 'compensatie');
  assert.strictEqual(comp?.status, 'ok');
});

test('a final grade below 4 fails the no-below-4 check', () => {
  const result = checkPassFail({
    subjects: [
      { name: 'Nederlands', avg: 6 },
      { name: 'Engels', avg: 6 },
      { name: 'Wiskunde', avg: 6 },
      { name: 'Biologie', avg: 3.4 }, // rounds to 3
    ],
  });
  const belowFour = result.checks.find((c) => c.id === 'geen-onder-4');
  assert.strictEqual(belowFour?.status, 'fail');
  assert.strictEqual(result.overall, 'fail');
});

test('provided CE grades below 5.5 fail the CE-average check', () => {
  const result = checkPassFail({
    subjects: [
      { name: 'Nederlands', avg: 7, ceGrade: 5 },
      { name: 'Engels', avg: 7, ceGrade: 5 },
      { name: 'Wiskunde', avg: 7, ceGrade: 5 },
    ],
  });
  const ce = result.checks.find((c) => c.id === 'ce-gemiddelde');
  assert.strictEqual(ce?.status, 'fail');
  assert.strictEqual(result.overall, 'fail');
});

test('missing CE grades stay unknown but do not fail the overall verdict', () => {
  const result = checkPassFail({ subjects: [{ name: 'Nederlands', avg: 7 }] });
  const ce = result.checks.find((c) => c.id === 'ce-gemiddelde');
  assert.strictEqual(ce?.status, 'unknown');
  assert.strictEqual(result.overall, 'ok');
});

test('LO toggle drives the LO check', () => {
  const bad = checkPassFail({ subjects: [{ name: 'Nederlands', avg: 7 }], loVoldoende: false });
  assert.strictEqual(bad.checks.find((c) => c.id === 'lo')?.status, 'fail');
  assert.strictEqual(bad.overall, 'fail');

  const good = checkPassFail({ subjects: [{ name: 'Nederlands', avg: 7 }], loVoldoende: true });
  assert.strictEqual(good.checks.find((c) => c.id === 'lo')?.status, 'ok');
});