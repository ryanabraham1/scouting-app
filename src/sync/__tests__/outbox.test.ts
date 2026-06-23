import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LocalMatchReport } from '@/db/types';
import type { FuelBurst } from '@/scoring';
import { db, saveReport, listReports } from '@/db/localStore';
import { SYNC_MAX_ATTEMPTS } from '@/sync/constants';
import { syncOnce } from '../outbox';

function makeReport(overrides: Partial<LocalMatchReport> = {}): LocalMatchReport {
  const bursts: FuelBurst[] = [{ startMs: 0, endMs: 500, rate: 2, window: 'shift1' }];
  return {
    id: 'r1',
    schemaVersion: 1,
    appVersion: 'test',
    deviceId: 'dev1',
    createdAt: new Date('2026-06-23T00:00:00.000Z').toISOString(),
    eventKey: '2026event',
    matchKey: 'qm1',
    scoutId: 'scout1',
    targetTeamNumber: 254,
    allianceColor: 'red',
    station: 1,
    inactiveFirst: false,
    inactiveFirstSource: 'scout',
    teleopClockUnconfirmed: false,
    fuelBursts: bursts,
    autoFuel: 0,
    teleopFuelActive: 1,
    teleopFuelInactive: 0,
    endgameFuel: 0,
    fuelByShift: [0, 1, 0, 0],
    fuelPoints: 1,
    fuelEstimateConfidence: 1,
    climbLevel: 0,
    climbAttempted: false,
    climbSuccess: false,
    autoStartPosition: null,
    autoPath: null,
    autoLeftStartingLine: false,
    autoClimbLevel1: false,
    intakeSources: [],
    maxFuelCapacityObserved: 0,
    defenseRating: 0,
    pins: 0,
    foulsMinor: 0,
    foulsMajor: 0,
    noShow: false,
    died: false,
    tipped: false,
    droppedFuel: false,
    fedCorral: false,
    notes: '',
    syncState: 'dirty',
    rowRevision: 1,
    syncAttempts: 0,
    lastSyncError: null,
    ...overrides,
  };
}

async function getReport(id: string): Promise<LocalMatchReport | undefined> {
  return (await listReports()).find((r) => r.id === id);
}

const EXPECTED_PAYLOAD_KEYS = [
  'id', 'schema_version', 'app_version', 'device_id', 'event_key', 'match_key',
  'scout_id', 'target_team_number', 'alliance_color', 'station', 'inactive_first',
  'inactive_first_source', 'teleop_clock_unconfirmed', 'fuel_bursts', 'climb_level',
  'climb_attempted', 'climb_success', 'auto_start_position', 'auto_path',
  'auto_left_starting_line', 'auto_climb_level1', 'intake_sources',
  'max_fuel_capacity_observed', 'defense_rating', 'pins', 'fouls_minor',
  'fouls_major', 'no_show', 'died', 'tipped', 'dropped_fuel', 'fed_corral',
  'notes', 'row_revision', 'deleted',
].sort();

describe('syncOnce', () => {
  beforeEach(async () => {
    await db.reports.clear();
  });

  it('all-success: drains the queue, marks every report synced, tallies the summary', async () => {
    await saveReport(makeReport({ id: 'a', createdAt: '2026-06-23T00:00:00.000Z' }));
    await saveReport(makeReport({ id: 'b', createdAt: '2026-06-23T00:00:01.000Z' }));
    await saveReport(makeReport({ id: 'c', createdAt: '2026-06-23T00:00:02.000Z' }));

    const rpc = vi.fn().mockResolvedValue({ error: null });
    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 3, synced: 3, retried: 0, deadLettered: 0 });
    expect(rpc).toHaveBeenCalledTimes(3);

    // RPC called with the upsert fn and a `{ p }` whose keys match contracts §1a.
    for (const call of rpc.mock.calls) {
      expect(call[0]).toBe('upsert_match_report');
      const args = call[1] as { p: Record<string, unknown> };
      expect(Object.keys(args.p).sort()).toEqual(EXPECTED_PAYLOAD_KEYS);
    }

    expect((await getReport('a'))?.syncState).toBe('synced');
    expect((await getReport('b'))?.syncState).toBe('synced');
    expect((await getReport('c'))?.syncState).toBe('synced');
  });

  it('transient (rpc throws): returns the report to dirty, increments syncAttempts, no dead-letter', async () => {
    await saveReport(makeReport({ id: 't1', syncAttempts: 0 }));
    const rpc = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 1, deadLettered: 0 });
    const got = await getReport('t1');
    expect(got?.syncState).toBe('dirty');
    expect(got?.syncAttempts).toBe(1);
    expect(got?.lastSyncError).toBeTruthy();
  });

  it('terminal ({ error }): dead-letters the report and records lastSyncError', async () => {
    await saveReport(makeReport({ id: 'x1' }));
    const rpc = vi.fn().mockResolvedValue({ error: { code: '42501', message: 'denied' } });

    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 0, deadLettered: 1 });
    const got = await getReport('x1');
    expect(got?.syncState).toBe('error');
    expect(got?.lastSyncError).toBeTruthy();
  });

  it('cap: a transient failure at SYNC_MAX_ATTEMPTS dead-letters (terminal by cap)', async () => {
    await saveReport(makeReport({ id: 'cap1', syncAttempts: SYNC_MAX_ATTEMPTS }));
    const rpc = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 0, deadLettered: 1 });
    const got = await getReport('cap1');
    expect(got?.syncState).toBe('error');
  });

  it('idempotency: re-running after success is a no-op (empty queue)', async () => {
    await saveReport(makeReport({ id: 'idem' }));
    const rpc = vi.fn().mockResolvedValue({ error: null });

    await syncOnce(rpc);
    rpc.mockClear();
    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 0, synced: 0, retried: 0, deadLettered: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not touch dead-lettered reports (getSyncQueue excludes error)', async () => {
    await saveReport(makeReport({ id: 'dead', syncState: 'error', lastSyncError: 'boom' }));
    const rpc = vi.fn().mockResolvedValue({ error: null });

    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 0, synced: 0, retried: 0, deadLettered: 0 });
    expect(rpc).not.toHaveBeenCalled();
    expect((await getReport('dead'))?.syncState).toBe('error');
  });
});
