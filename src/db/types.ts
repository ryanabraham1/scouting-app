import type { FuelBurst, TimeInterval } from '@/scoring';

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
  // Balls fed to the human player / feeder station, captured on its own slider.
  feedingBursts: FuelBurst[];
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
  // Timestamped intervals backing defenseDurationMs / defendedDurationMs, so the
  // dashboard can place "playing defense" / "being defended" on a match timeline.
  defenseIntervals: TimeInterval[];
  defendedIntervals: TimeInterval[];
  pins: number;
  foulsMinor: number;
  foulsMajor: number;
  // Advisory tags for WHAT the fouls were for (keys from FOUL_REASONS). Optional:
  // legacy rows captured before this field predate it, so consumers null-guard.
  foulReasons?: string[];
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

// ---------------------------------------------------------------------------
// Offline preload cache.
//
// These rows let a scout pre-download a whole event (schedule, their
// assignments, the roster, the team list) into IndexedDB so the scout screens
// work with zero wifi. They mirror the Supabase row shapes the scout screens
// already consume, so a screen can read the cache as a drop-in offline fallback.
// ---------------------------------------------------------------------------

/** Cached `match` row — mirrors UpcomingMatchRow exactly (match_key is the PK). */
export interface CachedMatch {
  match_key: string;
  event_key: string;
  comp_level: string;
  match_number: number;
  scheduled_time: string | null;
  red1: number | null;
  red2: number | null;
  red3: number | null;
  blue1: number | null;
  blue2: number | null;
  blue3: number | null;
  actual_red_score: number | null;
  actual_blue_score: number | null;
  winner: string | null;
  result_synced_at: string | null;
}

/** Cached `assignment` row. `id` is a composite key so one scout's rows are unique. */
export interface CachedAssignment {
  id: string; // composite key `${scout_id}:${match_key}`
  scout_id: string;
  match_key: string;
  alliance_color: 'red' | 'blue';
  station: 1 | 2 | 3;
  target_team_number: number;
  event_key: string;
}

/** Cached `scouter_roster` row (global — not event-scoped). */
export interface CachedRosterScouter {
  id: string;
  name: string;
}

/** Cached event team (flattened from event_team → team). */
export interface CachedTeam {
  id: string; // composite key `${event_key}:${team_number}`
  event_key: string;
  team_number: number;
  nickname: string | null;
}

/** Bookkeeping for the last successful preload of an event (or the global roster). */
export interface PreloadMeta {
  key: string; // event_key, or the literal 'roster' for the global roster
  lastPreloadAt: string; // ISO timestamp
  counts: { matches?: number; assignments?: number; roster?: number; teams?: number };
}
