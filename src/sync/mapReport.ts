import type { LocalMatchReport } from '@/db/types';
import { sanitizeMatchReport } from '@/sync/sanitizeReport';

/**
 * The SINGLE source of the upsert wire shape. Produces EXACTLY the snake_case
 * keys the `upsert_match_report` RPC reads (contracts §1a / §4): raw fields
 * only — no aggregates, no timestamps, no server-managed columns. The server
 * recomputes aggregates from these.
 */
export function toUpsertPayload(r: LocalMatchReport): Record<string, unknown> {
  // Re-sanitize here even though new captures are normalized before persistence:
  // reports saved by older app versions remain in IndexedDB and must be
  // recoverable with Retry all instead of re-dead-lettering forever.
  const safe = sanitizeMatchReport(r);
  return {
    id: safe.id,
    schema_version: safe.schemaVersion,
    app_version: safe.appVersion,
    device_id: safe.deviceId,
    event_key: safe.eventKey,
    match_key: safe.matchKey,
    scout_id: safe.scoutId,
    // Name fallback so the server can re-resolve an orphaned scout_id (see
    // upsert_match_report, migration 0030) instead of dead-lettering. Omitted-safe.
    scout_name: safe.scoutName,
    target_team_number: safe.targetTeamNumber,
    alliance_color: safe.allianceColor,
    station: safe.station,
    inactive_first: safe.inactiveFirst,
    inactive_first_source: safe.inactiveFirstSource,
    teleop_clock_unconfirmed: safe.teleopClockUnconfirmed,
    fuel_bursts: safe.fuelBursts,
    feeding_bursts: safe.feedingBursts,
    climb_level: safe.climbLevel,
    climb_attempted: safe.climbAttempted,
    climb_success: safe.climbSuccess,
    auto_start_position: safe.autoStartPosition,
    auto_path: safe.autoPath,
    auto_left_starting_line: safe.autoLeftStartingLine,
    auto_climb_level1: safe.autoClimbLevel1,
    intake_sources: safe.intakeSources,
    max_fuel_capacity_observed: safe.maxFuelCapacityObserved,
    defense_rating: safe.defenseRating,
    // Subjective super-scout ratings (1–10; 0 = not rated; raw stored, never scored). Omitted-safe
    // via the server's coalesce-to-0 for reports captured before migration 0039.
    driver_skill: safe.driverSkill ?? 0,
    agility: safe.agility ?? 0,
    defense_duration_ms: safe.defenseDurationMs,
    defended_duration_ms: safe.defendedDurationMs,
    defense_intervals: safe.defenseIntervals,
    defended_intervals: safe.defendedIntervals,
    pins: safe.pins,
    fouls_minor: safe.foulsMinor,
    fouls_major: safe.foulsMajor,
    foul_reasons: safe.foulReasons ?? [],
    no_show: safe.noShow,
    died: safe.died,
    tipped: safe.tipped,
    dropped_fuel: safe.droppedFuel,
    fed_corral: safe.fedCorral,
    notes: safe.notes,
    row_revision: safe.rowRevision,
    deleted: (safe as { deleted?: boolean }).deleted === true,
  };
}
