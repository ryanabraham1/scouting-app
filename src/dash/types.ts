// src/dash/types.ts
// Dashboard shared types. `MsrRow` mirrors the snake_case columns the dashboard
// reads from `match_scouting_report` (contracts §1). Numbers/booleans, jsonb
// fields as `{x,y}`|null / `{x,y}[]`|null.

export interface FieldPoint {
  x: number;
  y: number;
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

  no_show: boolean;
  died: boolean;
  tipped: boolean;
  dropped_fuel: boolean;
  fed_corral: boolean;

  auto_start_position: FieldPoint | null;
  auto_path: FieldPoint[] | null;

  server_received_at: string;
  deleted: boolean;
}
