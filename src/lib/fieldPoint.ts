/**
 * Normalized field coordinates (0..1 of the field image) drawn by a finger
 * arrive as full 17-digit doubles, so one auto path point serialized to ~45
 * bytes and `auto_path` alone was 65% of an event's report download (a pit
 * row's routines ran to ~18 KB). Four decimals is 0.16 mm on a 16 m field —
 * far below what any overlay can show — and roughly halves every stored path.
 * Applied on the WRITE path only; the wire/RPC shape is unchanged.
 */
export const FIELD_COORD_DECIMALS = 4;
const SCALE = 10 ** FIELD_COORD_DECIMALS;

export function roundFieldCoord(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

export function roundFieldPoint<T extends { x: number; y: number }>(point: T): T {
  return { ...point, x: roundFieldCoord(point.x), y: roundFieldCoord(point.y) };
}

export function roundFieldPath<T extends { x: number; y: number }>(
  path: T[] | null | undefined,
): T[] | null {
  if (path == null) return null;
  return path.map(roundFieldPoint);
}
