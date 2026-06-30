import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { db, getDraft, saveDraft, saveReport, getReport, listReports } from '@/db/localStore';
import { toUpsertPayload } from '@/sync/mapReport';
import type { LocalMatchReport } from '@/db/types';
import { SCHEMA_VERSION, type FuelBurst } from '@/scoring';

const target: CaptureTarget = {
  eventKey: '2026demo',
  matchKey: 'qm1',
  scoutId: 'scout-1',
  targetTeamNumber: 254,
  allianceColor: 'red',
  station: 1,
};

const TWO_BURSTS: FuelBurst[] = [
  { startMs: 0, endMs: 1000, rate: 20, window: 'transition' },
  { startMs: 2000, endMs: 3000, rate: 10, window: 'shift1' },
];

// Build a saved report for the edit target. rowRevision is overridable for the
// monotonicity cases; the rest mirrors what useCaptureSession.save() would write.
function makeSavedReport(overrides: Partial<LocalMatchReport> = {}): LocalMatchReport {
  return {
    id: 'report-edit-1',
    schemaVersion: SCHEMA_VERSION,
    appVersion: '2.0.0',
    deviceId: 'device-local',
    createdAt: '2026-06-25T10:00:00.000Z',
    eventKey: target.eventKey,
    matchKey: target.matchKey,
    scoutId: target.scoutId,
    scoutName: 'Edit Scout',
    targetTeamNumber: target.targetTeamNumber,
    allianceColor: target.allianceColor,
    station: target.station,
    inactiveFirst: false,
    inactiveFirstSource: 'scout',
    teleopClockUnconfirmed: false,
    fuelBursts: TWO_BURSTS,
    feedingBursts: [],
    autoFuel: 0,
    teleopFuelActive: 0,
    teleopFuelInactive: 0,
    endgameFuel: 0,
    fuelByShift: [0, 0, 0, 0],
    fuelPoints: 0,
    fuelEstimateConfidence: 0.3,
    climbLevel: 2,
    climbAttempted: true,
    climbSuccess: true,
    autoStartPosition: null,
    autoPath: null,
    autoLeftStartingLine: false,
    autoClimbLevel1: false,
    intakeSources: [],
    maxFuelCapacityObserved: 0,
    defenseRating: 0,
    defenseDurationMs: 5000,
    defendedDurationMs: 0,
    defenseIntervals: [],
    defendedIntervals: [],
    pins: 0,
    foulsMinor: 0,
    foulsMajor: 0,
    foulReasons: [],
    noShow: false,
    died: false,
    tipped: false,
    droppedFuel: false,
    fedCorral: false,
    notes: 'x',
    syncState: 'synced',
    rowRevision: 3,
    syncAttempts: 0,
    lastSyncError: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

describe('getReport round-trip (case 1)', () => {
  it('returns the row with withSyncDefaults applied (rowRevision defaults to 1)', async () => {
    const r = makeSavedReport({ id: 'legacy-1' });
    // Strip rowRevision to simulate a legacy row written before the field existed.
    const legacy = { ...r } as Partial<LocalMatchReport>;
    delete legacy.rowRevision;
    await saveReport(legacy as LocalMatchReport);

    const got = await getReport('legacy-1');
    expect(got).toBeDefined();
    expect(got!.id).toBe('legacy-1');
    expect(got!.rowRevision).toBe(1);
  });

  it('returns undefined for a missing id', async () => {
    expect(await getReport('nope')).toBeUndefined();
  });
});

describe('edit mode reconstitutes state (case 2)', () => {
  it('loads climb/defense/notes/bursts from the existing report', async () => {
    await saveReport(makeSavedReport());
    const { result } = renderHook(() =>
      useCaptureSession({ ...target, editingReportId: 'report-edit-1' }),
    );
    await waitFor(() => expect(result.current.bursts.length).toBe(2));
    expect(result.current.climbLevel).toBe(2);
    expect(result.current.defenseDurationMs).toBe(5000);
    expect(result.current.notes).toBe('x');
  });
});

describe('revision bump on save (cases 3 + 4)', () => {
  it('rewrites in place with same id/createdAt and rowRevision = loaded + 1', async () => {
    await saveReport(makeSavedReport()); // rowRevision: 3
    const { result } = renderHook(() =>
      useCaptureSession({ ...target, editingReportId: 'report-edit-1' }),
    );
    await waitFor(() => expect(result.current.bursts.length).toBe(2));

    let savedId = '';
    await act(async () => {
      savedId = await result.current.save();
    });
    expect(savedId).toBe('report-edit-1');

    const reports = await listReports();
    expect(reports).toHaveLength(1); // rewritten in place, not duplicated
    const r = reports[0];
    expect(r.id).toBe('report-edit-1');
    expect(r.createdAt).toBe('2026-06-25T10:00:00.000Z');
    expect(r.rowRevision).toBe(4);
    // Never a regression: strictly loaded + 1.
    expect(r.rowRevision).toBeGreaterThan(3);
    expect(r.syncState).toBe('dirty');
    expect(r.syncAttempts).toBe(0);
    expect(r.lastSyncError).toBeNull();
  });
});

describe('no draft leakage (case 5)', () => {
  it('leaves a pre-existing fresh draft for the same key untouched after an edit save', async () => {
    // A separate in-progress NEW draft for the same matchKey:scoutId:team key.
    const draftKey = 'qm1:scout-1:254';
    await saveDraft(draftKey, {
      bursts: [{ startMs: 0, endMs: 500, rate: 4, window: 'auto' }],
      inactiveFirst: true,
      rate: 2,
      deferred: { climbLevel: 1 },
    });
    await saveReport(makeSavedReport());

    const { result } = renderHook(() =>
      useCaptureSession({ ...target, editingReportId: 'report-edit-1' }),
    );
    await waitFor(() => expect(result.current.bursts.length).toBe(2));
    await act(async () => {
      await result.current.save();
    });

    const draft = await getDraft(draftKey);
    expect(draft).toBeDefined();
    const state = draft!.state as { bursts: FuelBurst[]; deferred: { climbLevel: number } };
    expect(state.bursts).toHaveLength(1);
    expect(state.deferred.climbLevel).toBe(1);
  });
});

describe('mapReport carries the bumped revision (case 6)', () => {
  it('toUpsertPayload reports row_revision 4 and deleted false for an edited report', async () => {
    await saveReport(makeSavedReport());
    const { result } = renderHook(() =>
      useCaptureSession({ ...target, editingReportId: 'report-edit-1' }),
    );
    await waitFor(() => expect(result.current.bursts.length).toBe(2));
    await act(async () => {
      await result.current.save();
    });
    const edited = (await getReport('report-edit-1'))!;
    const payload = toUpsertPayload(edited);
    expect(payload.row_revision).toBe(4);
    expect(payload.deleted).toBe(false);
  });
});

describe('fresh capture unaffected (case 7)', () => {
  it('mounting without editingReportId produces a new UUID id and rowRevision 1', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.setInactiveFirst(false));
    let id = '';
    await act(async () => {
      id = await result.current.save();
    });
    const reports = await listReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe(id);
    expect(id).not.toBe('report-edit-1');
    expect(reports[0].rowRevision).toBe(1);
  });
});

describe('monotonic across re-edits (case 8)', () => {
  it('two consecutive edits bump rev by exactly 1 each (never repeating)', async () => {
    // Seed at rev 1 so this is the documented "2 then 3" sequence.
    await saveReport(makeSavedReport({ rowRevision: 1 }));

    const first = renderHook(() =>
      useCaptureSession({ ...target, editingReportId: 'report-edit-1' }),
    );
    await waitFor(() => expect(first.result.current.bursts.length).toBe(2));
    await act(async () => {
      await first.result.current.save();
    });
    let r = (await getReport('report-edit-1'))!;
    expect(r.rowRevision).toBe(2);

    // A fresh session on the now-rev-2 saved row; editing again must land rev 3.
    const second = renderHook(() =>
      useCaptureSession({ ...target, editingReportId: 'report-edit-1' }),
    );
    await waitFor(() => expect(second.result.current.bursts.length).toBe(2));
    await act(async () => {
      await second.result.current.save();
    });
    r = (await getReport('report-edit-1'))!;
    expect(r.rowRevision).toBe(3);
  });
});
