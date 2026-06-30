import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeAggregates,
  SCHEMA_VERSION,
  type FuelBurst,
  type TimeInterval,
  type MatchReportInputs,
} from '@/scoring';
import { useMatchClock, windowForBurst } from '@/capture/clock';
import { saveDraft, getDraft, deleteDraft, saveReport, getReport } from '@/db/localStore';
import type { LocalMatchReport } from '@/db/types';

export interface CaptureTarget {
  eventKey: string;
  matchKey: string;
  scoutId: string;
  // Display name of the scout, persisted into the report so the server can
  // re-resolve an orphaned scout_id by name (see upsert_match_report 0030).
  scoutName?: string;
  targetTeamNumber: number;
  allianceColor: 'red' | 'blue';
  station: 1 | 2 | 3;
  // Set when this session is RE-OPENING an existing submitted report for
  // correction. The load-existing effect reconstitutes session state from that
  // report (instead of resuming a draft), and save() rewrites it in place with a
  // bumped revision. See docs/plans/report-correction.md.
  editingReportId?: string;
}

interface DeferredState {
  climbLevel: 0 | 1 | 2 | 3;
  climbAttempted: boolean;
  climbSuccess: boolean;
  intakeSources: string[];
  maxFuelCapacityObserved: number;
  defenseRating: 0 | 1 | 2 | 3;
  defenseDurationMs: number;
  defendedDurationMs: number;
  defenseIntervals: TimeInterval[];
  defendedIntervals: TimeInterval[];
  pins: number;
  foulsMinor: number;
  foulsMajor: number;
  foulReasons: string[];
  noShow: boolean;
  died: boolean;
  tipped: boolean;
  droppedFuel: boolean;
  fedCorral: boolean;
  autoStartPosition: { x: number; y: number } | null;
  autoPath: { x: number; y: number }[] | null;
  autoLeftStartingLine: boolean;
  autoClimbLevel1: boolean;
  notes: string;
}

const initialDeferred: DeferredState = {
  climbLevel: 0,
  climbAttempted: false,
  climbSuccess: false,
  intakeSources: [],
  maxFuelCapacityObserved: 0,
  defenseRating: 0,
  defenseDurationMs: 0,
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
  autoStartPosition: null,
  autoPath: null,
  autoLeftStartingLine: false,
  autoClimbLevel1: false,
  notes: '',
};

interface DraftPayload {
  bursts: FuelBurst[];
  inactiveFirst: boolean | null;
  rate: number;
  deferred: DeferredState;
  // Persisted via a ref inside persistDraft (see below) so existing call sites
  // that pass only the fuel fields don't drop feeding data.
  feedingBursts?: FuelBurst[];
}

export function useCaptureSession(target: CaptureTarget) {
  const clock = useMatchClock();
  const draftKey = useMemo(
    () => `${target.matchKey}:${target.scoutId}:${target.targetTeamNumber}`,
    [target.matchKey, target.scoutId, target.targetTeamNumber],
  );

  const [bursts, setBursts] = useState<FuelBurst[]>([]);
  const [feedingBursts, setFeedingBursts] = useState<FuelBurst[]>([]);
  // Mirror of feedingBursts so persistDraft can always write the current value
  // without every fuel/deferred setter having to thread it through.
  const feedingBurstsRef = useRef<FuelBurst[]>([]);
  const [inactiveFirst, setInactiveFirstState] = useState<boolean | null>(null);
  const [rate, setRateState] = useState<number>(1);
  const [deferred, setDeferred] = useState<DeferredState>(initialDeferred);
  const [draftResumed, setDraftResumed] = useState(false);

  const holdStartMsRef = useRef<number | null>(null);
  // State mirror of the hold-start so the live ball-count readout re-renders
  // when a shoot gesture begins/ends. holdStartMs is the phase-elapsed ms the
  // current hold began at (null when not actively shooting).
  const [holdStartMs, setHoldStartMs] = useState<number | null>(null);
  // Fuel is INTEGRATED over the hold (∫ rate·dt), so dragging the BPS up late in
  // a hold only adds balls for the time since the last rate change — it does NOT
  // retroactively re-price the whole hold at the new rate (the old behavior made
  // the count spike when you slid to 30 after holding low for a while).
  //   holdAccumRef    — balls integrated from completed sub-segments of this hold
  //   holdRateRef     — the rate currently being applied
  //   holdSampleMsRef — phase-elapsed ms the current rate segment began
  const holdAccumRef = useRef(0);
  const holdRateRef = useRef(0);
  const holdSampleMsRef = useRef<number | null>(null);
  const [, setHoldTick] = useState(0); // force re-render of the live readout
  const hydratedRef = useRef(false);

  // ── Edit-mode (report correction) refs ───────────────────────────────────────
  // Populated by the load-existing effect when target.editingReportId is set. They
  // carry the loaded report's identity so save() rewrites it IN PLACE (same id,
  // original createdAt for stable local sort, rowRevision+1). When editIdRef is
  // null the session is a fresh capture and behaves exactly as before.
  const editIdRef = useRef<string | null>(null);
  const editCreatedAtRef = useRef<string | null>(null);
  const editRevRef = useRef<number>(0);
  // teleopClockUnconfirmed from the loaded report. The live clock starts this at
  // false and edit mode skips the live screen, so save() reads this ref instead of
  // the clock when editing (preserving the original report's value).
  const editTeleopUnconfirmedRef = useRef<boolean>(false);

  // Feeding hold accumulators — exact mirror of the fuel-hold integral above, but
  // for balls FED to the human player rather than scored. Independent so a robot
  // can feed and score in overlapping gestures on two sliders.
  const feedStartMsRef = useRef<number | null>(null);
  const [feedStartMs, setFeedStartMs] = useState<number | null>(null);
  const feedAccumRef = useRef(0);
  const feedRateRef = useRef(0);
  const feedSampleMsRef = useRef<number | null>(null);

  // Open-interval starts for the defense / getting-defended timers. Each holds the
  // phase-elapsed ms AND the phase it began in, so the committed interval lands on
  // the right part of the match timeline. `wall` is a monotonic performance.now()
  // timestamp at begin so the committed DURATION is correct even when the interval
  // spans the auto→teleop boundary (the phase-elapsed clock resets across phases,
  // which would otherwise compute a 0/negative duration and silently drop it).
  const defenseStartRef = useRef<{ ms: number; phase: 'auto' | 'teleop'; wall: number } | null>(null);
  const defendedStartRef = useRef<{ ms: number; phase: 'auto' | 'teleop'; wall: number } | null>(null);

  const phaseElapsed = (): number =>
    clock.state.phase === 'teleop' ? clock.teleopElapsedMs : clock.autoElapsedMs;

  // Reconstitute live session state from an existing report. Shared primitive so
  // other report-loading flows (e.g. multi-scout-reconciliation) can reuse it
  // rather than fork their own. Reads only fields the deferred review depends on;
  // the raw fuel/feeding bursts and inactiveFirst are carried through unchanged so
  // recomputed aggregates stay correct. teleopClockUnconfirmed is the one field the
  // live screen would otherwise seed — but save() reads it from the live clock, and
  // edit mode skips the live screen, so it is re-applied to the clock state here.
  const reconstituteFrom = useCallback(
    (r: LocalMatchReport) => {
      setBursts(r.fuelBursts ?? []);
      const feeds = r.feedingBursts ?? [];
      setFeedingBursts(feeds);
      feedingBurstsRef.current = feeds;
      setInactiveFirstState(r.inactiveFirst);
      setDeferred({
        ...initialDeferred,
        climbLevel: r.climbLevel,
        climbAttempted: r.climbAttempted,
        climbSuccess: r.climbSuccess,
        intakeSources: r.intakeSources ?? [],
        maxFuelCapacityObserved: r.maxFuelCapacityObserved,
        defenseRating: r.defenseRating,
        defenseDurationMs: r.defenseDurationMs,
        defendedDurationMs: r.defendedDurationMs,
        defenseIntervals: r.defenseIntervals ?? [],
        defendedIntervals: r.defendedIntervals ?? [],
        pins: r.pins,
        foulsMinor: r.foulsMinor,
        foulsMajor: r.foulsMajor,
        foulReasons: r.foulReasons ?? [],
        noShow: r.noShow,
        died: r.died,
        tipped: r.tipped,
        droppedFuel: r.droppedFuel,
        fedCorral: r.fedCorral,
        autoStartPosition: r.autoStartPosition,
        autoPath: r.autoPath,
        autoLeftStartingLine: r.autoLeftStartingLine,
        autoClimbLevel1: r.autoClimbLevel1,
        notes: r.notes,
      });
      // save() reads clock.state.teleopClockUnconfirmed for fresh captures; in edit
      // mode it reads this ref so the rewritten report preserves the loaded value
      // (the live screen — the only thing that seeds the clock flag — is skipped).
      editTeleopUnconfirmedRef.current = r.teleopClockUnconfirmed;
    },
    [],
  );

  // Load-existing (edit/correction) effect: when editing, reconstitute from the
  // report and stash its identity in refs. Runs INSTEAD of the draft-resume effect.
  useEffect(() => {
    const editId = target.editingReportId;
    if (!editId) return;
    let cancelled = false;
    void (async () => {
      const r = await getReport(editId);
      if (cancelled || !r) {
        hydratedRef.current = true;
        return;
      }
      editIdRef.current = r.id;
      editCreatedAtRef.current = r.createdAt;
      editRevRef.current = r.rowRevision ?? 1;
      reconstituteFrom(r);
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [target.editingReportId, reconstituteFrom]);

  // Resume an existing draft on mount.
  useEffect(() => {
    // In edit mode the load-existing effect owns hydration; never resume a draft.
    if (target.editingReportId) return;
    let cancelled = false;
    void (async () => {
      const d = await getDraft(draftKey);
      if (cancelled) {
        return;
      }
      if (d && d.state && typeof d.state === 'object') {
        const s = d.state as Partial<DraftPayload>;
        if (s.bursts) {
          setBursts(s.bursts);
        }
        if (s.feedingBursts) {
          setFeedingBursts(s.feedingBursts);
          feedingBurstsRef.current = s.feedingBursts;
        }
        if (s.inactiveFirst !== undefined) {
          setInactiveFirstState(s.inactiveFirst);
        }
        if (typeof s.rate === 'number') {
          setRateState(s.rate);
        }
        if (s.deferred) {
          setDeferred({ ...initialDeferred, ...s.deferred });
        }
        setDraftResumed(true);
      }
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  // Persist the full CaptureTarget alongside the mutable draft state so a
  // resumed draft reconstructs its event/alliance/station/team from the draft
  // itself — never from whatever the manual-pick form happens to hold. Without
  // this, a resumed match saves with the wrong alliance/station and an empty
  // event_key (which later fails the server's event-scoped RLS insert).
  const persistDraft = useCallback(
    (next: DraftPayload) => {
      // Edit mode reconstitutes from the report, never a draft. Skip all draft
      // writes so the loaded edit never leaks into the draft store and resurrects
      // later as a phantom new draft (and so a pre-existing fresh draft for the
      // same matchKey:scoutId:team key survives the edit untouched).
      if (editIdRef.current) return;
      // Always pin the current feedingBursts from the ref so callers that only
      // know about fuel/deferred state don't wipe feeding data on persist.
      void saveDraft(draftKey, {
        ...next,
        feedingBursts: next.feedingBursts ?? feedingBurstsRef.current,
        target,
      });
    },
    [draftKey, target],
  );

  const setInactiveFirst = useCallback(
    (b: boolean) => {
      setInactiveFirstState(b);
      persistDraft({ bursts, inactiveFirst: b, rate, deferred });
    },
    [bursts, rate, deferred, persistDraft],
  );

  const setRate = useCallback(
    (r: number) => {
      setRateState(r);
      persistDraft({ bursts, inactiveFirst, rate: r, deferred });
    },
    [bursts, inactiveFirst, deferred, persistDraft],
  );

  const holdStart = useCallback(() => {
    const start = phaseElapsed();
    holdStartMsRef.current = start;
    setHoldStartMs(start);
    holdAccumRef.current = 0;
    holdRateRef.current = 0;
    holdSampleMsRef.current = start;
  }, [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs]);

  // Called as the slider rate changes mid-hold. Integrates the PREVIOUS rate over
  // the interval that just elapsed, then switches to the new rate. This is what
  // makes the running count grow at the instantaneous BPS instead of spiking.
  const holdSample = useCallback(
    (nextRate: number) => {
      if (holdSampleMsRef.current === null) return; // not holding
      const now = phaseElapsed();
      holdAccumRef.current +=
        (holdRateRef.current * Math.max(0, now - holdSampleMsRef.current)) / 1000;
      holdRateRef.current = nextRate;
      holdSampleMsRef.current = now;
      setHoldTick((t) => t + 1);
    },
    [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs],
  );

  // rateOverride is the slider's final rate; it's applied to the final segment
  // (since the last sample) only — never retroactively to the whole hold.
  const holdEnd = useCallback((rateOverride?: number) => {
    const start = holdStartMsRef.current;
    if (start === null) {
      return;
    }
    const end = phaseElapsed();
    const finalSegRate = rateOverride ?? holdRateRef.current;
    const sampleMs = holdSampleMsRef.current ?? start;
    const balls =
      holdAccumRef.current + (finalSegRate * Math.max(0, end - sampleMs)) / 1000;
    holdStartMsRef.current = null;
    setHoldStartMs(null);
    holdAccumRef.current = 0;
    holdRateRef.current = 0;
    holdSampleMsRef.current = null;

    const durationMs = Math.max(0, end - start);
    // Store an EFFECTIVE constant rate so the existing burst model
    // (rate*(end-start)/1000) reproduces the integrated ball count exactly.
    const effRate = durationMs > 0 ? (balls * 1000) / durationMs : 0;
    const window = windowForBurst(clock.state.phase, clock.teleopElapsedMs);
    const burst: FuelBurst = { startMs: start, endMs: Math.max(end, start), rate: effRate, window };
    const nextBursts = [...bursts, burst];
    setBursts(nextBursts);
    persistDraft({ bursts: nextBursts, inactiveFirst, rate, deferred });
  }, [
    clock.state.phase,
    clock.teleopElapsedMs,
    clock.autoElapsedMs,
    rate,
    bursts,
    inactiveFirst,
    deferred,
    persistDraft,
  ]);

  // ── Feeding slider (mirrors the fuel hold integral) ──────────────────────────
  const feedHoldStart = useCallback(() => {
    const start = phaseElapsed();
    feedStartMsRef.current = start;
    setFeedStartMs(start);
    feedAccumRef.current = 0;
    feedRateRef.current = 0;
    feedSampleMsRef.current = start;
  }, [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs]);

  const feedHoldSample = useCallback(
    (nextRate: number) => {
      if (feedSampleMsRef.current === null) return;
      const now = phaseElapsed();
      feedAccumRef.current +=
        (feedRateRef.current * Math.max(0, now - feedSampleMsRef.current)) / 1000;
      feedRateRef.current = nextRate;
      feedSampleMsRef.current = now;
      setHoldTick((t) => t + 1);
    },
    [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs],
  );

  const feedHoldEnd = useCallback(
    (rateOverride?: number) => {
      const start = feedStartMsRef.current;
      if (start === null) return;
      const end = phaseElapsed();
      const finalSegRate = rateOverride ?? feedRateRef.current;
      const sampleMs = feedSampleMsRef.current ?? start;
      const balls = feedAccumRef.current + (finalSegRate * Math.max(0, end - sampleMs)) / 1000;
      feedStartMsRef.current = null;
      setFeedStartMs(null);
      feedAccumRef.current = 0;
      feedRateRef.current = 0;
      feedSampleMsRef.current = null;

      const durationMs = Math.max(0, end - start);
      const effRate = durationMs > 0 ? (balls * 1000) / durationMs : 0;
      const window = windowForBurst(clock.state.phase, clock.teleopElapsedMs);
      const burst: FuelBurst = { startMs: start, endMs: Math.max(end, start), rate: effRate, window };
      const next = [...feedingBurstsRef.current, burst];
      feedingBurstsRef.current = next;
      setFeedingBursts(next);
      persistDraft({ bursts, inactiveFirst, rate, deferred, feedingBursts: next });
    },
    [
      clock.state.phase,
      clock.teleopElapsedMs,
      clock.autoElapsedMs,
      bursts,
      inactiveFirst,
      rate,
      deferred,
      persistDraft,
    ],
  );

  // ── Defense / getting-defended timers (record timestamped intervals) ──────────
  const phaseTag = (): 'auto' | 'teleop' =>
    clock.state.phase === 'teleop' ? 'teleop' : 'auto';

  const commitInterval = useCallback(
    (
      startRef: typeof defenseStartRef,
      durationKey: 'defenseDurationMs' | 'defendedDurationMs',
      intervalsKey: 'defenseIntervals' | 'defendedIntervals',
    ) => {
      const s = startRef.current;
      if (!s) return;
      startRef.current = null;
      const startMs = s.ms;
      // Duration from the monotonic wall clock so an interval that began in auto
      // and ended in teleop (the phase-elapsed clock resets at the boundary) keeps
      // its true length instead of computing ≤ 0 and being dropped.
      const wallDurationMs = Math.max(0, performance.now() - s.wall);
      const samePhase = phaseTag() === s.phase;
      // Same phase: end on the live phase clock (keeps timeline coords exact).
      // Crossed the boundary: anchor end off start + the real elapsed duration.
      const endMs = samePhase ? Math.max(phaseElapsed(), startMs) : startMs + wallDurationMs;
      const durationMs = samePhase ? Math.max(0, endMs - startMs) : wallDurationMs;
      if (durationMs <= 0) return;
      setDeferred((prev) => {
        const next: DeferredState = {
          ...prev,
          [durationKey]: prev[durationKey] + durationMs,
          [intervalsKey]: [...prev[intervalsKey], { startMs, endMs, phase: s.phase }],
        };
        persistDraft({ bursts, inactiveFirst, rate, deferred: next });
        return next;
      });
    },
    [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs, bursts, inactiveFirst, rate, persistDraft],
  );

  const beginDefense = useCallback(() => {
    if (!defenseStartRef.current)
      defenseStartRef.current = { ms: phaseElapsed(), phase: phaseTag(), wall: performance.now() };
  }, [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs]);
  const endDefense = useCallback(
    () => commitInterval(defenseStartRef, 'defenseDurationMs', 'defenseIntervals'),
    [commitInterval],
  );
  const beginDefended = useCallback(() => {
    if (!defendedStartRef.current)
      defendedStartRef.current = { ms: phaseElapsed(), phase: phaseTag(), wall: performance.now() };
  }, [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs]);
  const endDefended = useCallback(
    () => commitInterval(defendedStartRef, 'defendedDurationMs', 'defendedIntervals'),
    [commitInterval],
  );

  // ── Undo helpers (the timeline records the action; these reverse its effect) ──
  // Pop the most-recent committed FUEL burst and re-persist. Without this the
  // Undo button consumed the 'burst' timeline event but never removed the burst,
  // leaving an over-counted, unrecoverable burst in the saved report.
  const undoLastBurst = useCallback(() => {
    setBursts((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice(0, -1);
      persistDraft({ bursts: next, inactiveFirst, rate, deferred });
      return next;
    });
  }, [inactiveFirst, rate, deferred, persistDraft]);

  // Pop the most-recent committed FEEDING burst (feeding was previously not
  // undoable at all — onShootEnd never recorded an undo event).
  const undoLastFeedingBurst = useCallback(() => {
    const prev = feedingBurstsRef.current;
    if (prev.length === 0) return;
    const next = prev.slice(0, -1);
    feedingBurstsRef.current = next;
    setFeedingBursts(next);
    persistDraft({ bursts, inactiveFirst, rate, deferred, feedingBursts: next });
  }, [bursts, inactiveFirst, rate, deferred, persistDraft]);

  // Atomically pop the last defense/being-defended interval AND subtract that
  // exact interval's duration from the running total, so the uploaded report's
  // intervals always equal its duration. (The old undo only adjusted the scalar
  // by CaptureScreen's separately-measured ms and left the interval in the report.)
  const undoLastDefenseInterval = useCallback(() => {
    setDeferred((prev) => {
      const ivs = prev.defenseIntervals;
      if (ivs.length === 0) return prev;
      const last = ivs[ivs.length - 1];
      const dur = Math.max(0, last.endMs - last.startMs);
      const next: DeferredState = {
        ...prev,
        defenseIntervals: ivs.slice(0, -1),
        defenseDurationMs: Math.max(0, prev.defenseDurationMs - dur),
      };
      persistDraft({ bursts, inactiveFirst, rate, deferred: next });
      return next;
    });
  }, [bursts, inactiveFirst, rate, persistDraft]);

  const undoLastDefendedInterval = useCallback(() => {
    setDeferred((prev) => {
      const ivs = prev.defendedIntervals;
      if (ivs.length === 0) return prev;
      const last = ivs[ivs.length - 1];
      const dur = Math.max(0, last.endMs - last.startMs);
      const next: DeferredState = {
        ...prev,
        defendedIntervals: ivs.slice(0, -1),
        defendedDurationMs: Math.max(0, prev.defendedDurationMs - dur),
      };
      persistDraft({ bursts, inactiveFirst, rate, deferred: next });
      return next;
    });
  }, [bursts, inactiveFirst, rate, persistDraft]);

  const updateDeferred = useCallback(
    <K extends keyof DeferredState>(key: K, value: DeferredState[K]) => {
      setDeferred((prev) => {
        const next = { ...prev, [key]: value };
        persistDraft({ bursts, inactiveFirst, rate, deferred: next });
        return next;
      });
    },
    [bursts, inactiveFirst, rate, persistDraft],
  );

  const reAnchorCue = useCallback(() => {
    clock.reAnchor();
  }, [clock]);

  // Actual accumulated BALL COUNT from committed bursts: sum of
  // rate*(endMs-startMs)/1000, rounded. (NOT bursts.length.)
  const committedFuelCount = useMemo(
    () =>
      Math.round(
        bursts.reduce(
          (sum, b) => sum + (b.rate * (b.endMs - b.startMs)) / 1000,
          0,
        ),
      ),
    [bursts],
  );

  // Committed balls PLUS the in-progress integral of the active hold, so the
  // readout grows live at the current BPS. Recomputed each render (the clock
  // ticks ~5x/sec and holdSample bumps a tick on every rate change).
  const inProgressFuel =
    holdStartMsRef.current !== null && holdSampleMsRef.current !== null
      ? holdAccumRef.current +
        (holdRateRef.current * Math.max(0, phaseElapsed() - holdSampleMsRef.current)) / 1000
      : 0;
  const liveFuelCount = Math.round(committedFuelCount + inProgressFuel);

  const committedFeedingCount = useMemo(
    () =>
      Math.round(
        feedingBursts.reduce((sum, b) => sum + (b.rate * (b.endMs - b.startMs)) / 1000, 0),
      ),
    [feedingBursts],
  );
  const inProgressFeeding =
    feedStartMsRef.current !== null && feedSampleMsRef.current !== null
      ? feedAccumRef.current +
        (feedRateRef.current * Math.max(0, phaseElapsed() - feedSampleMsRef.current)) / 1000
      : 0;
  const liveFeedingCount = Math.round(committedFeedingCount + inProgressFeeding);

  const save = useCallback(async (): Promise<string> => {
    const inputs: MatchReportInputs = {
      schemaVersion: SCHEMA_VERSION,
      inactiveFirst: inactiveFirst === null ? false : inactiveFirst,
      fuelBursts: bursts,
      climbLevel: deferred.climbLevel,
      autoClimbLevel1: deferred.autoClimbLevel1,
    };
    const agg = computeAggregates(inputs);
    // Edit (correction) mode: rewrite the loaded report IN PLACE — same id, keep
    // the original createdAt (stable local sort only; NOT sent over the wire), and
    // bump rowRevision so the revision-guarded upsert UPDATEs instead of no-opping.
    const editing = editIdRef.current !== null;
    const report: LocalMatchReport = {
      id: editing ? editIdRef.current! : crypto.randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      appVersion: '2.0.0',
      deviceId: 'device-local',
      createdAt: editing ? editCreatedAtRef.current! : new Date().toISOString(),
      eventKey: target.eventKey,
      matchKey: target.matchKey,
      scoutId: target.scoutId,
      scoutName: target.scoutName,
      targetTeamNumber: target.targetTeamNumber,
      allianceColor: target.allianceColor,
      station: target.station,
      inactiveFirst,
      inactiveFirstSource: inactiveFirst === null ? null : 'scout',
      teleopClockUnconfirmed: editing
        ? editTeleopUnconfirmedRef.current
        : clock.state.teleopClockUnconfirmed,
      fuelBursts: bursts,
      feedingBursts,
      autoFuel: agg.autoFuel,
      teleopFuelActive: agg.teleopFuelActive,
      teleopFuelInactive: agg.teleopFuelInactive,
      endgameFuel: agg.endgameFuel,
      fuelByShift: agg.fuelByShift,
      fuelPoints: agg.fuelPoints,
      climbLevel: deferred.climbLevel,
      climbAttempted: deferred.climbAttempted,
      climbSuccess: deferred.climbSuccess,
      autoStartPosition: deferred.autoStartPosition,
      autoPath: deferred.autoPath,
      autoLeftStartingLine: deferred.autoLeftStartingLine,
      autoClimbLevel1: deferred.autoClimbLevel1,
      intakeSources: deferred.intakeSources,
      maxFuelCapacityObserved: deferred.maxFuelCapacityObserved,
      defenseRating: deferred.defenseRating,
      defenseDurationMs: deferred.defenseDurationMs,
      defendedDurationMs: deferred.defendedDurationMs,
      defenseIntervals: deferred.defenseIntervals,
      defendedIntervals: deferred.defendedIntervals,
      pins: deferred.pins,
      foulsMinor: deferred.foulsMinor,
      foulsMajor: deferred.foulsMajor,
      foulReasons: deferred.foulReasons,
      noShow: deferred.noShow,
      died: deferred.died,
      tipped: deferred.tipped,
      droppedFuel: deferred.droppedFuel,
      fedCorral: deferred.fedCorral,
      notes: deferred.notes,
      // Rate-derived fuel estimate -> low confidence.
      fuelEstimateConfidence: 0.3,
      syncState: 'dirty',
      rowRevision: editing ? editRevRef.current + 1 : 1,
      syncAttempts: 0,
      lastSyncError: null,
    };
    await saveReport(report);
    // Edit mode never wrote a live-capture draft (persistDraft short-circuits), so
    // there is no draft to delete; leaving any unrelated fresh draft for the same
    // key intact. Fresh captures still clear their own draft.
    if (!editing) {
      await deleteDraft(draftKey);
    }
    return report.id;
  }, [inactiveFirst, bursts, feedingBursts, deferred, clock.state.teleopClockUnconfirmed, target, draftKey]);

  return {
    clock,
    // Alliance color drives the half-field placement picker (red = left half,
    // blue = right half). Surfaced from the target so CaptureScreen doesn't need
    // the whole target threaded through.
    allianceColor: target.allianceColor,
    // Event + target team are surfaced so the Review auto step can look up the
    // team's previously-scouted auto routines (the "pick a known auto" picker)
    // without threading the whole target through.
    eventKey: target.eventKey,
    targetTeamNumber: target.targetTeamNumber,
    // The match being scouted — used to exclude this same match from the
    // known-auto history (a resumed/edited report shouldn't offer its own auto).
    matchKey: target.matchKey,
    bursts,
    holdStart,
    holdSample,
    holdEnd,
    holdStartMs,
    committedFuelCount,
    liveFuelCount,
    // Feeding slider (parallel to the fuel/scoring slider).
    feedingBursts,
    feedHoldStart,
    feedHoldSample,
    feedHoldEnd,
    feedStartMs,
    committedFeedingCount,
    liveFeedingCount,
    rate,
    setRate,
    inactiveFirst,
    setInactiveFirst,
    climbLevel: deferred.climbLevel,
    setClimbLevel: (v: 0 | 1 | 2 | 3) => updateDeferred('climbLevel', v),
    climbAttempted: deferred.climbAttempted,
    setClimbAttempted: (v: boolean) => updateDeferred('climbAttempted', v),
    climbSuccess: deferred.climbSuccess,
    setClimbSuccess: (v: boolean) => updateDeferred('climbSuccess', v),
    intakeSources: deferred.intakeSources,
    setIntakeSources: (v: string[]) => updateDeferred('intakeSources', v),
    maxFuelCapacityObserved: deferred.maxFuelCapacityObserved,
    setMaxFuelCapacityObserved: (v: number) => updateDeferred('maxFuelCapacityObserved', v),
    defenseRating: deferred.defenseRating,
    setDefenseRating: (v: 0 | 1 | 2 | 3) => updateDeferred('defenseRating', v),
    defenseDurationMs: deferred.defenseDurationMs,
    setDefenseDurationMs: (v: number) => updateDeferred('defenseDurationMs', v),
    defendedDurationMs: deferred.defendedDurationMs,
    setDefendedDurationMs: (v: number) => updateDeferred('defendedDurationMs', v),
    // Timestamped interval timers — call begin* on activate, end* on commit.
    defenseIntervals: deferred.defenseIntervals,
    defendedIntervals: deferred.defendedIntervals,
    beginDefense,
    endDefense,
    beginDefended,
    endDefended,
    // Undo reversers (wired to the capture timeline's Undo button).
    undoLastBurst,
    undoLastFeedingBurst,
    undoLastDefenseInterval,
    undoLastDefendedInterval,
    pins: deferred.pins,
    setPins: (v: number) => updateDeferred('pins', v),
    foulsMinor: deferred.foulsMinor,
    setFoulsMinor: (v: number) => updateDeferred('foulsMinor', v),
    foulsMajor: deferred.foulsMajor,
    setFoulsMajor: (v: number) => updateDeferred('foulsMajor', v),
    foulReasons: deferred.foulReasons,
    setFoulReasons: (v: string[]) => updateDeferred('foulReasons', v),
    noShow: deferred.noShow,
    setNoShow: (v: boolean) => updateDeferred('noShow', v),
    died: deferred.died,
    setDied: (v: boolean) => updateDeferred('died', v),
    tipped: deferred.tipped,
    setTipped: (v: boolean) => updateDeferred('tipped', v),
    droppedFuel: deferred.droppedFuel,
    setDroppedFuel: (v: boolean) => updateDeferred('droppedFuel', v),
    fedCorral: deferred.fedCorral,
    setFedCorral: (v: boolean) => updateDeferred('fedCorral', v),
    autoStartPosition: deferred.autoStartPosition,
    setAutoStartPosition: (v: { x: number; y: number } | null) =>
      updateDeferred('autoStartPosition', v),
    autoPath: deferred.autoPath,
    setAutoPath: (v: { x: number; y: number }[] | null) => updateDeferred('autoPath', v),
    autoLeftStartingLine: deferred.autoLeftStartingLine,
    setAutoLeftStartingLine: (v: boolean) => updateDeferred('autoLeftStartingLine', v),
    autoClimbLevel1: deferred.autoClimbLevel1,
    setAutoClimbLevel1: (v: boolean) => updateDeferred('autoClimbLevel1', v),
    notes: deferred.notes,
    setNotes: (v: string) => updateDeferred('notes', v),
    save,
    reAnchorCue,
    draftResumed,
  };
}
