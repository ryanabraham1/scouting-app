// src/scoring/types.ts
export type MatchWindow =
  | 'auto'
  | 'transition'
  | 'shift1'
  | 'shift2'
  | 'shift3'
  | 'shift4'
  | 'endgame';

export interface FuelBurst {
  startMs: number;
  endMs: number;
  rate: number;
  window: MatchWindow;
}

export interface MatchReportInputs {
  schemaVersion: number;
  inactiveFirst: boolean;
  fuelBursts: FuelBurst[];
  climbLevel: 0 | 1 | 2 | 3;
  autoClimbLevel1: boolean;
}

export interface MatchReportAggregates {
  autoFuel: number;
  teleopFuelActive: number;
  teleopFuelInactive: number;
  endgameFuel: number;
  fuelByShift: [number, number, number, number];
  fuelPoints: number;
}
