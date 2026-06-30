import { describe, it, expect } from 'vitest';
import type { LocalMatchReport } from '@/db/types';
import type { FuelBurst } from '@/scoring';
import { toUpsertPayload } from '../mapReport';

const EXPECTED_KEYS = [
  'id',
  'schema_version',
  'app_version',
  'device_id',
  'event_key',
  'match_key',
  'scout_id',
  'scout_name',
  'target_team_number',
  'alliance_color',
  'station',
  'inactive_first',
  'inactive_first_source',
  'teleop_clock_unconfirmed',
  'fuel_bursts',
  'feeding_bursts',
  'climb_level',
  'climb_attempted',
  'climb_success',
  'auto_start_position',
  'auto_path',
  'auto_left_starting_line',
  'auto_climb_level1',
  'intake_sources',
  'max_fuel_capacity_observed',
  'defense_rating',
  'defense_duration_ms',
  'defended_duration_ms',
  'defense_intervals',
  'defended_intervals',
  'pins',
  'fouls_minor',
  'fouls_major',
  'foul_reasons',
  'no_show',
  'died',
  'tipped',
  'dropped_fuel',
  'fed_corral',
  'notes',
  'row_revision',
  'deleted',
];

function makeReport(overrides: Partial<LocalMatchReport> = {}): LocalMatchReport {
  const bursts: FuelBurst[] = [{ startMs: 0, endMs: 500, rate: 2, window: 'shift1' }];
  return {
    id: 'r1',
    schemaVersion: 3,
    appVersion: '2.0.0',
    deviceId: 'dev-1',
    createdAt: '2026-06-23T00:00:00.000Z',
    eventKey: '2026event',
    matchKey: 'qm5',
    scoutId: 'scout-1',
    targetTeamNumber: 254,
    allianceColor: 'blue',
    station: 3,
    inactiveFirst: true,
    inactiveFirstSource: 'scout',
    teleopClockUnconfirmed: true,
    fuelBursts: bursts,
    feedingBursts: [],
    autoFuel: 12,
    teleopFuelActive: 5,
    teleopFuelInactive: 2,
    endgameFuel: 1,
    fuelByShift: [1, 2, 3, 4],
    fuelPoints: 99,
    fuelEstimateConfidence: 0.3,
    climbLevel: 2,
    climbAttempted: true,
    climbSuccess: true,
    autoStartPosition: { x: 1, y: 2 },
    autoPath: [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
    ],
    autoLeftStartingLine: true,
    autoClimbLevel1: true,
    intakeSources: ['ground', 'station'],
    maxFuelCapacityObserved: 7,
    defenseRating: 1,
    defenseDurationMs: 4200,
    defendedDurationMs: 1500,
    defenseIntervals: [],
    defendedIntervals: [],
    pins: 2,
    foulsMinor: 3,
    foulsMajor: 1,
    foulReasons: ['pinning', 'damage'],
    noShow: false,
    died: true,
    tipped: false,
    droppedFuel: true,
    fedCorral: true,
    notes: 'looked strong',
    syncState: 'dirty',
    rowRevision: 4,
    syncAttempts: 0,
    lastSyncError: null,
    ...overrides,
  };
}

describe('toUpsertPayload', () => {
  it('produces EXACTLY the §1a snake_case keys (no aggregates, no timestamps)', () => {
    const p = toUpsertPayload(makeReport());
    expect(Object.keys(p).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('maps exact defense/being-defended durations (no buckets)', () => {
    const p = toUpsertPayload(makeReport());
    expect(p.defense_duration_ms).toBe(4200);
    expect(p.defended_duration_ms).toBe(1500);
  });

  it('omits all aggregate/timestamp/server-managed keys', () => {
    const p = toUpsertPayload(makeReport());
    for (const banned of [
      'auto_fuel',
      'teleop_fuel_active',
      'teleop_fuel_inactive',
      'endgame_fuel',
      'fuel_by_shift',
      'fuel_points',
      'fuel_estimate_confidence',
      'created_at',
      'server_received_at',
      'updated_at',
      'sync_state',
      'sync_attempts',
      'last_sync_error',
    ]) {
      expect(p).not.toHaveProperty(banned);
    }
  });

  it('maps camelCase fields to snake_case values', () => {
    const p = toUpsertPayload(makeReport());
    expect(p.id).toBe('r1');
    expect(p.schema_version).toBe(3);
    expect(p.app_version).toBe('2.0.0');
    expect(p.device_id).toBe('dev-1');
    expect(p.event_key).toBe('2026event');
    expect(p.match_key).toBe('qm5');
    expect(p.scout_id).toBe('scout-1');
    expect(p.target_team_number).toBe(254);
    expect(p.alliance_color).toBe('blue');
    expect(p.station).toBe(3);
    expect(p.inactive_first).toBe(true);
    expect(p.inactive_first_source).toBe('scout');
    expect(p.teleop_clock_unconfirmed).toBe(true);
    expect(p.climb_level).toBe(2);
    expect(p.climb_attempted).toBe(true);
    expect(p.climb_success).toBe(true);
    expect(p.auto_left_starting_line).toBe(true);
    expect(p.auto_climb_level1).toBe(true);
    expect(p.max_fuel_capacity_observed).toBe(7);
    expect(p.defense_rating).toBe(1);
    expect(p.pins).toBe(2);
    expect(p.fouls_minor).toBe(3);
    expect(p.fouls_major).toBe(1);
    expect(p.foul_reasons).toEqual(['pinning', 'damage']);
    expect(p.no_show).toBe(false);
    expect(p.died).toBe(true);
    expect(p.tipped).toBe(false);
    expect(p.dropped_fuel).toBe(true);
    expect(p.fed_corral).toBe(true);
    expect(p.notes).toBe('looked strong');
    expect(p.row_revision).toBe(4);
  });

  it('passes through jsonb fields as-is and intake_sources as a string array', () => {
    const r = makeReport();
    const p = toUpsertPayload(r);
    expect(p.fuel_bursts).toEqual(r.fuelBursts);
    expect(p.auto_start_position).toEqual({ x: 1, y: 2 });
    expect(p.auto_path).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 4 },
    ]);
    expect(p.intake_sources).toEqual(['ground', 'station']);
  });

  it('handles null auto_* fields', () => {
    const p = toUpsertPayload(makeReport({ autoStartPosition: null, autoPath: null }));
    expect(p.auto_start_position).toBeNull();
    expect(p.auto_path).toBeNull();
  });

  it('defaults row_revision to 1 when rowRevision is absent', () => {
    const r = makeReport();
    delete (r as Partial<LocalMatchReport>).rowRevision;
    const p = toUpsertPayload(r as LocalMatchReport);
    expect(p.row_revision).toBe(1);
  });

  it('always sends deleted:false (LocalMatchReport has no deleted field today)', () => {
    const p = toUpsertPayload(makeReport());
    expect(p.deleted).toBe(false);
  });
});
