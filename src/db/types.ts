import type { FuelBurst } from '@/scoring';

export interface LocalMatchReport {
  id: string;
  schemaVersion: number;
  appVersion: string;
  deviceId: string;
  createdAt: string;
  eventKey: string;
  matchKey: string;
  scoutId: string;
  targetTeamNumber: number;
  allianceColor: 'red' | 'blue';
  station: 1 | 2 | 3;
  inactiveFirst: boolean | null;
  inactiveFirstSource: 'derived' | 'scout' | 'official' | null;
  teleopClockUnconfirmed: boolean;
  fuelBursts: FuelBurst[];
  autoFuel: number;
  teleopFuelActive: number;
  teleopFuelInactive: number;
  endgameFuel: number;
  fuelByShift: [number, number, number, number];
  fuelPoints: number;
  fuelEstimateConfidence: number;
  climbLevel: 0 | 1 | 2 | 3;
  climbAttempted: boolean;
  climbSuccess: boolean;
  autoStartPosition: { x: number; y: number } | null;
  autoPath: { x: number; y: number }[] | null;
  autoLeftStartingLine: boolean;
  autoClimbLevel1: boolean;
  intakeSources: string[];
  maxFuelCapacityObserved: number;
  defenseRating: 0 | 1 | 2 | 3;
  // Exact durations in ms (no buckets). defenseDurationMs = time this robot played
  // defense on others; defendedDurationMs = time this robot was being defended.
  defenseDurationMs: number;
  defendedDurationMs: number;
  pins: number;
  foulsMinor: number;
  foulsMajor: number;
  noShow: boolean;
  died: boolean;
  tipped: boolean;
  droppedFuel: boolean;
  fedCorral: boolean;
  notes: string;
  syncState: 'dirty' | 'pending' | 'synced' | 'error';
  rowRevision: number;
  syncAttempts: number;
  lastSyncError: string | null;
}

export interface CaptureDraft {
  draftKey: string;
  updatedAt: string;
  state: unknown;
}
