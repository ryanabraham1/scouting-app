import type { FuelBurst, TimeInterval } from '@/scoring';
import type { Stroke, RobotPos } from '@/dash/strategy/strokes';
import type { QualitativeRating } from '@/ratings';

export interface LocalMatchReport {
  id: string;
  schemaVersion: number;
  appVersion: string;
  deviceId: string;
  createdAt: string;
  eventKey: string;
  matchKey: string;
  scoutId: string;
  // The scout's display name at capture time. Sent to the server so an upsert
  // whose scout_id was orphaned (e.g. select_scouter consolidation deleted that
  // row when the same name was picked on another device) can re-resolve to the
  // surviving canonical row by name instead of dead-lettering. Optional: reports
  // captured before this field lack it (the server then provisions a row).
  scoutName?: string;
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
  defenseRating: QualitativeRating;
  // Subjective super-scout ratings (0 = not rated, 1–10 scale). Advisory only —
  // never scored. Optional: reports captured before this field (pre-0039) lack
  // it, so consumers default to 0.
  driverSkill?: QualitativeRating;
  agility?: QualitativeRating;
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
  // Client-side mirror of the server `row_revision`. New reports start at 1; a
  // correction (edit + resubmit) MUST set it to the previously-loaded revision + 1
  // so the revision-guarded `upsert_match_report` UPDATEs the existing row rather
  // than no-opping. Note: `markSynced` does NOT copy the server revision back, so
  // `loaded` is the last value THIS client sent; it stays monotonic provided
  // nothing bumps this row's server revision out-of-band (a supersede bumps a
  // DIFFERENT row, so it's safe). No wire-shape change.
  rowRevision: number;
  syncAttempts: number;
  lastSyncError: string | null;
  /** Persisted retry schedule; omitted on legacy rows and cleared after success/edit. */
  nextSyncAt?: number | null;
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

/** Cached team-level pit assignment for one scout. */
export interface CachedPitAssignment {
  id: string; // many-to-many key `${event_key}:${team_number}:${scout_id}`
  event_key: string;
  team_number: number;
  scout_id: string;
  scout_name?: string | null;
  source: 'manual' | 'auto';
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

/** Bookkeeping for the last successful preload of an event. */
export interface PreloadMeta {
  key: string; // event_key (the roster is folded into each event's preload + counts)
  lastPreloadAt: string; // ISO timestamp
  counts: {
    matches?: number;
    assignments?: number;
    pitAssignments?: number;
    roster?: number;
    teams?: number;
  };
}

// ---------------------------------------------------------------------------
// Matchup notes (matchup-intelligence feature).
//
// Event-scoped free-text strategy notes. Legacy rows are keyed on two alliance
// leads; current per-team rows reserve our_team = -1 and put the actual target
// team in opp_team (see matchupNotesClient), so the two formats cannot collide.
// `MatchupNoteRow` is the server read shape (snake_case, from `matchup_note`);
// `LocalMatchupNote` is the Dexie draft/outbox shape mirroring LocalMatchReport's
// sync-state machine so notes survive a dead venue network exactly like reports.
// ---------------------------------------------------------------------------

/** Server read shape — one row of the `matchup_note` table (RLS-scoped select). */
export interface MatchupNoteRow {
  event_key: string;
  our_team: number;
  opp_team: number;
  note: string;
  row_revision: number;
  updated_at: string;
  // Advisory "last edited by"; nulled server-side if the scout row was orphaned.
  author_scout_id: string | null;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Strategy whiteboard (Strategy tab).
//
// One drawing document per (event, match), mirroring the `strategy_canvas`
// table (migration 0042). Offline-first exactly like matchup notes: writes land
// in Dexie 'dirty' and drain through strategyCanvasSync.ts via the RPC's
// stroke-id merge (never last-write-wins).
// ---------------------------------------------------------------------------

/** Server read shape — one row of the `strategy_canvas` table (open read). */
export interface StrategyCanvasRow {
  event_key: string;
  match_key: string;
  phase: string;         // 'auto' | 'transition' | 'active' | 'inactive' | 'endgame'
  strokes: unknown;      // jsonb array of stroke objects (parseCanvasDoc validates)
  deleted_ids: unknown;  // jsonb array of tombstoned stroke ids
  robots: unknown;       // jsonb array of robot start squares (auto board)
  row_revision: number;
  updated_at: string;
}

export type LocalRecoveryIssue =
  | {
      kind: 'conflict';
      code: 'MATCHUP_NOTE_CONFLICT' | 'STRATEGY_CANVAS_CONFLICT';
      detectedAt: string;
      serverRevision: number | null;
    }
  | {
      kind: 'terminal';
      code: string;
      detectedAt: string;
      serverRevision?: null;
    };

/** Dexie outbox row for a whiteboard doc. `key` = `${eventKey}:${matchKey}:${phase}`. */
export interface LocalStrategyCanvas {
  key: string;
  eventKey: string;
  matchKey: string;
  /** Optional: pre-0043 rows lack it; the sync payload defaults it to 'auto'. */
  phase?: string;
  strokes: Stroke[];
  deletedIds: string[];
  /** Optional: pre-0043 rows lack it (auto-board robot squares). */
  robots?: RobotPos[];
  updatedAt: string; // ISO; Date.parse(updatedAt) is the row_revision sent to the RPC
  syncState: 'dirty' | 'pending' | 'synced' | 'error';
  syncAttempts: number;
  lastSyncError: string | null;
  nextSyncAt?: number | null;
  /** Typed recovery metadata; old rows without it are normalized on read. */
  recoveryIssue?: LocalRecoveryIssue | null;
}

/** Dexie draft/outbox row. Team notes use `key` = `${eventKey}:-1:${targetTeam}`. */
export interface LocalMatchupNote {
  key: string;
  eventKey: string;
  ourTeam: number;
  oppTeam: number;
  note: string;
  updatedAt: string; // ISO; Date.parse(updatedAt) is the monotonic row_revision sent to the RPC
  authorScoutId: string | null;
  syncState: 'dirty' | 'pending' | 'synced' | 'error';
  syncAttempts: number;
  lastSyncError: string | null;
  nextSyncAt?: number | null;
  /** Typed recovery metadata; old rows without it are normalized on read. */
  recoveryIssue?: LocalRecoveryIssue | null;
}
