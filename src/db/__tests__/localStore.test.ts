import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import type { LocalMatchReport, CaptureDraft } from '../types';
import type { FuelBurst } from '@/scoring';
import {
  db,
  ScoutingDb,
  saveReport,
  listReports,
  getUnsynced,
  countUnsynced,
  markSynced,
  saveDraft,
  getDraft,
  listDrafts,
  deleteDraft,
} from '../localStore';

function makeReport(overrides: Partial<LocalMatchReport> = {}): LocalMatchReport {
  const bursts: FuelBurst[] = [
    { startMs: 0, endMs: 500, rate: 2, window: 'shift1' },
  ];
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
    ...overrides,
  };
}

describe('STORE types', () => {
  it('shapes a LocalMatchReport', () => {
    const r = makeReport();
    expect(r.id).toBe('r1');
    expect(r.fuelBursts[0].window).toBe('shift1');
  });

  it('shapes a CaptureDraft', () => {
    const d: CaptureDraft = {
      draftKey: 'qm1:scout1:254',
      updatedAt: new Date().toISOString(),
      state: { a: 1 },
    };
    expect(d.draftKey).toBe('qm1:scout1:254');
  });
});

describe('STORE reports', () => {
  beforeEach(async () => {
    await db.reports.clear();
    await db.drafts.clear();
  });

  it('saveReport + listReports roundtrip', async () => {
    const r = makeReport({ id: 'rt1' });
    await saveReport(r);
    const all = await listReports();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('rt1');
    expect(all[0].fuelBursts[0].window).toBe('shift1');
  });

  it('saveReport defaults syncState to dirty when unset', async () => {
    const r = makeReport({ id: 'rt2' });
    delete (r as Partial<typeof r>).syncState;
    await saveReport(r as typeof r);
    const got = (await listReports()).find((x) => x.id === 'rt2');
    expect(got?.syncState).toBe('dirty');
  });
});

describe('STORE sync state', () => {
  beforeEach(async () => {
    await db.reports.clear();
  });

  it('getUnsynced excludes synced; markSynced flips it', async () => {
    await saveReport(makeReport({ id: 'u1', syncState: 'dirty' }));
    await saveReport(makeReport({ id: 'u2', syncState: 'pending' }));
    await saveReport(makeReport({ id: 's1', syncState: 'synced' }));

    expect(await countUnsynced()).toBe(2);
    const ids = (await getUnsynced()).map((r) => r.id).sort();
    expect(ids).toEqual(['u1', 'u2']);

    await markSynced('u1');
    expect(await countUnsynced()).toBe(1);
    expect((await getUnsynced()).map((r) => r.id)).toEqual(['u2']);
  });
});

describe('STORE drafts', () => {
  beforeEach(async () => {
    await db.drafts.clear();
  });

  it('save/get/list/delete a draft by draftKey', async () => {
    const key = 'qm1:scout1:254';
    await saveDraft(key, { bursts: [], step: 'live' });

    const got = await getDraft(key);
    expect(got?.draftKey).toBe(key);
    expect(got?.state).toEqual({ bursts: [], step: 'live' });
    expect(typeof got?.updatedAt).toBe('string');

    await saveDraft('qm2:scout1:148', { bursts: [1], step: 'review' });
    const list = await listDrafts();
    expect(list.map((d) => d.draftKey).sort()).toEqual([
      'qm1:scout1:254',
      'qm2:scout1:148',
    ]);

    await deleteDraft(key);
    expect(await getDraft(key)).toBeUndefined();
    expect(await listDrafts()).toHaveLength(1);
  });

  it('saveDraft refreshes updatedAt on re-save', async () => {
    const key = 'qm3:scout1:111';
    await saveDraft(key, { v: 1 });
    const first = (await getDraft(key))!.updatedAt;
    await new Promise((res) => setTimeout(res, 5));
    await saveDraft(key, { v: 2 });
    const second = (await getDraft(key))!.updatedAt;
    expect(new Date(second).getTime()).toBeGreaterThanOrEqual(
      new Date(first).getTime(),
    );
    expect((await getDraft(key))!.state).toEqual({ v: 2 });
  });
});

describe('STORE persistence', () => {
  it('reports + drafts persist across a fresh ScoutingDb instance', async () => {
    await db.reports.clear();
    await db.drafts.clear();
    await saveReport(makeReport({ id: 'persist1' }));
    await saveDraft('qm9:scout1:9', { kept: true });
    await db.close();

    const fresh = new ScoutingDb();
    await fresh.open();
    const reports = await fresh.reports.toArray();
    const drafts = await fresh.drafts.toArray();
    expect(reports.map((r) => r.id)).toContain('persist1');
    expect(drafts.map((d) => d.draftKey)).toContain('qm9:scout1:9');
    await fresh.close();

    await db.open();
    expect((await listReports()).map((r) => r.id)).toContain('persist1');
  });
});
