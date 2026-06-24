// src/dash/constants.ts
// Site of record for the analytics tuning constants (contracts §9).

/** Matches-scouted needed to fully trust our scouting data over EPA. */
export const CONFIDENCE_N = 4;

/** Logistic steepness applied to the alliance score difference for win prob. */
export const WINPROB_K = 0.08;

/** Our team: never scouted (EPA-only in predictions, omitted from our auto overlay). */
export const OUR_TEAM = 3256;
