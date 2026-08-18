export interface WeightedGrade {
  value: number;
  weight: number;
}

export interface GradeSubject {
  totalPoints: number;
  totalWeight: number;
}

export interface PredictionResult {
  totalNow: number;
  weightNow: number;
  predictedPoints: number;
  predictedWeight: number;
  predictedEnd: number;
}

/** Prediction helper — project the end average given remaining tests and an expected grade */
export function calcPredicted(subject: GradeSubject, remainingTests: number, expectedGrade: number): PredictionResult {
  const totalNow = subject.totalPoints || 0;
  const weightNow = subject.totalWeight || 0;
  const predictedPoints = totalNow + expectedGrade * remainingTests;
  const predictedWeight = weightNow + remainingTests;
  const predictedEnd = predictedWeight > 0 ? predictedPoints / predictedWeight : 0;
  return { totalNow, weightNow, predictedPoints, predictedWeight, predictedEnd };
}

export interface RequiredGradeInput {
  totalPoints: number;
  totalWeight: number;
  targetAverage: number;
  gradeWeight: number;
  simulationGrades: WeightedGrade[];
  decimalPoints: number;
}

/** Grade needed on the next test (weight = gradeWeight) to reach targetAverage */
export function calcRequiredGrade(input: RequiredGradeInput): string {
  if (input.totalWeight === 0) return '?';
  let simulatedPoints = 0, simulatedWeight = 0;
  for (const g of input.simulationGrades) { simulatedPoints += g.value * g.weight; simulatedWeight += g.weight; }
  const currentPoints = input.totalPoints + simulatedPoints;
  const currentWeight = input.totalWeight + simulatedWeight;
  const required = (input.targetAverage * (currentWeight + input.gradeWeight) - currentPoints) / input.gradeWeight;
  if (required > 10) return 'Onmogelijk (>10)';
  if (required < 1) return '1.0';
  return required.toFixed(input.decimalPoints);
}

export interface PredictedAverageInput {
  totalPoints: number;
  totalWeight: number;
  simulationGrades: WeightedGrade[];
  includeSimulation: boolean;
  decimalPoints: number;
}

/** Average when simulation grades are (optionally) added to the current grades */
export function calcPredictedAverage(input: PredictedAverageInput): string {
  let simulatedPoints = 0, simulatedWeight = 0;
  for (const g of input.simulationGrades) { simulatedPoints += g.value * g.weight; simulatedWeight += g.weight; }
  const totalP = input.totalPoints + (input.includeSimulation ? simulatedPoints : 0);
  const totalW = input.totalWeight + (input.includeSimulation ? simulatedWeight : 0);
  return totalW > 0 ? (totalP / totalW).toFixed(input.decimalPoints) : '0';
}

export interface MinGradeForPassInput {
  totalPoints: number;
  totalWeight: number;
  threshold: number;
}

/** Lowest grade on one more test (weight 1) to still pass, or null if moot/impossible */
export function calcMinGradeForPass(input: MinGradeForPassInput): string | null {
  if (input.totalWeight === 0) return null;
  const required = (input.threshold * (input.totalWeight + 1) - input.totalPoints) / 1;
  if (required <= 1) return null; // Already passing without any extra
  if (required > 10) return null; // Pass impossible
  return required.toFixed(1);
}

export interface AverageForGradeInput {
  totalPoints: number;
  totalWeight: number;
  grade: number;
  weight: number;
  decimalPoints: number;
}

/** New subject average after adding a single grade with a given weight */
export function calcAverageForGrade(input: AverageForGradeInput): string {
  const totalP = input.totalPoints + input.grade * input.weight;
  const totalW = input.totalWeight + input.weight;
  return totalW > 0 ? (totalP / totalW).toFixed(input.decimalPoints) : '0';
}

export interface NewOverallAverageInput {
  subjects: { name: string; avg: number }[];
  subjectName: string;
  predictedAverage: string;
  decimalPoints: number;
}

/** Overall average over valid subjects with one subject replaced by its predicted average */
export function calcNewOverallAverage(input: NewOverallAverageInput): string {
  const validSubjects = input.subjects.filter(s => s.avg > 0);
  if (validSubjects.length === 0) return input.predictedAverage;
  let totalAverages = 0;
  for (const sub of validSubjects) {
    totalAverages += sub.name === input.subjectName ? parseFloat(input.predictedAverage) : sub.avg;
  }
  return (totalAverages / validSubjects.length).toFixed(input.decimalPoints);
}

export interface NewOverallForGradeInput {
  subjects: { name: string; avg: number }[];
  subjectName: string;
  newAverage: string;
  decimalPoints: number;
}

/** Overall average over valid subjects with one subject replaced by its new average */
export function calcNewOverallForGrade(input: NewOverallForGradeInput): string {
  const validSubjects = input.subjects.filter(s => s.avg > 0);
  if (validSubjects.length === 0) return input.newAverage;
  let totalAverages = 0;
  for (const sub of validSubjects) {
    totalAverages += sub.name === input.subjectName ? parseFloat(input.newAverage) : sub.avg;
  }
  return (totalAverages / validSubjects.length).toFixed(input.decimalPoints);
}

export interface MultiSubjectTargetRow {
  name: string;
  currentAvg: number;
  remainingTests: number;
  predictedFinalAvg: number;
}

export interface MultiSubjectTargetInput {
  subjects: { name: string; totalPoints: number; totalWeight: number }[];
  targetOverall: number;
  /** Remaining tests per subject name (weight 1 each). */
  remainingTests: Record<string, number>;
}

export interface MultiSubjectTargetResult {
  /** Uniform grade needed on every remaining test to reach the target. */
  requiredGrade: number;
  achievable: boolean;
  rows: MultiSubjectTargetRow[];
  overallAfter: number;
  note: string;
}

/**
 * Multi-subject target solver: finds the grade x that a student must average on
 * all remaining tests (across all subjects) to reach an overall-average target.
 *
 * For subject i with points P_i, weight W_i and r_i remaining tests, the final
 * average if every remaining test yields x is A_i(x) = (P_i + r_i·x) / (W_i + r_i).
 * Solving (1/n)·Σ A_i(x) = target is linear in x:
 *   x = (target·n − Σ P_i/(W_i+r_i)) / Σ r_i/(W_i+r_i)
 */
export function calcMultiSubjectTarget(input: MultiSubjectTargetInput): MultiSubjectTargetResult {
  const rows = input.subjects
    .filter((s) => s.totalWeight > 0)
    .map((s) => {
      const remainingTests = Math.max(0, Math.floor(input.remainingTests[s.name] ?? 0));
      return {
        name: s.name,
        totalPoints: s.totalPoints,
        totalWeight: s.totalWeight,
        remainingTests,
        currentAvg: s.totalPoints / s.totalWeight,
      };
    });

  if (rows.length === 0) {
    return { requiredGrade: 0, achievable: false, rows: [], overallAfter: 0, note: 'Geen vakken met cijfers.' };
  }

  let sumConst = 0; // Σ P_i / (W_i + r_i)
  let sumCoef = 0;  // Σ r_i / (W_i + r_i)
  for (const r of rows) {
    const denom = r.totalWeight + r.remainingTests;
    sumConst += r.totalPoints / denom;
    sumCoef += r.remainingTests / denom;
  }

  if (sumCoef <= 0) {
    return {
      requiredGrade: 0,
      achievable: false,
      rows: rows.map((r) => ({ name: r.name, currentAvg: r.currentAvg, remainingTests: r.remainingTests, predictedFinalAvg: r.currentAvg })),
      overallAfter: rows.reduce((a, r) => a + r.currentAvg, 0) / rows.length,
      note: 'Vul bij minstens één vak resterende toetsen in.',
    };
  }

  const requiredGrade = (input.targetOverall * rows.length - sumConst) / sumCoef;
  const achievable = requiredGrade >= 1 && requiredGrade <= 10;
  const predictedRows: MultiSubjectTargetRow[] = rows.map((r) => {
    const denom = r.totalWeight + r.remainingTests;
    const predictedFinalAvg = (r.totalPoints + r.remainingTests * requiredGrade) / denom;
    return { name: r.name, currentAvg: r.currentAvg, remainingTests: r.remainingTests, predictedFinalAvg };
  });
  const overallAfter = predictedRows.reduce((a, r) => a + r.predictedFinalAvg, 0) / predictedRows.length;
  const note = achievable
    ? ''
    : requiredGrade > 10
      ? 'Niet haalbaar: er zou een cijfer boven de 10 nodig zijn.'
      : 'Niet haalbaar: er zou een cijfer onder de 1 nodig zijn.';

  return { requiredGrade, achievable, rows: predictedRows, overallAfter, note };
}
