import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LocalMatchReport } from '@/db/types';
import type { FuelBurst } from '@/scoring';
import {
  db,
  saveReport,
  listReports,
  requeueAuthClassDeadLetters,
} from '@/db/localStore';
import { SYNC_MAX_ATTEMPTS } from '@/sync/constants';
import { syncOnce } from '../outbox';
import { clearSyncCircuit } from '../retrySchedule';

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

    defenseDurationMs: 0,
    defendedDurationMs: 0,
    feedingBursts: [],
    defenseIntervals: [],
    defendedIntervals: [],
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
  'scout_id', 'scout_name', 'target_team_number', 'alliance_color', 'station', 'inactive_first',
  'inactive_first_source', 'teleop_clock_unconfirmed', 'fuel_bursts', 'feeding_bursts', 'climb_level',
  'climb_attempted', 'climb_success', 'auto_start_position', 'auto_path',
  'auto_left_starting_line', 'auto_climb_level1', 'intake_sources',
  'max_fuel_capacity_observed', 'defense_rating', 'driver_skill', 'agility', 'defense_duration_ms',
  'defended_duration_ms', 'defense_intervals', 'defended_intervals', 'pins', 'fouls_minor',
  'fouls_major', 'foul_reasons', 'no_show', 'died', 'tipped', 'dropped_fuel', 'fed_corral',
  'notes', 'row_revision', 'deleted',
].sort();

function successResult(status: 'applied' | 'idempotent' = 'applied') {
  return { data: { status, current_revision: 1 }, error: null };
}

describe('syncOnce', () => {
  beforeEach(async () => {
    clearSyncCircuit();
    await db.reports.clear();
  });

  it('all-success: drains the queue, marks every report synced, tallies the summary', async () => {
    await saveReport(makeReport({ id: 'a', createdAt: '2026-06-23T00:00:00.000Z' }));
    await saveReport(makeReport({ id: 'b', createdAt: '2026-06-23T00:00:01.000Z' }));
    await saveReport(makeReport({ id: 'c', createdAt: '2026-06-23T00:00:02.000Z' }));

    const rpc = vi.fn().mockResolvedValue(successResult());
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

  it('treats an idempotent server verdict as synced', async () => {
    await saveReport(makeReport({ id: 'idempotent-status' }));
    const summary = await syncOnce(
      vi.fn().mockResolvedValue(successResult('idempotent')),
    );
    expect(summary).toEqual({ attempted: 1, synced: 1, retried: 0, deadLettered: 0 });
    expect((await getReport('idempotent-status'))?.syncState).toBe('synced');
  });

  it.each(['stale', 'conflict'] as const)(
    'preserves local data and records a recoverable %s verdict',
    async (status) => {
      await saveReport(makeReport({ id: `server-${status}`, notes: 'keep this local edit' }));
      const summary = await syncOnce(
        vi.fn().mockResolvedValue({
          data: { status, current_revision: 7 },
          error: null,
        }),
      );

      expect(summary).toEqual({ attempted: 1, synced: 0, retried: 0, deadLettered: 1 });
      const report = await getReport(`server-${status}`);
      expect(report?.syncState).toBe('error');
      expect(report?.notes).toBe('keep this local edit');
      expect(report?.lastSyncError).toMatch(new RegExp(`${status}|conflict`, 'i'));
      expect(report?.lastSyncError).toContain('7');
    },
  );

  it('transient (5xx): returns the report to dirty, increments syncAttempts, no dead-letter', async () => {
    await saveReport(makeReport({ id: 't1', syncAttempts: 0 }));
    const rpc = vi.fn().mockResolvedValue({
      error: { message: 'service unavailable', status: 503 },
    });

    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 1, deadLettered: 0 });
    const got = await getReport('t1');
    expect(got?.syncState).toBe('dirty');
    expect(got?.syncAttempts).toBe(1);
    expect(got?.lastSyncError).toBeTruthy();
  });

  it('network gap (rpc throws): back to dirty WITHOUT burning an attempt; drain stops', async () => {
    await saveReport(makeReport({ id: 'n1', syncAttempts: 0, createdAt: '2026-06-23T00:00:00.000Z' }));
    await saveReport(makeReport({ id: 'n2', syncAttempts: 0, createdAt: '2026-06-23T00:00:01.000Z' }));
    const rpc = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const summary = await syncOnce(rpc);

    // Only the first report is attempted — everything behind it faces the same
    // dead network, so the drain stops instead of hammering it.
    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 1, deadLettered: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
    const got = await getReport('n1');
    expect(got?.syncState).toBe('dirty');
    // A pure network gap says nothing about the report — no attempt burned, so
    // flaky venue wifi can never walk a report toward the dead-letter cap.
    expect(got?.syncAttempts).toBe(0);
    expect((await getReport('n2'))?.syncState).toBe('dirty');
  });

  it('network gap (supabase resolved fetch-failure shape, code:"") does not dead-letter', async () => {
    // supabase-js does NOT throw on transport failure — it resolves with this
    // exact error shape. Regression test: code:'' used to classify terminal
    // and instantly dead-letter every report on a wifi blip.
    await saveReport(makeReport({ id: 'n3', syncAttempts: 0 }));
    const rpc = vi.fn().mockResolvedValue({
      error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
    });

    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 1, deadLettered: 0 });
    const got = await getReport('n3');
    expect(got?.syncState).toBe('dirty');
    expect(got?.syncAttempts).toBe(0);
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

  it('keeps infrastructure failures queued even after the legacy attempt cap', async () => {
    await saveReport(makeReport({ id: 'cap1', syncAttempts: SYNC_MAX_ATTEMPTS }));
    const rpc = vi.fn().mockResolvedValue({
      error: { message: 'service unavailable', status: 503 },
    });

    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 1, deadLettered: 0 });
    const got = await getReport('cap1');
    expect(got?.syncState).toBe('dirty');
  });

  it('success resets syncAttempts so past blips never accumulate toward the cap', async () => {
    await saveReport(makeReport({ id: 'reset1', syncAttempts: SYNC_MAX_ATTEMPTS - 1 }));
    const rpc = vi.fn().mockResolvedValue(successResult());

    await syncOnce(rpc);

    const got = await getReport('reset1');
    expect(got?.syncState).toBe('synced');
    expect(got?.syncAttempts).toBe(0);
    expect(got?.lastSyncError).toBeNull();
  });

  it('revision guard: a mid-flight edit is not clobbered by the stale upload marking synced', async () => {
    // The scout edits the report WHILE its rev-1 snapshot is uploading: save()
    // bumps rowRevision and re-dirties the row. markSynced(rev 1) must not
    // flip the rev-2 row to synced — that would strand the edit locally forever.
    await saveReport(makeReport({ id: 'race1', rowRevision: 1 }));
    const rpc = vi.fn().mockImplementation(async () => {
      await saveReport(makeReport({ id: 'race1', rowRevision: 2, syncState: 'dirty' }));
      return successResult();
    });

    await syncOnce(rpc);

    const got = await getReport('race1');
    expect(got?.rowRevision).toBe(2);
    expect(got?.syncState).toBe('dirty');
  });

  it('revision guard: a stale upload’s terminal verdict does not dead-letter a newer edit', async () => {
    await saveReport(makeReport({ id: 'race2', rowRevision: 1 }));
    const rpc = vi.fn().mockImplementation(async () => {
      await saveReport(makeReport({ id: 'race2', rowRevision: 2, syncState: 'dirty' }));
      return { error: { code: '23503', message: 'bad fk' } };
    });

    await syncOnce(rpc);

    const got = await getReport('race2');
    expect(got?.rowRevision).toBe(2);
    expect(got?.syncState).toBe('dirty');
  });

  it('idempotency: re-running after success is a no-op (empty queue)', async () => {
    await saveReport(makeReport({ id: 'idem' }));
    const rpc = vi.fn().mockResolvedValue(successResult());

    await syncOnce(rpc);
    rpc.mockClear();
    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 0, synced: 0, retried: 0, deadLettered: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('recovery: an auth-class (42501) dead-letter requeues and syncs after the server fix', async () => {
    // A report wrongly dead-lettered by the OLD ownership gate (SQLSTATE 42501).
    await saveReport(
      makeReport({
        id: 'recover1',
        syncState: 'error',
        syncAttempts: 3,
        lastSyncError: 'not authorized: scout_id not owned by caller',
      }),
    );

    // Before requeue, syncOnce ignores dead-letters entirely.
    const noopRpc = vi.fn().mockResolvedValue(successResult());
    expect(await syncOnce(noopRpc)).toEqual({
      attempted: 0,
      synced: 0,
      retried: 0,
      deadLettered: 0,
    });
    expect(noopRpc).not.toHaveBeenCalled();

    // The once-per-session auto-requeue pulls the auth-class dead-letter back.
    expect(await requeueAuthClassDeadLetters()).toBe(1);

    // Now (post-0012 the RPC accepts it) the drain succeeds.
    const okRpc = vi.fn().mockResolvedValue(successResult());
    const summary = await syncOnce(okRpc);
    expect(summary).toEqual({ attempted: 1, synced: 1, retried: 0, deadLettered: 0 });
    expect((await getReport('recover1'))?.syncState).toBe('synced');
  });

  it('does not touch dead-lettered reports (getSyncQueue excludes error)', async () => {
    await saveReport(makeReport({ id: 'dead', syncState: 'error', lastSyncError: 'boom' }));
    const rpc = vi.fn().mockResolvedValue(successResult());

    const summary = await syncOnce(rpc);

    expect(summary).toEqual({ attempted: 0, synced: 0, retried: 0, deadLettered: 0 });
    expect(rpc).not.toHaveBeenCalled();
    expect((await getReport('dead'))?.syncState).toBe('error');
  });
});
