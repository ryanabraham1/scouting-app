import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useCaptureSession,
  adjustIntervalsTotal,
  type CaptureTarget,
} from '@/capture/useCaptureSession';
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

describe('useCaptureSession committedFuelCount', () => {
  it('sums rate*(endMs-startMs)/1000 over committed bursts (rounded)', async () => {
    await saveDraft('qm1:scout-1:254', {
      // 26 BPS for 1s => 26 balls; 10 BPS for 2s => 20 balls; total 46.
      bursts: [
        { startMs: 0, endMs: 1000, rate: 26, window: 'transition' },
        { startMs: 2000, endMs: 4000, rate: 10, window: 'shift1' },
      ],
      inactiveFirst: false,
      rate: 1,
      deferred: {},
    });
    const { result } = renderHook(() => useCaptureSession(target));
    await waitFor(() => expect(result.current.bursts).toHaveLength(2));
    expect(result.current.committedFuelCount).toBe(46);
  });

  it('exposes holdStartMs as the elapsed at hold start, null when idle', () => {
    const { result } = renderHook(() => useCaptureSession(target));
    expect(result.current.holdStartMs).toBeNull();
    act(() => result.current.clock.startAuto());
    act(() => result.current.holdStart());
    expect(result.current.holdStartMs).not.toBeNull();
    act(() => result.current.holdEnd(5));
    expect(result.current.holdStartMs).toBeNull();
  });
});

describe('useCaptureSession undo reversers (BUG-4 / BUG-7)', () => {
  it('undoLastBurst pops the most-recent fuel burst and drops the count', async () => {
    await saveDraft('qm1:scout-1:254', {
      bursts: [
        { startMs: 0, endMs: 1000, rate: 20, window: 'transition' }, // 20 balls
        { startMs: 2000, endMs: 3000, rate: 10, window: 'shift1' }, // 10 balls
      ],
      inactiveFirst: false,
      rate: 1,
      deferred: {},
    });
    const { result } = renderHook(() => useCaptureSession(target));
    await waitFor(() => expect(result.current.bursts).toHaveLength(2));
    expect(result.current.committedFuelCount).toBe(30);

    act(() => result.current.undoLastBurst());
    await waitFor(() => expect(result.current.bursts).toHaveLength(1));
    // The over-counted burst is actually removed (was a no-op before the fix).
    expect(result.current.committedFuelCount).toBe(20);
  });

  it('undoLastFeedingBurst pops the most-recent feeding burst', async () => {
    await saveDraft('qm1:scout-1:254', {
      bursts: [],
      inactiveFirst: false,
      rate: 1,
      deferred: {},
      feedingBursts: [
        { startMs: 0, endMs: 1000, rate: 5, window: 'transition' },
        { startMs: 1000, endMs: 2000, rate: 5, window: 'shift1' },
      ],
    });
    const { result } = renderHook(() => useCaptureSession(target));
    await waitFor(() => expect(result.current.feedingBursts).toHaveLength(2));

    act(() => result.current.undoLastFeedingBurst());
    await waitFor(() => expect(result.current.feedingBursts).toHaveLength(1));
  });

  it('undoLastDefenseInterval pops the interval AND subtracts its exact duration', async () => {
    await saveDraft('qm1:scout-1:254', {
      bursts: [],
      inactiveFirst: false,
      rate: 1,
      deferred: {
        defenseDurationMs: 5000,
        defenseIntervals: [
          { startMs: 0, endMs: 2000, phase: 'teleop' },
          { startMs: 3000, endMs: 6000, phase: 'teleop' }, // 3000ms — the one undone
        ],
      },
    });
    const { result } = renderHook(() => useCaptureSession(target));
    await waitFor(() => expect(result.current.defenseIntervals).toHaveLength(2));
    expect(result.current.defenseDurationMs).toBe(5000);

    act(() => result.current.undoLastDefenseInterval());
    await waitFor(() => expect(result.current.defenseIntervals).toHaveLength(1));
    // The interval is removed from the report AND the total equals the sum of the
    // remaining intervals (5000 - 3000 = 2000) — not just an approximate subtraction.
    expect(result.current.defenseDurationMs).toBe(2000);
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

describe('adjustIntervalsTotal (Review duration-edit interval re-fit)', () => {
  const iv = (startMs: number, endMs: number) =>
    ({ startMs, endMs, phase: 'teleop' as const });

  it('extends the LAST interval when the corrected total is larger', () => {
    const out = adjustIntervalsTotal([iv(0, 5000), iv(20000, 25000)], 14000);
    expect(out).toEqual([iv(0, 5000), iv(20000, 29000)]);
  });

  it('shrinks from the end (popping emptied intervals) when smaller', () => {
    const out = adjustIntervalsTotal([iv(0, 5000), iv(20000, 25000)], 3000);
    // 10000 → 3000: the last interval (5000) is fully consumed and dropped,
    // then the first shrinks by the remaining 2000.
    expect(out).toEqual([iv(0, 3000)]);
  });

  it('target 0 drops every interval', () => {
    expect(adjustIntervalsTotal([iv(0, 5000), iv(20000, 25000)], 0)).toEqual([]);
  });

  it('no-op when the total already matches (same array back)', () => {
    const ivs = [iv(0, 5000)];
    expect(adjustIntervalsTotal(ivs, 5000)).toBe(ivs);
  });

  it('an empty list stays empty (scalar-only reports keep no fabricated timeline)', () => {
    expect(adjustIntervalsTotal([], 9000)).toEqual([]);
  });
});

describe('useCaptureSession Review duration edits keep duration == Σ intervals', () => {
  it('setDefenseDurationMs re-fits defenseIntervals atomically (resumed live capture)', async () => {
    // A live capture recorded two defense stints (10s total), then the scout
    // hand-corrects the total to 8s on the Review step. The scalar AND the
    // intervals must both reflect it — shipping duration ≠ Σ intervals made the
    // match timeline disagree with the ranked totals.
    await saveDraft('qm1:scout-1:254', {
      bursts: [],
      inactiveFirst: false,
      rate: 1,
      deferred: {
        defenseDurationMs: 10000,
        defenseIntervals: [
          { startMs: 0, endMs: 5000, phase: 'teleop' },
          { startMs: 20000, endMs: 25000, phase: 'teleop' },
        ],
      },
    });
    const { result } = renderHook(() => useCaptureSession(target));
    await waitFor(() => expect(result.current.defenseDurationMs).toBe(10000));

    act(() => result.current.setDefenseDurationMs(8000));

    await waitFor(() => expect(result.current.defenseDurationMs).toBe(8000));
    // Correction absorbed at the END: first stint untouched, last shrinks.
    expect(result.current.defenseIntervals).toEqual([
      { startMs: 0, endMs: 5000, phase: 'teleop' },
      { startMs: 20000, endMs: 23000, phase: 'teleop' },
    ]);
  });

  it('setDefendedDurationMs on a scalar-only report leaves intervals empty', async () => {
    const { result } = renderHook(() => useCaptureSession(target));
    act(() => result.current.setDefendedDurationMs(6000));
    await waitFor(() => expect(result.current.defendedDurationMs).toBe(6000));
    expect(result.current.defendedIntervals).toEqual([]);
  });
});
