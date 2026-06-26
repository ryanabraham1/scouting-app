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

/** A single `match_scouting_report` row as read by the dashboard (contracts §1). */
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
