import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LocalMatchReport } from '@/db/types';
import { SCHEMA_VERSION } from '@/scoring';

type Row = Record<string, unknown>;
let serverRows: Row[] = [];
const selects: string[] = [];

// .select(cols).eq().eq() (manifest) / .select(cols).in('id', ids) (full rows).
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: (cols: string) => {
        selects.push(cols);
        const pick = (rows: Row[]) =>
          rows.map((r) => Object.fromEntries(cols.split(',').map((c) => [c, r[c]])));
        const filters: Array<(r: Row) => boolean> = [];
        const chain = {
          eq: (col: string, val: unknown) => {
            filters.push((r) => r[col] === val);
            return chain;
          },
          in: (col: string, vals: unknown[]) => {
            filters.push((r) => vals.includes(r[col]));
            return chain;
          },
          then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
            Promise.resolve({
              data: pick(serverRows.filter((r) => filters.every((f) => f(r)))),
              error: null,
            }).then(resolve),
        };
        return chain;
      },
    }),
  },
}));

import { db, saveReport, getReport } from '@/db/localStore';
import { toUpsertPayload } from '@/sync/mapReport';
import { planPull, pullScoutReports, serverRowToLocal } from '@/sync/pullReports';

function makeReport(overrides: Partial<LocalMatchReport> = {}): LocalMatchReport {
  return {
    id: 'r1',
    schemaVersion: SCHEMA_VERSION,
    appVersion: 'test',
    deviceId: 'devA',
    createdAt: '2026-09-27T00:00:00.000Z',
    eventKey: '2026ev',
    matchKey: '2026ev_qm1',
    scoutId: 'scout-1',
    scoutName: 'Casey',
    targetTeamNumber: 254,
    allianceColor: 'blue',
    station: 2,
    inactiveFirst: true,
    inactiveFirstSource: 'scout',
    teleopClockUnconfirmed: false,
    fuelBursts: [{ startMs: 0, endMs: 1000, rate: 2, window: 'shift1' }],
    feedingBursts: [],
    autoFuel: 0,
    teleopFuelActive: 0,
    teleopFuelInactive: 0,
    endgameFuel: 0,
    fuelByShift: [0, 0, 0, 0],
    fuelPoints: 0,
    fuelEstimateConfidence: 1,
    autoStartPosition: { x: 0.1, y: 0.2 },
    autoPath: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }],
    autoLeftStartingLine: true,
    intakeSources: ['ground'],
    maxFuelCapacityObserved: 8,
    defenseRating: 7,
    driverSkill: 9,
    agility: 3,
    defenseDurationMs: 1500,
    defendedDurationMs: 0,
    defenseIntervals: [{ startMs: 0, endMs: 1500, phase: 'teleop' }],
    defendedIntervals: [],
    pins: 1,
    foulsMinor: 2,
    foulsMajor: 0,
    foulReasons: ['pin'],
    noShow: false,
    died: false,
    tipped: false,
    droppedFuel: true,
    fedCorral: false,
    notes: 'fast cycler',
    syncState: 'synced',
    rowRevision: 1,
    syncAttempts: 0,
    lastSyncError: null,
    ...overrides,
  };
}

/** What the server would hold after `r` was upserted. */
function asServerRow(r: LocalMatchReport, extra: Row = {}): Row {
  return { ...toUpsertPayload(r), created_at: r.createdAt, deleted: false, ...extra };
}

beforeEach(async () => {
  await db.reports.clear();
  serverRows = [];
  selects.length = 0;
});

describe('serverRowToLocal', () => {
  it('round-trips the upsert wire shape', () => {
    const original = makeReport();
    const pulled = serverRowToLocal(asServerRow(original) as never, 'Casey');
    expect(pulled.syncState).toBe('synced');
    expect(toUpsertPayload(pulled)).toEqual(toUpsertPayload(original));
  });

  it('stamps the current schema version so 10-point ratings are not rescaled', () => {
    const pulled = serverRowToLocal(
      asServerRow(makeReport(), { schema_version: 1, defense_rating: 3 }) as never,
      'Casey',
    );
    expect(pulled.schemaVersion).toBe(SCHEMA_VERSION);
    expect(pulled.defenseRating).toBe(3);
  });
});

describe('planPull', () => {
  const live = { id: 'r1', row_revision: 2, deleted: false };
  it('fetches rows this device does not have', () => {
    expect(planPull(live, undefined)).toBe('fetch');
  });
  it('refreshes an older synced copy but never unsent local work', () => {
    expect(planPull(live, { syncState: 'synced', rowRevision: 1 })).toBe('fetch');
    expect(planPull(live, { syncState: 'synced', rowRevision: 2 })).toBe('skip');
    for (const syncState of ['dirty', 'pending', 'error'] as const) {
      expect(planPull(live, { syncState, rowRevision: 1 })).toBe('skip');
    }
  });
  it('drops a synced copy the server deleted or superseded', () => {
    const gone = { ...live, deleted: true };
    expect(planPull(gone, { syncState: 'synced', rowRevision: 2 })).toBe('delete');
    expect(planPull(gone, { syncState: 'dirty', rowRevision: 3 })).toBe('skip');
    expect(planPull(gone, undefined)).toBe('skip');
  });
});

describe('pullScoutReports', () => {
  it('hydrates reports scouted on another device', async () => {
    serverRows = [
      asServerRow(makeReport({ id: 'a' })),
      asServerRow(makeReport({ id: 'b', matchKey: '2026ev_qm2' })),
      // Another scouter's report is not pulled.
      asServerRow(makeReport({ id: 'c', scoutId: 'scout-2' })),
    ];
    expect(await pullScoutReports('2026ev', 'scout-1', 'Casey')).toBe(2);
    const a = await getReport('a');
    expect(a?.syncState).toBe('synced');
    expect(a?.scoutName).toBe('Casey');
    expect(await getReport('c')).toBeUndefined();
  });

  it('only fetches full rows when something changed', async () => {
    serverRows = [asServerRow(makeReport({ id: 'a' }))];
    await pullScoutReports('2026ev', 'scout-1', 'Casey');
    selects.length = 0;
    expect(await pullScoutReports('2026ev', 'scout-1', 'Casey')).toBe(0);
    expect(selects).toEqual(['id,row_revision,deleted']);
  });

  it('keeps an unsent local edit over the server copy', async () => {
    await saveReport(makeReport({ id: 'a', syncState: 'dirty', rowRevision: 2, notes: 'local' }));
    serverRows = [asServerRow(makeReport({ id: 'a', rowRevision: 3, notes: 'server' }))];
    expect(await pullScoutReports('2026ev', 'scout-1', 'Casey')).toBe(0);
    expect((await getReport('a'))?.notes).toBe('local');
  });

  it('removes a synced report the server superseded', async () => {
    await saveReport(makeReport({ id: 'a', syncState: 'synced', rowRevision: 1 }));
    serverRows = [
      asServerRow(makeReport({ id: 'a', rowRevision: 2 }), { deleted: true }),
      asServerRow(makeReport({ id: 'b' })),
    ];
    expect(await pullScoutReports('2026ev', 'scout-1', 'Casey')).toBe(2);
    expect(await getReport('a')).toBeUndefined();
    expect(await getReport('b')).toBeDefined();
  });
});
