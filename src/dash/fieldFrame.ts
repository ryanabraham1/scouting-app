// src/dash/fieldFrame.ts
// Red↔blue field symmetry. Autos are recorded in ABSOLUTE field coordinates
// (capture shows the full field: red plays the LEFT half, blue the RIGHT), so the
// SAME maneuver run on the other alliance is the 180° ROTATION of the recorded
// path about the field center — (x,y) → (1-x, 1-y) — NOT a plain horizontal flip
// (the field has rotational, not mirror, symmetry: the corner stations pair up
// diagonally). Pure geometry, no React/I-O.

import type { FieldPoint } from '@/components/FieldDiagram';

export type AllianceColor = 'red' | 'blue';

/** 180° rotation about the field center — the red↔blue mapping. */
export function rotate180(p: FieldPoint): FieldPoint {
  return { x: 1 - p.x, y: 1 - p.y };
}

/** Put a point recorded on `from`'s side into `to`'s frame (identity when equal). */
export function pointToFrame(p: FieldPoint, from: AllianceColor, to: AllianceColor): FieldPoint {
  return from === to ? p : rotate180(p);
}
