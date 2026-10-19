import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import type { LocalMatchReport } from '@/db/types';
import { reportsToJson, importReportsFromJson, exportUnsyncedToFile } from '../exportReports';
import { db, listReports, saveReport } from '@/db/localStore';

function makeReport(
  id: string,
  syncState: LocalMatchReport['syncState'] = 'dirty',
): LocalMatchReport {
  return {
    id,
    schemaVersion: 1,
    appVersion: 'test',
    deviceId: 'dev-1',
    createdAt: '2026-06-23T00:00:00.000Z',
    eventKey: '2026event',
    matchKey: 'qm1',
    scoutId: 'scout-1',
    targetTeamNumber: 1234,
    allianceColor: 'red',
    station: 1,
    inactiveFirst: false,
    inactiveFirstSource: 'scout',
    teleopClockUnconfirmed: false,
    fuelBursts: [],
    autoFuel: 0,
    teleopFuelActive: 0,
    teleopFuelInactive: 0,
    endgameFuel: 0,
    fuelByShift: [0, 0, 0, 0],
    fuelPoints: 0,
    fuelEstimateConfidence: 0,
    autoStartPosition: null,
    autoPath: null,
    autoLeftStartingLine: false,
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
    syncState,
    rowRevision: 1,
    syncAttempts: 0,
    lastSyncError: null,
  };
}

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

describe('reportsToJson', () => {
  it('produces a stable JSON document with a schemaVersion header and reports array', () => {
    const json = reportsToJson([makeReport('id-1'), makeReport('id-2')]);
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.reports)).toBe(true);
    expect(parsed.reports.map((r: LocalMatchReport) => r.id)).toEqual(['id-1', 'id-2']);
  });
});

describe('importReportsFromJson', () => {
  it('roundtrips reportsToJson output, persisting reports and deduping by id', async () => {
    const json = reportsToJson([makeReport('id-1'), makeReport('id-2')]);

    const first = await importReportsFromJson(json);
    expect(first).toBe(2);

    // Re-importing the same revisions is a no-op: the local copies win.
    const second = await importReportsFromJson(json);
    expect(second).toBe(0);

    const stored = await listReports();
    const ids = stored.map((r) => r.id).sort();
    expect(ids).toEqual(['id-1', 'id-2']);
    expect(stored).toHaveLength(2);
  });

  it('never overwrites a newer local correction with an older backup', async () => {
    await saveReport({ ...makeReport('id-1'), notes: 'corrected', rowRevision: 3, syncState: 'synced' });
    const json = reportsToJson([{ ...makeReport('id-1'), notes: 'original', rowRevision: 1 }]);

    expect(await importReportsFromJson(json)).toBe(0);
    const [stored] = await listReports();
    expect(stored.notes).toBe('corrected');
    expect(stored.rowRevision).toBe(3);
    expect(stored.syncState).toBe('synced');
  });

  it('queues an imported newer revision as dirty with fresh sync bookkeeping', async () => {
    await saveReport({ ...makeReport('id-1'), rowRevision: 1, syncState: 'synced' });
    const json = reportsToJson([
      {
        ...makeReport('id-1'),
        notes: 'newer',
        rowRevision: 2,
        syncState: 'error',
        syncAttempts: 4,
        lastSyncError: 'boom',
        nextSyncAt: Date.now() + 60_000,
      },
    ]);

    expect(await importReportsFromJson(json)).toBe(1);
    const [stored] = await listReports();
    expect(stored).toMatchObject({
      notes: 'newer',
      rowRevision: 2,
      syncState: 'dirty',
      syncAttempts: 0,
      lastSyncError: null,
      nextSyncAt: null,
    });
  });

  it('throws on malformed JSON document shape', async () => {
    await expect(importReportsFromJson('{"nope":true}')).rejects.toThrow();
    await expect(importReportsFromJson('not json')).rejects.toThrow();
    await expect(
      importReportsFromJson(JSON.stringify({ schemaVersion: 1, reports: [{ id: 5 }] })),
    ).rejects.toThrow();
  });
});

describe('exportUnsyncedToFile', () => {
  it('gathers only unsynced reports into the export descriptor', async () => {
    if (typeof URL.createObjectURL !== 'function') {
      (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:fake';
    }
    await saveReport(makeReport('dirty-1', 'dirty'));
    await saveReport(makeReport('pending-1', 'pending'));
    await saveReport(makeReport('synced-1', 'synced'));

    const result = await exportUnsyncedToFile();

    expect(result.count).toBe(2);
    expect(result.filename).toMatch(/\.json$/);
    expect(typeof result.blobUrl).toBe('string');
  });
});

export { makeReport };
