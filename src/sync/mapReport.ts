import type { LocalMatchReport } from '@/db/types';

/**
 * The SINGLE source of the upsert wire shape. Produces EXACTLY the snake_case
 * keys the `upsert_match_report` RPC reads (contracts §1a / §4): raw fields
 * only — no aggregates, no timestamps, no server-managed columns. The server
 * recomputes aggregates from these.
 */
export function toUpsertPayload(r: LocalMatchReport): Record<string, unknown> {
  return {
    id: r.id,
    schema_version: r.schemaVersion,
    app_version: r.appVersion,
    device_id: r.deviceId,
    event_key: r.eventKey,
    match_key: r.matchKey,
    scout_id: r.scoutId,
    target_team_number: r.targetTeamNumber,
    alliance_color: r.allianceColor,
    station: r.station,
    inactive_first: r.inactiveFirst,
    inactive_first_source: r.inactiveFirstSource,
    teleop_clock_unconfirmed: r.teleopClockUnconfirmed,
    fuel_bursts: r.fuelBursts,
    climb_level: r.climbLevel,
    climb_attempted: r.climbAttempted,
    climb_success: r.climbSuccess,
    auto_start_position: r.autoStartPosition,
    auto_path: r.autoPath,
    auto_left_starting_line: r.autoLeftStartingLine,
    auto_climb_level1: r.autoClimbLevel1,
    intake_sources: r.intakeSources,
    max_fuel_capacity_observed: r.maxFuelCapacityObserved,
    defense_rating: r.defenseRating,
    defense_duration_ms: r.defenseDurationMs ?? 0,
    defended_duration_ms: r.defendedDurationMs ?? 0,
    pins: r.pins,
    fouls_minor: r.foulsMinor,
    fouls_major: r.foulsMajor,
    no_show: r.noShow,
    died: r.died,
    tipped: r.tipped,
    dropped_fuel: r.droppedFuel,
    fed_corral: r.fedCorral,
    notes: r.notes,
    row_revision: r.rowRevision ?? 1,
    deleted: (r as { deleted?: boolean }).deleted ?? false,
  };
}
