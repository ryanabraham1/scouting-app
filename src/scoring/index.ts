// src/scoring/index.ts
export { SCHEMA_VERSION, SCORING } from './constants';
export type {
  MatchWindow,
  FuelBurst,
  MatchReportInputs,
  MatchReportAggregates,
} from './types';
export { SHIFT_BOUNDS, isInactive, isWindowActive, shiftNumberOf } from './windows';
export { computeAggregates } from './compute';
export { migrateUp } from './migrations';
export type { AnyReport } from './migrations';
