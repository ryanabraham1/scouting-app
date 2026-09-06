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

// A timestamped activity interval (defense played / being defended), recorded in
// phase-elapsed ms with the phase it occurred in, so a per-match timeline can be
// reconstructed on the dashboard. Mirrors the FuelBurst persistence pattern.
export interface TimeInterval {
  startMs: number;
  endMs: number;
  phase: 'auto' | 'teleop';
}

export interface MatchReportInputs {
  schemaVersion: number;
  inactiveFirst: boolean;
  fuelBursts: FuelBurst[];
  climbLevel: 0 | 1 | 2 | 3;
  autoClimbLevel1: boolean;
  noShow: boolean;
}

export interface MatchReportAggregates {
  autoFuel: number;
  teleopFuelActive: number;
  teleopFuelInactive: number;
  endgameFuel: number;
  fuelByShift: [number, number, number, number];
  fuelPoints: number;
}
