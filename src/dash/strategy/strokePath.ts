// src/dash/strategy/strokePath.ts
// Stroke → SVG path tessellation for the field whiteboard. perfect-freehand
// turns an input polyline into a pressure-tapered OUTLINE polygon; this module
// converts that outline into a filled `<path d>` string. Kept separate from
// strokes.ts (pure model) so the model stays dependency-free.
//
// IMPORTANT geometry note: the whiteboard SVG uses an ASPECT-TRUE viewBox
// (`0 0 3902 1584`, the field image's pixel size) — NOT FieldDiagram's
// `0 0 1 1` + preserveAspectRatio="none". A filled outline polygon under that
// nonuniform scale would render ~2.5× wider vertically than horizontally, so
// strokes are tessellated in image-pixel space instead.

import { getStroke } from 'perfect-freehand';
import { FIELD_W, FIELD_H, type Stroke } from '@/dash/strategy/strokes';

/** Standard perfect-freehand outline → SVG path (quadratic midpoint smoothing). */
export function outlineToPathD(outline: number[][]): string {
  if (outline.length < 2) return '';
  let d = `M${outline[0][0].toFixed(1)},${outline[0][1].toFixed(1)}Q`;
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    d += `${x0.toFixed(1)},${y0.toFixed(1)} ${((x0 + x1) / 2).toFixed(1)},${((y0 + y1) / 2).toFixed(1)} `;
  }
  return `${d}Z`;
}

/**
 * Tessellate a stroke into a filled SVG path in field-image pixel space.
 * `simulatePressure` is derived: real pen input records varying pressure, touch/
 * mouse input records the 0.5 default and gets velocity-based tapering instead.
 */
export function strokeToPathD(stroke: Stroke): string {
  const pts = stroke.points.map((p) => [p[0] * FIELD_W, p[1] * FIELD_H, p[2]]);
  const simulatePressure = stroke.points.every((p) => p[2] === 0.5);
  const outline = getStroke(pts, {
    size: Math.max(1, stroke.size * FIELD_H),
    thinning: 0.45,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure,
    last: true,
  });
  return outlineToPathD(outline);
}

/** Same tessellation for the LIVE (in-progress) stroke — `last: false` keeps
 *  the trailing cap open so the line doesn't pinch while drawing. */
export function livePathD(
  points: [number, number, number][],
  size: number,
): string {
  if (points.length === 0) return '';
  const pts = points.map((p) => [p[0] * FIELD_W, p[1] * FIELD_H, p[2]]);
  const simulatePressure = points.every((p) => p[2] === 0.5);
  const outline = getStroke(pts, {
    size: Math.max(1, size * FIELD_H),
    thinning: 0.45,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure,
    last: false,
  });
  return outlineToPathD(outline);
}
