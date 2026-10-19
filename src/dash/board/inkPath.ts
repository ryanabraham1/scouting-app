// src/dash/board/inkPath.ts
// Ink shape -> filled SVG path (shape-local coords) via perfect-freehand, the
// same tessellation the Strategy-tab whiteboard uses (strokePath.ts).
// Memoized per shape object: shapes are immutable, so a WeakMap hit is exact.
import { getStroke } from 'perfect-freehand';
import { outlineToPathD } from '@/dash/strategy/strokePath';
import { inkDiameter, type InkShape } from '@/dash/board/model';

const cache = new WeakMap<InkShape, string>();

export function inkToPathD(ink: InkShape): string {
  const hit = cache.get(ink);
  if (hit !== undefined) return hit;
  const simulatePressure = ink.points.every((p) => p[2] === 0.5);
  const outline = getStroke(ink.points, {
    size: inkDiameter(ink),
    thinning: ink.highlighter ? 0 : 0.5,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: ink.highlighter ? false : simulatePressure,
    last: true,
  });
  const d = outlineToPathD(outline);
  cache.set(ink, d);
  return d;
}
