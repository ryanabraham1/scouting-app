// src/dash/autoScoutGeometry.ts — the math behind calibrating from the app: field meters to frame
// pixels, so a lead sees the field drawn over the picture before saving. REBUILT layout, matching
// frc-auto-scout's configs/fields/2026.yaml.

export type Point = [number, number];
export type Homography = number[];

export const FIELD = { length: 16.541, width: 8.069 };
const HUB = { blue: 4.625, red: 11.916, y: 4.035, half: 0.597 };

export const LANDMARKS: Record<string, Point> = {
  blue_hub_center: [HUB.blue, HUB.y],
  red_hub_center: [HUB.red, HUB.y],
  center_line_y0: [8.27, 0],
  center_line_yW: [8.27, FIELD.width],
};

function solve(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = a[r][col] / a[col][col];
      for (let c = col; c <= n; c += 1) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/** Maps `from` to `to`; least squares over 4+ pairs. Null when the points can't define a plane. */
export function homography(from: Point[], to: Point[]): Homography | null {
  if (from.length < 4 || from.length !== to.length) return null;
  const rows: number[][] = [];
  const values: number[] = [];
  from.forEach(([x, y], i) => {
    const [u, v] = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  });
  const normal = Array.from({ length: 8 }, (_, i) =>
    Array.from({ length: 8 }, (_unused, j) => rows.reduce((sum, row) => sum + row[i] * row[j], 0)));
  const rhs = Array.from({ length: 8 }, (_, i) => rows.reduce((sum, row, k) => sum + row[i] * values[k], 0));
  const h = solve(normal, rhs);
  return h ? [...h, 1] : null;
}

export function project(h: Homography, [x, y]: Point): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** Line sets, in field meters, to draw over the frame. */
export function fieldOutlines(): { outline: Point[]; center: Point[]; hubs: Point[][] } {
  const { length: l, width: w } = FIELD;
  const square = (cx: number): Point[] => [
    [cx - HUB.half, HUB.y - HUB.half],
    [cx + HUB.half, HUB.y - HUB.half],
    [cx + HUB.half, HUB.y + HUB.half],
    [cx - HUB.half, HUB.y + HUB.half],
  ];
  return {
    outline: [[0, 0], [l, 0], [l, w], [0, w]],
    center: [[l / 2, 0], [l / 2, w]],
    hubs: [square(HUB.blue), square(HUB.red)],
  };
}
