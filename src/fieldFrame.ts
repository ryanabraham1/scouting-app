import type { FieldPoint } from '@/components/FieldDiagram';

export type AllianceColor = 'red' | 'blue';

/** Infer which alliance end a robot was drawn on from its absolute field start. */
export function inferAllianceFromStart(
  start: FieldPoint | null | undefined,
): AllianceColor | null {
  if (!start || !Number.isFinite(start.x) || start.x === 0.5) return null;
  return start.x < 0.5 ? 'red' : 'blue';
}

/** 180° rotation about the field center — the red↔blue mapping. */
export function rotate180(p: FieldPoint): FieldPoint {
  return { x: 1 - p.x, y: 1 - p.y };
}

/** Put a point recorded on `from`'s side into `to`'s frame. */
export function pointToFrame(
  p: FieldPoint,
  from: AllianceColor | null,
  to: AllianceColor,
): FieldPoint {
  return from == null || from === to ? p : rotate180(p);
}
