/** Subjective robot ratings use 1–10; 0 is reserved for "not rated". */
export const QUALITATIVE_RATING_MAX = 10;

export type QualitativeRating = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const QUALITATIVE_RATING_LEVELS: readonly QualitativeRating[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
];

/** Normalize persisted ratings at local read/edit boundaries. */
export function normalizeStoredRating(
  value: unknown,
  schemaVersion: number,
): QualitativeRating {
  let numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  if (schemaVersion === 1) {
    if (numeric === 1) numeric = 3;
    else if (numeric === 2) numeric = 7;
    else if (numeric === 3) numeric = 10;
  }
  return Math.max(0, Math.min(QUALITATIVE_RATING_MAX, numeric)) as QualitativeRating;
}
