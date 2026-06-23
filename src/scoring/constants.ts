// src/scoring/constants.ts
export const SCHEMA_VERSION = 1;

export const SCORING = {
  FUEL_POINTS: 1,
  CLIMB: {
    1: { auto: 15, teleop: 10 },
    2: { auto: 0, teleop: 20 },
    3: { auto: 0, teleop: 30 },
  },
} as const;
// VALUES FLAGGED FOR VERIFICATION against the PDF before Phase 2 (spec §18).
// Golden tests assert LOGIC, not these magnitudes.
