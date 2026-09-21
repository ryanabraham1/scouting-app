// src/scoring/index.ts
export { SCHEMA_VERSION, SCORING } from './constants';
export type {
  MatchWindow,
  FuelBurst,
  TimeInterval,
  MatchReportInputs,
  MatchReportAggregates,
} from './types';
export { SHIFT_BOUNDS, isInactive, isWindowActive, shiftNumberOf } from './windows';
export {
  computeAggregates,
  windowFuelNumerator,
  windowFuelTotal,
  roundFuelNumerator,
} from './compute';
export { migrateUp } from './migrations';
export type { AnyReport } from './migrations';
