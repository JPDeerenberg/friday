import test from 'node:test';
import assert from 'node:assert';
import { calcPredicted, calcRequiredGrade, calcPredictedAverage, calcMinGradeForPass, calcAverageForGrade, calcNewOverallAverage, calcNewOverallForGrade } from './predictor.ts';

test('calcPredicted projects the end average given remaining tests', () => {
  const subject = { totalPoints: 40, totalWeight: 6 };
  const p = calcPredicted(subject, 3, 7);
  assert.strictEqual(p.totalNow, 40);
  assert.strictEqual(p.weightNow, 6);
  assert.strictEqual(p.predictedPoints, 61);
  assert.strictEqual(p.predictedWeight, 9);
  assert.ok(Math.abs(p.predictedEnd - 61 / 9) < 1e-9);
});

test('calcRequiredGrade computes the grade needed for a target average', () => {
  // current weighted avg 6.0 (60 pts / 10 weight); target 6.0 on next test (weight 1)
  const result = calcRequiredGrade({ totalPoints: 60, totalWeight: 10, targetAverage: 6.0, gradeWeight: 1, simulationGrades: [], decimalPoints: 1 });
  assert.strictEqual(result, '6.0');
});

test('calcRequiredGrade returns ? when the subject has no weight yet', () => {
  const result = calcRequiredGrade({ totalPoints: 0, totalWeight: 0, targetAverage: 6.0, gradeWeight: 1, simulationGrades: [], decimalPoints: 1 });
  assert.strictEqual(result, '?');
});

test('calcRequiredGrade includes simulated grades in the current average', () => {
  const result = calcRequiredGrade({ totalPoints: 60, totalWeight: 10, targetAverage: 6.0, gradeWeight: 1, simulationGrades: [{ value: 8, weight: 2 }], decimalPoints: 1 });
  // currentPoints = 60 + 16 = 76, currentWeight = 12; required = (6 * 13 - 76) / 1 = 2
  assert.strictEqual(result, '2.0');
});

test('calcRequiredGrade reports impossible targets', () => {
  const result = calcRequiredGrade({ totalPoints: 60, totalWeight: 10, targetAverage: 8.0, gradeWeight: 1, simulationGrades: [], decimalPoints: 1 });
  assert.strictEqual(result, 'Onmogelijk (>10)');
});

test('calcRequiredGrade clamps results below 1 to 1.0', () => {
  const result = calcRequiredGrade({ totalPoints: 90, totalWeight: 10, targetAverage: 5.5, gradeWeight: 1, simulationGrades: [], decimalPoints: 1 });
  assert.strictEqual(result, '1.0');
});

test('calcPredictedAverage computes the average including simulated grades', () => {
  const r = calcPredictedAverage({ totalPoints: 60, totalWeight: 10, simulationGrades: [{ value: 8, weight: 1 }], includeSimulation: true, decimalPoints: 1 });
  assert.strictEqual(r, '6.2');
});

test('calcPredictedAverage can exclude simulated grades', () => {
  const r = calcPredictedAverage({ totalPoints: 60, totalWeight: 10, simulationGrades: [{ value: 8, weight: 1 }], includeSimulation: false, decimalPoints: 2 });
  assert.strictEqual(r, '6.00');
});

test('calcMinGradeForPass returns the grade needed on one more test', () => {
  const r = calcMinGradeForPass({ totalPoints: 55, totalWeight: 10, threshold: 5.5 });
  assert.strictEqual(r, '5.5');
});

test('calcMinGradeForPass returns null when already passing', () => {
  const r = calcMinGradeForPass({ totalPoints: 70, totalWeight: 10, threshold: 5.5 });
  assert.strictEqual(r, null);
});

test('calcMinGradeForPass returns null when passing is impossible', () => {
  const r = calcMinGradeForPass({ totalPoints: 40, totalWeight: 10, threshold: 5.5 });
  assert.strictEqual(r, null);
});

test('calcMinGradeForPass returns null when the subject has no weight yet', () => {
  const r = calcMinGradeForPass({ totalPoints: 0, totalWeight: 0, threshold: 5.5 });
  assert.strictEqual(r, null);
});

test('calcAverageForGrade computes the new subject average after adding a grade', () => {
  const r = calcAverageForGrade({ totalPoints: 60, totalWeight: 10, grade: 8, weight: 2, decimalPoints: 1 });
  // totalP = 60 + 16 = 76, totalW = 12 → 6.333 → '6.3'
  assert.strictEqual(r, '6.3');
});

test('calcAverageForGrade handles a subject with no existing grades', () => {
  const r = calcAverageForGrade({ totalPoints: 0, totalWeight: 0, grade: 8, weight: 1, decimalPoints: 1 });
  assert.strictEqual(r, '8.0');
});

test('calcNewOverallAverage swaps a subject avg with its predicted average', () => {
  const r = calcNewOverallAverage({
    subjects: [{ name: 'Wiskunde', avg: 6 }, { name: 'Nederlands', avg: 8 }, { name: 'Engels', avg: 0 }],
    subjectName: 'Wiskunde',
    predictedAverage: '7',
    decimalPoints: 1,
  });
  assert.strictEqual(r, '7.5');
});

test('calcNewOverallAverage returns the predicted average when no other valid subjects', () => {
  const r = calcNewOverallAverage({ subjects: [{ name: 'Wiskunde', avg: 6 }], subjectName: 'Wiskunde', predictedAverage: '7.5', decimalPoints: 1 });
  assert.strictEqual(r, '7.5');
});

test('calcNewOverallForGrade swaps a subject avg with its new average', () => {
  const r = calcNewOverallForGrade({
    subjects: [{ name: 'Wiskunde', avg: 6 }, { name: 'Nederlands', avg: 8 }],
    subjectName: 'Wiskunde',
    newAverage: '6.5',
    decimalPoints: 2,
  });
  assert.strictEqual(r, '7.25');
});
