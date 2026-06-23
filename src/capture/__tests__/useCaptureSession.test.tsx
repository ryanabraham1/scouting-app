import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { db, getDraft, saveDraft, listReports } from '@/db/localStore';
import { computeAggregates, SCHEMA_VERSION } from '@/scoring';

const target: CaptureTarget = {
  eventKey: '2026demo',
  matchKey: 'qm1',
  scoutId: 'scout-1',
  targetTeamNumber: 254,
  allianceColor: 'red',
  station: 1,
};

beforeEach(async () => {
  await db.reports.clear();
  await db.drafts.clear();
});

describe('useCaptureSession initial state', () => {
  it('starts with empty bursts and null inactiveFirst', () => {
    const { result } = renderHook(() => useCaptureSession(target));
    expect(result.current.bursts).toEqual([]);
    expect(result.current.inactiveFirst).toBeNull();
    expect(result.current.draftResumed).toBe(false);
  });

  it('sets inactiveFirst and autosaves a draft', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.setInactiveFirst(true));
    expect(result.current.inactiveFirst).toBe(true);
    await waitFor(async () => {
      const d = await getDraft('qm1:scout-1:254');
      expect(d).toBeDefined();
    });
  });
});

describe('useCaptureSession burst tagging', () => {
  it('records an auto burst when phase is auto', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.clock.startAuto());
    act(() => result.current.holdStart());
    act(() => result.current.holdEnd());
    await waitFor(() => expect(result.current.bursts.length).toBe(1));
    expect(result.current.bursts[0].window).toBe('auto');
  });

  it('records a teleop burst tagged by teleop window', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.clock.startAuto());
    act(() => result.current.clock.markGo());
    act(() => result.current.holdStart());
    act(() => result.current.holdEnd());
    await waitFor(() => expect(result.current.bursts.length).toBe(1));
    expect(result.current.bursts[0].window).toBe('transition');
  });
});

describe('useCaptureSession.save', () => {
  it('writes a dirty LocalMatchReport with aggregates equal to scoring module', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.setInactiveFirst(false));
    act(() => result.current.clock.startAuto());
    act(() => result.current.clock.markGo());
    act(() => result.current.holdStart());
    act(() => result.current.holdEnd());
    await waitFor(() => expect(result.current.bursts.length).toBe(1));

    let id = '';
    await act(async () => {
      id = await result.current.save();
    });
    expect(id).toBeTruthy();

    const reports = await listReports();
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.syncState).toBe('dirty');
    expect(r.schemaVersion).toBe(SCHEMA_VERSION);

    const expected = computeAggregates({
      schemaVersion: SCHEMA_VERSION,
      inactiveFirst: false,
      fuelBursts: result.current.bursts,
      climbLevel: 0,
      autoClimbLevel1: false,
    });
    expect(r.fuelPoints).toBe(expected.fuelPoints);
    expect(r.fuelByShift).toEqual(expected.fuelByShift);
    expect(r.autoFuel).toBe(expected.autoFuel);
    expect(r.teleopFuelActive).toBe(expected.teleopFuelActive);
    expect(r.teleopFuelInactive).toBe(expected.teleopFuelInactive);
    expect(r.endgameFuel).toBe(expected.endgameFuel);

    const draft = await getDraft('qm1:scout-1:254');
    expect(draft).toBeUndefined();
  });
});

describe('useCaptureSession draft target', () => {
  it('persists the full capture target so a resumed report keeps its context', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.setInactiveFirst(true));
    await waitFor(async () => {
      const d = await getDraft('qm1:scout-1:254');
      expect((d?.state as { target?: CaptureTarget } | undefined)?.target).toEqual(target);
    });
  });
});

describe('useCaptureSession draft resume', () => {
  it('resumes an existing draft on mount', async () => {
    await saveDraft('qm1:scout-1:254', {
      bursts: [{ startMs: 0, endMs: 1000, rate: 2, window: 'auto' }],
      inactiveFirst: true,
      rate: 2,
      deferred: { climbLevel: 2 },
    });
    const { result } = renderHook(() => useCaptureSession(target));
    await waitFor(() => expect(result.current.draftResumed).toBe(true));
    expect(result.current.bursts).toHaveLength(1);
    expect(result.current.inactiveFirst).toBe(true);
    expect(result.current.climbLevel).toBe(2);
  });
});

describe('useCaptureSession reAnchorCue', () => {
  it('exposes reAnchorCue that maps now into the endgame window', () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.clock.startAuto());
    act(() => result.current.clock.markGo());
    act(() => result.current.reAnchorCue());
    expect(result.current.clock.window).toBe('endgame');
  });
});
