export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartData {
  values: number[];
  minY: number;
  maxY: number;
  points: ChartPoint[];
  w: number;
  h: number;
}

export interface ChartDataOptions {
  w?: number;
  h?: number;
  minY?: number;
  maxY?: number;
  zoom?: boolean;
}

/** Build a smooth SVG path from [x,y] points using monotone cubic interpolation */
export function buildSmoothPath(points: ChartPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x},${points[0].y}`;
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const tension = 0.3;
    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = p2.y - (p3.y - p1.y) * tension;
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

/** Compute chart bounds and evenly-spaced points for a set of grade values */
export function computeChartData(values: number[], opts: ChartDataOptions = {}): ChartData | null {
  if (values.length < 2) return null;
  const w = opts.w ?? 100;
  const h = opts.h ?? 40;
  let minY = opts.minY ?? 1;
  let maxY = opts.maxY ?? 10;
  if (opts.zoom) {
    minY = Math.max(minY, Math.min(...values) - 0.5);
    maxY = Math.min(maxY, Math.max(...values) + 0.5);
  }
  const range = maxY - minY || 1;
  const stepX = values.length > 1 ? w / (values.length - 1) : w / 2;
  const points = values.map((v, i) => ({
    x: i * stepX,
    y: h - ((v - minY) / range) * h
  }));
  return { values, minY, maxY, points, w, h };
}

/** Build a smooth overall-trend SVG path for grade values, zoomed to their range */
export function buildTrendPath(values: number[], opts: { w?: number; h?: number } = {}): string {
  if (values.length < 2) return '';
  const w = opts.w ?? 300;
  const h = opts.h ?? 100;
  const minVal = Math.max(1, Math.min(...values) - 0.5);
  const maxVal = Math.min(10, Math.max(...values) + 0.5);
  const range = maxVal - minVal || 1;
  const count = values.length;
  const stepX = count > 1 ? w / (count - 1) : w / 2;
  const offsetX = count > 1 ? 0 : w / 4;
  const points = values.map((v, i) => ({
    x: i * stepX + offsetX,
    y: h - ((v - minVal) / range) * h
  }));
  return buildSmoothPath(points);
}
