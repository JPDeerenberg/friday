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
