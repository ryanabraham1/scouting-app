// src/dash/types.ts
// Dashboard shared types. `MsrRow` mirrors the snake_case columns the dashboard
// reads from `match_scouting_report` (contracts §1). Numbers/booleans, jsonb
// fields as `{x,y}`|null / `{x,y}[]`|null.

export interface FieldPoint {
  x: number;
  y: number;
}

/** Window-tagged shooting/feeding burst as stored in the `*_bursts` jsonb. */
export interface BurstRow {
  startMs: number;
  endMs: number;
  rate: number;
  window: string;
}

/** Phase-tagged activity interval as stored in the `*_intervals` jsonb. */
export interface IntervalRow {
  startMs: number;
  endMs: number;
  phase: 'auto' | 'teleop';
}

/**
 * A single `match_scouting_report` row as read by the dashboard (contracts §1).
 *
 * The four timestamped jsonb fields below — `fuel_bursts`, `feeding_bursts`,
 * `defense_intervals`, `defended_intervals` — also feed the derived defense
 * analytics (`src/dash/defenseAnalytics.ts` + `aggregate.ts`): Metric A
 * (defended fuel suppression) reads `fuel_bursts` × `defended_intervals`, and
 * Metric B (defender effectiveness) reads a team's `defense_intervals` against
 * opponents' `fuel_bursts`. These are pure display-only derivations of
 * already-synced raw fields — no migration, no wire-shape change.
 */
export interface MsrRow {
  target_team_number: number;
  match_key: string;
  alliance_color: 'red' | 'blue';
  station: number;

  auto_fuel: number;
  teleop_fuel_active: number;
  teleop_fuel_inactive: number;
  endgame_fuel: number;
  fuel_points: number;
  // Nullable in the DB: legacy rows predate the 0.3 default/backfill (0008).
  fuel_estimate_confidence: number | null;
  fuel_by_shift: number[];

  climb_level: number;
  climb_attempted: boolean;
  climb_success: boolean;
  auto_left_starting_line: boolean;
  auto_climb_level1: boolean;

  defense_rating: number;
  // Subjective super-scout ratings (0–3; 0 = not rated). Optional: legacy rows /
  // pre-0039 deployments omit the column. SELECT `*` brings it. Consumers null-guard.
  driver_skill?: number | null;
  agility?: number | null;
  pins: number;

  // Timestamped activity, used to reconstruct a per-match timeline. Optional:
  // legacy rows predate these columns (and they're empty until migration 0010 is
  // deployed and a match is re-scouted). Consumers must null-guard.
  fuel_bursts?: BurstRow[] | null;
  feeding_bursts?: BurstRow[] | null;
  defense_intervals?: IntervalRow[] | null;
  defended_intervals?: IntervalRow[] | null;
  defense_duration_ms?: number | null;
  defended_duration_ms?: number | null;

  no_show: boolean;
  died: boolean;
  tipped: boolean;
  dropped_fuel: boolean;
  fed_corral: boolean;
  // Foul counts (0001 schema; written by upsert_match_report). Optional: legacy
  // fixtures omit them. SELECT `*` brings them. Consumers null-guard.
  fouls_minor?: number | null;
  fouls_major?: number | null;
  // Advisory tags for what the fouls were for (keys from FOUL_REASONS). Optional:
  // legacy rows / pre-0024 deployments omit the column. SELECT `*` brings it.
  foul_reasons?: string[] | null;

  auto_start_position: FieldPoint | null;
  auto_path: FieldPoint[] | null;

  // Attribution: which scouter submitted this report, and any free-text notes.
  // The DB row has these columns; SELECT uses `*`, so they arrive automatically.
  // Optional/nullable: legacy fixtures and anon rows may omit them. Every consumer
  // null-guards these, so `undefined` is treated the same as `null`.
  scout_id?: string | null;
  notes?: string | null;

  server_received_at: string;
  deleted: boolean;
}

// ===========================================================================
// Scout heartbeat / data-freshness coverage (dashboard-heartbeat feature).
//
// Purely a client-side analysis layer over already-fetched MsrRow rows + the
// scout roster — NO new fields on MsrRow, NO wire-shape change, NO migration
// (the only migration this feature ships is a realtime-publication add). These
// types describe "who has reported on a match and who hasn't yet".
// ===========================================================================

/** Minimal scout identity the coverage view needs (subset of ScoutRow). */
export interface ScoutLite {
  id: string;
  display_name: string | null;
}

/** Per-match scout coverage synthesized from the report stream + roster. */
export interface MatchScoutCoverage {
  matchKey: string;
  /** distinct scout_ids with a LIVE (deleted=false) report on this match */
  scoutsCovered: number;
  /** scouts registered for the event (roster size, the denominator) */
  scoutsTotal: number;
  /** freshest server_received_at among this match's reports, or null */
  lastReportAt: string | null;
  /** distinct reported scout_ids (excludes null/undefined attribution) */
  reportedScoutIds: string[];
  /** roster scouts with NO report on this match */
  missingScouts: ScoutLite[];
  /** count of reports on this match whose scout_id is null/undefined */
  unattributed: number;
  /** station coverage: distinct stations reported, capped at stationCap (6) */
  stationsCovered: number;
}

// ===========================================================================
// Multi-scout reconciliation (multi-scout-reconciliation feature).
//
// Two different scouts can each file an active report on the SAME robot in the
// SAME match (the uniqueness index is per scout_id). These types describe a
// detected multi-scout group + how much the two reports diverge. PURELY a
// client-side analysis layer over already-fetched MsrRow rows — NO new fields
// on MsrRow, NO wire-shape change, NO migration. Conflict metadata lives on
// MultiScoutGroup, looked up by report/robot key (see src/dash/reconcile.ts).
// ===========================================================================

/**
 * Severity tier of a multi-scout group.
 *  - `agree`   — two scouts covered the robot and their comparable metrics matched.
 *  - `unknown` — two scouts covered the robot but nothing comparable existed to
 *                confirm agreement (every numeric metric missing on a side, no
 *                boolean disagreement). Distinct from `agree` so absence of
 *                evidence isn't conflated with a confirmed match.
 *  - `minor`   — at least one metric diverges, below the severe threshold.
 *  - `severe`  — a categorical disagreement (no-show, died, climb success, or a
 *                large fuel/defense spread).
 */
export type ConflictSeverity = 'agree' | 'unknown' | 'minor' | 'severe';

/** Per-metric divergence summary for a multi-scout group (all null-guarded). */
export interface ConflictDivergences {
  /** max−min of comparable `fuel_points` across the deduped reports (0 when <2). */
  fuel_spread: number;
  /** scouts disagree on whether the climb succeeded. */
  climb_success_divergent: boolean;
  /** max−min of `climb_level` among the successful climbs (0 when <2). */
  climb_level_spread: number;
  /** max−min of comparable `defense_rating` (0 when <2). */
  defense_spread: number;
  no_show_divergent: boolean;
  died_divergent: boolean;
  tipped_divergent: boolean;
  /** how many metrics were actually comparable (≥2 scouts had a usable value). */
  comparable_metric_count: number;
}

/** A robot covered by 2+ distinct scouts in one match, with divergence/severity. */
export interface MultiScoutGroup {
  matchKey: string;
  teamNumber: number;
  allianceColor: 'red' | 'blue';
  station: number;
  /** deduped, one per distinct scout (latest server_received_at wins). */
  reports: MsrRow[];
  scoutIds: (string | null)[];
  severity: ConflictSeverity;
  /** severity === 'minor' || 'severe'. */
  isConflicted: boolean;
  divergences: ConflictDivergences;
}
