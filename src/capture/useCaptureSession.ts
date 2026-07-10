import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeAggregates,
  SCHEMA_VERSION,
  type FuelBurst,
  type TimeInterval,
  type MatchReportInputs,
} from '@/scoring';
import {
  AUTO_MS,
  TELEOP_MS,
  useMatchClock,
  windowForBurst,
  type MatchClockSnapshot,
} from '@/capture/clock';
import type { LocalMatchReport } from '@/db/types';
import { normalizeStoredRating, type QualitativeRating } from '@/ratings';
import {
  productionCaptureSessionStorage,
  type CaptureSessionStorage,
} from '@/capture/captureSessionStorage';

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
  defenseRating: QualitativeRating;
  driverSkill: QualitativeRating;
  agility: QualitativeRating;
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
  driverSkill: 0,
  agility: 0,
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

/**
 * Re-fit recorded intervals to a hand-corrected total duration so the uploaded
 * report keeps the invariant "Σ intervals == duration" (when intervals exist).
 * The correction is absorbed at the END — mirroring undo's pop-the-last
 * semantics — so the earlier intervals' true timeline positions survive:
 *   - increase → the last interval's end extends by the delta;
 *   - decrease → intervals shrink (and drop when emptied) from the end.
 * An empty list stays empty: a scalar entered in Review for a match with no
 * live-captured intervals has no known timeline placement, and fabricating one
 * would be worse than the (long-standing, downstream-tolerated) scalar-only
 * shape. Pure + exported for tests.
 */
export function adjustIntervalsTotal(
  intervals: TimeInterval[],
  targetMs: number,
): TimeInterval[] {
  if (intervals.length === 0) return intervals;
  const total = intervals.reduce((sum, iv) => sum + Math.max(0, iv.endMs - iv.startMs), 0);
  let delta = Math.max(0, targetMs) - total;
  if (delta === 0) return intervals;
  const out = intervals.map((iv) => ({ ...iv }));
  if (delta > 0) {
    out[out.length - 1] = {
      ...out[out.length - 1],
      endMs: out[out.length - 1].endMs + delta,
    };
    return out;
  }
  for (let i = out.length - 1; i >= 0 && delta < 0; i -= 1) {
    const dur = Math.max(0, out[i].endMs - out[i].startMs);
    const cut = Math.min(dur, -delta);
    out[i] = { ...out[i], endMs: out[i].endMs - cut };
    delta += cut;
    if (out[i].endMs - out[i].startMs <= 0) out.splice(i, 1);
  }
  return out;
}

interface DraftPayload {
  schemaVersion?: number;
  // Both burst arrays are persisted via refs inside persistDraft (see below), so
  // cross-domain call sites that only change rate/inactiveFirst/deferred/feeding
  // can omit the fuel `bursts` (and vice-versa) without dropping the other's data.
  bursts?: FuelBurst[];
  inactiveFirst: boolean | null;
  rate: number;
  deferred: DeferredState;
  feedingBursts?: FuelBurst[];
  captureSession?: CaptureSessionEnvelope;
}

export const CAPTURE_SESSION_VERSION = 1;
export type CaptureFlowStage = 'live' | 'review';

export interface CaptureSessionEnvelope {
  version: typeof CAPTURE_SESSION_VERSION;
  stage: CaptureFlowStage;
  reviewStep: number;
  placementComplete: boolean;
  showGo: boolean;
  clock: MatchClockSnapshot;
}

export interface CaptureSessionOptions {
  storage?: CaptureSessionStorage;
  /** Injectable time source for deterministic tests/practice checkpoints. */
  now?: () => number;
  initialStage?: CaptureFlowStage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function parseCaptureEnvelope(value: unknown): CaptureSessionEnvelope | null {
  if (!isRecord(value) || value.version !== CAPTURE_SESSION_VERSION) return null;
  const clock = value.clock;
  if (
    (value.stage !== 'live' && value.stage !== 'review') ||
    !Number.isInteger(value.reviewStep) ||
    !isFiniteInRange(value.reviewStep, 0, 4) ||
    typeof value.placementComplete !== 'boolean' ||
    typeof value.showGo !== 'boolean' ||
    !isRecord(clock) ||
    !['idle', 'auto', 'pause', 'teleop', 'done'].includes(String(clock.phase)) ||
    !isFiniteInRange(clock.autoElapsedMs, 0, AUTO_MS) ||
    !isFiniteInRange(clock.teleopElapsedMs, 0, TELEOP_MS) ||
    typeof clock.teleopClockUnconfirmed !== 'boolean'
  ) {
    return null;
  }
  return value as unknown as CaptureSessionEnvelope;
}

function draftValidationError(value: unknown): string | null {
  if (!isRecord(value)) return 'Draft payload is not an object.';
  if (
    typeof value.schemaVersion === 'number' &&
    value.schemaVersion > SCHEMA_VERSION
  ) {
    return `Draft schema ${value.schemaVersion} is newer than this app supports.`;
  }
  if (value.bursts !== undefined && !Array.isArray(value.bursts)) {
    return 'Draft fuel bursts are malformed.';
  }
  if (value.feedingBursts !== undefined && !Array.isArray(value.feedingBursts)) {
    return 'Draft feeding bursts are malformed.';
  }
  if (value.deferred !== undefined && !isRecord(value.deferred)) {
    return 'Draft review data is malformed.';
  }
  if (value.captureSession !== undefined) {
    if (
      isRecord(value.captureSession) &&
      typeof value.captureSession.version === 'number' &&
      value.captureSession.version > CAPTURE_SESSION_VERSION
    ) {
      return `Capture session ${value.captureSession.version} is newer than this app supports.`;
    }
    if (!parseCaptureEnvelope(value.captureSession)) {
      return 'Capture session navigation or clock data is malformed.';
    }
  }
  return null;
}

const activeDraftWriterGeneration = new Map<string, number>();
const draftWriteChains = new Map<string, Promise<void>>();

/**
 * Wait for every capture draft write that has already been queued.
 *
 * Capture-screen tests reuse the same IndexedDB draft key across cases. Their
 * teardown must drain the real serialized writer before clearing that key;
 * yielding one event-loop turn is not sufficient when several Dexie writes are
 * queued. Kept explicit (rather than adding a delay) so test isolation follows
 * the same durability boundary as production persistence.
 */
export async function flushCaptureSessionWritesForTests(): Promise<void> {
  await Promise.allSettled([...draftWriteChains.values()]);
}

function claimDraftWriter(draftKey: string): number {
  const generation = (activeDraftWriterGeneration.get(draftKey) ?? 0) + 1;
  activeDraftWriterGeneration.set(draftKey, generation);
  return generation;
}

export function useCaptureSession(target: CaptureTarget, options?: CaptureSessionOptions) {
  const storage = options?.storage ?? productionCaptureSessionStorage;
  const clock = useMatchClock(options?.now);
  const clockSnapshotRef = useRef(clock.snapshot);
  clockSnapshotRef.current = clock.snapshot;
  const restoreClock = clock.restore;
  const draftKey = useMemo(
    () => `${target.matchKey}:${target.scoutId}:${target.targetTeamNumber}`,
    [target.matchKey, target.scoutId, target.targetTeamNumber],
  );
  const writerGenerationRef = useRef<{ draftKey: string; generation: number } | null>(null);
  if (writerGenerationRef.current?.draftKey !== draftKey) {
    writerGenerationRef.current = {
      draftKey,
      generation: claimDraftWriter(draftKey),
    };
  }

  const [bursts, setBursts] = useState<FuelBurst[]>([]);
  const [feedingBursts, setFeedingBursts] = useState<FuelBurst[]>([]);
  // Mirror of feedingBursts so persistDraft can always write the current value
  // without every fuel/deferred setter having to thread it through.
  const feedingBurstsRef = useRef<FuelBurst[]>([]);
  // Same mirror for fuel bursts: cross-domain persist calls (feeding, deferred,
  // rate, inactiveFirst) must NOT pass a possibly-stale `bursts` closure — they
  // omit it and persistDraft fills the current array from this ref.
  const burstsRef = useRef<FuelBurst[]>([]);
  const [inactiveFirst, setInactiveFirstState] = useState<boolean | null>(null);
  const [rate, setRateState] = useState<number>(1);
  const [deferred, setDeferred] = useState<DeferredState>(initialDeferred);
  const deferredRef = useRef<DeferredState>(initialDeferred);
  deferredRef.current = deferred;
  const [draftResumed, setDraftResumed] = useState(false);
  const [hydrationStatus, setHydrationStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [storageError, setStorageError] = useState<string | null>(null);
  const [flowState, setFlowState] = useState(() => ({
    stage: options?.initialStage ?? ('live' as CaptureFlowStage),
    reviewStep: 0,
    placementComplete: options?.initialStage === 'review',
    showGo: false,
  }));
  const flowStateRef = useRef(flowState);
  flowStateRef.current = flowState;
  const mountedRef = useRef(true);
  const draftWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const sessionFinalizedRef = useRef(false);

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
  // Monotonic wall-clock stamp of the hold start, so a hold whose phase clock
  // jumped BACKWARDS mid-gesture (the 0:30 endgame cue re-anchors the teleop
  // clock) still commits its true duration instead of zeroing the balls out.
  const holdWallRef = useRef<number | null>(null);
  const [, setHoldTick] = useState(0); // force re-render of the live readout
  const hydratedRef = useRef(false);
  // A persist requested BEFORE hydration settles (a very fast first tap racing
  // the async draft/report load). Writing it through immediately would stomp a
  // stored draft with near-empty state (or, in edit mode — where editIdRef is
  // still null — write a phantom draft). It's parked here and flushed after
  // hydration iff no stored draft was found; otherwise the resumed state wins.
  const pendingPersistRef = useRef<DraftPayload | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const captureEnvelope = useCallback(
    (): CaptureSessionEnvelope => ({
      version: CAPTURE_SESSION_VERSION,
      ...flowStateRef.current,
      clock: clockSnapshotRef.current,
    }),
    [],
  );

  const queueDraftWrite = useCallback(
    (state: DraftPayload) => {
      if (sessionFinalizedRef.current) return;
      const payload = {
        ...state,
        schemaVersion: SCHEMA_VERSION,
        bursts: state.bursts ?? burstsRef.current,
        feedingBursts: state.feedingBursts ?? feedingBurstsRef.current,
        captureSession: captureEnvelope(),
        target,
      };
      const writerGeneration = writerGenerationRef.current?.generation;
      const previousWrite = draftWriteChains.get(draftKey) ?? Promise.resolve();
      const write = previousWrite.catch(() => undefined).then(async () => {
          if (activeDraftWriterGeneration.get(draftKey) !== writerGeneration) {
            return;
          }
          await storage.saveDraft(draftKey, payload);
        });
      const settledWrite = write.catch(() => {
          if (mountedRef.current) {
            setStorageError('Draft changes are not saved on this device.');
          }
        });
      draftWriteChains.set(draftKey, settledWrite);
      draftWriteChainRef.current = settledWrite;
    },
    [captureEnvelope, draftKey, storage, target],
  );

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
  const feedWallRef = useRef<number | null>(null);

  // While a hold is active, tick every animation frame so the live ball readout
  // climbs 1 at a time and reacts to the press within a frame. Without this the
  // readout only repaints on the 200ms clock tick — at 30 BPS that's a +6..8
  // jump per repaint, and a press-and-hold-still looks unregistered until the
  // next tick. (At 60fps the max per-frame delta is 0.5 balls, so the rounded
  // count can only ever step by 1.) Scoped to active holds so idle screens keep
  // the cheap 200ms cadence.
  const anyHoldActive = holdStartMs !== null || feedStartMs !== null;
  useEffect(() => {
    if (!anyHoldActive || typeof requestAnimationFrame !== 'function') return;
    let raf = requestAnimationFrame(function loop() {
      setHoldTick((t) => t + 1);
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [anyHoldActive]);

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
      const fuel = Array.isArray(r.fuelBursts) ? r.fuelBursts : [];
      setBursts(fuel);
      burstsRef.current = fuel;
      const feeds = Array.isArray(r.feedingBursts) ? r.feedingBursts : [];
      setFeedingBursts(feeds);
      feedingBurstsRef.current = feeds;
      setInactiveFirstState(r.inactiveFirst);
      setDeferred({
        ...initialDeferred,
        climbLevel: r.climbLevel,
        climbAttempted: r.climbAttempted,
        climbSuccess: r.climbSuccess,
        intakeSources: Array.isArray(r.intakeSources) ? r.intakeSources : [],
        maxFuelCapacityObserved: r.maxFuelCapacityObserved,
        defenseRating: r.defenseRating,
        driverSkill: r.driverSkill ?? 0,
        agility: r.agility ?? 0,
        defenseDurationMs: r.defenseDurationMs,
        defendedDurationMs: r.defendedDurationMs,
        defenseIntervals: Array.isArray(r.defenseIntervals) ? r.defenseIntervals : [],
        defendedIntervals: Array.isArray(r.defendedIntervals) ? r.defendedIntervals : [],
        pins: r.pins,
        foulsMinor: r.foulsMinor,
        foulsMajor: r.foulsMajor,
        foulReasons: Array.isArray(r.foulReasons) ? r.foulReasons : [],
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
      try {
        const r = await storage.getReport(editId);
        if (cancelled) return;
        if (!r) {
          setHydrationStatus('error');
          setStorageError('The report being edited is no longer available on this device.');
          hydratedRef.current = true;
          pendingPersistRef.current = null;
          return;
        }
        editIdRef.current = r.id;
        editCreatedAtRef.current = r.createdAt;
        editRevRef.current = r.rowRevision ?? 1;
        reconstituteFrom(r);
        hydratedRef.current = true;
        setHydrationStatus('ready');
        // Edit mode never writes drafts — discard any raced pre-hydration persist.
        pendingPersistRef.current = null;
      } catch {
        if (!cancelled) {
          hydratedRef.current = true;
          pendingPersistRef.current = null;
          setHydrationStatus('error');
          setStorageError('Saved report storage could not be opened. Nothing was overwritten.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.editingReportId, reconstituteFrom, storage]);

  // Resume an existing draft on mount.
  useEffect(() => {
    // In edit mode the load-existing effect owns hydration; never resume a draft.
    if (target.editingReportId) return;
    let cancelled = false;
    void (async () => {
      let d;
      try {
        d = await storage.getDraft(draftKey);
      } catch {
        if (!cancelled) {
          hydratedRef.current = true;
          pendingPersistRef.current = null;
          setHydrationStatus('error');
          setStorageError('Saved draft storage could not be opened. Nothing was overwritten.');
        }
        return;
      }
      if (cancelled) {
        return;
      }
      let found = Boolean(d);
      if (d && found) {
        const validationError = draftValidationError(d.state);
        if (validationError) {
          try {
            if (!storage.quarantineDraft) {
              throw new Error('Draft quarantine is unavailable.');
            }
            await storage.quarantineDraft(draftKey, validationError);
          } catch {
            if (!cancelled) {
              hydratedRef.current = true;
              pendingPersistRef.current = null;
              setHydrationStatus('error');
              setStorageError(
                'Saved draft is incompatible and could not be preserved safely.',
              );
            }
            return;
          }
          found = false;
          setStorageError(
            'An incompatible saved draft was quarantined. A new capture was started.',
          );
        }
      }
      if (d && found) {
        const s = d.state as Partial<DraftPayload>;
        if (Array.isArray(s.bursts)) {
          setBursts(s.bursts);
          burstsRef.current = s.bursts;
        }
        if (Array.isArray(s.feedingBursts)) {
          setFeedingBursts(s.feedingBursts);
          feedingBurstsRef.current = s.feedingBursts;
        }
        if (s.inactiveFirst !== undefined) {
          setInactiveFirstState(s.inactiveFirst);
        }
        if (typeof s.rate === 'number') {
          setRateState(s.rate);
        }
        if (s.deferred && typeof s.deferred === 'object') {
          const draftSchema = typeof s.schemaVersion === 'number' ? s.schemaVersion : 1;
          setDeferred({
            ...initialDeferred,
            ...s.deferred,
            intakeSources: Array.isArray(s.deferred.intakeSources)
              ? s.deferred.intakeSources
              : [],
            defenseIntervals: Array.isArray(s.deferred.defenseIntervals)
              ? s.deferred.defenseIntervals
              : [],
            defendedIntervals: Array.isArray(s.deferred.defendedIntervals)
              ? s.deferred.defendedIntervals
              : [],
            foulReasons: Array.isArray(s.deferred.foulReasons)
              ? s.deferred.foulReasons
              : [],
            defenseRating: normalizeStoredRating(s.deferred.defenseRating, draftSchema),
            driverSkill: normalizeStoredRating(s.deferred.driverSkill, draftSchema),
            agility: normalizeStoredRating(s.deferred.agility, draftSchema),
          });
        }
        const restoredSession = parseCaptureEnvelope(s.captureSession);
        if (restoredSession) {
          const nextFlow = {
            stage: restoredSession.stage,
            reviewStep: restoredSession.reviewStep,
            placementComplete: restoredSession.placementComplete,
            showGo: restoredSession.showGo,
          };
          flowStateRef.current = nextFlow;
          setFlowState(nextFlow);
          restoreClock(restoredSession.clock);
        }
        setDraftResumed(true);
      }
      hydratedRef.current = true;
      setHydrationStatus('ready');
      // Flush a persist that raced hydration — only when NO stored draft was
      // found. When one was found, the resumed state just applied above wins
      // and the raced payload (built from pre-resume state) must not clobber
      // the stored draft.
      const pending = pendingPersistRef.current;
      pendingPersistRef.current = null;
      if (pending && !found) {
        queueDraftWrite(pending);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftKey, queueDraftWrite, restoreClock, storage]);

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
      // Before hydration settles, park the payload instead of writing through:
      // the hydration effect flushes it (fresh capture) or discards it (a
      // stored draft / edit target won). Latest-wins if several taps race.
      if (!hydratedRef.current) {
        pendingPersistRef.current = next;
        return;
      }
      // Always pin the current feedingBursts from the ref so callers that only
      // know about fuel/deferred state don't wipe feeding data on persist.
      queueDraftWrite(next);
    },
    [queueDraftWrite],
  );

  const updateFlowState = useCallback(
    (patch: Partial<typeof flowState>) => {
      const next = { ...flowStateRef.current, ...patch };
      flowStateRef.current = next;
      setFlowState(next);
      persistDraft({
        inactiveFirst,
        rate,
        deferred,
      });
    },
    [deferred, inactiveFirst, persistDraft, rate],
  );

  // Clock transitions (START, GO, pause, re-anchor, explicit resume) must be
  // durable even if no scoring action follows before a reload.
  useEffect(() => {
    if (!hydratedRef.current || editIdRef.current) return;
    persistDraft({ inactiveFirst, rate, deferred });
  }, [
    clock.state.phase,
    clock.state.autoStartedAt,
    clock.state.teleopAnchoredAt,
    clock.state.teleopClockUnconfirmed,
    clock.resumeRequired,
    deferred,
    inactiveFirst,
    persistDraft,
    rate,
  ]);

  const setInactiveFirst = useCallback(
    (b: boolean) => {
      setInactiveFirstState(b);
      persistDraft({ inactiveFirst: b, rate, deferred });
    },
    [rate, deferred, persistDraft],
  );

  const setRate = useCallback(
    (r: number) => {
      setRateState(r);
      persistDraft({ inactiveFirst, rate: r, deferred });
    },
    [inactiveFirst, deferred, persistDraft],
  );

  const holdStart = useCallback(() => {
    const start = phaseElapsed();
    holdStartMsRef.current = start;
    setHoldStartMs(start);
    holdAccumRef.current = 0;
    holdRateRef.current = 0;
    holdSampleMsRef.current = start;
    holdWallRef.current = performance.now();
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
    const wallStart = holdWallRef.current;
    const balls =
      holdAccumRef.current + (finalSegRate * Math.max(0, end - sampleMs)) / 1000;
    holdStartMsRef.current = null;
    setHoldStartMs(null);
    holdAccumRef.current = 0;
    holdRateRef.current = 0;
    holdSampleMsRef.current = null;
    holdWallRef.current = null;

    let durationMs = Math.max(0, end - start);
    if (durationMs <= 0 && wallStart !== null) {
      // The phase clock jumped BACKWARDS mid-hold (0:30 endgame cue re-anchor
      // with a fast local clock): the live end reads before the start. Fall
      // back to the monotonic wall-clock duration so the integrated balls
      // survive instead of committing a zero-length (zero-ball) burst.
      durationMs = Math.max(0, performance.now() - wallStart);
    }
    // Store an EFFECTIVE constant rate so the existing burst model
    // (rate*(end-start)/1000) reproduces the integrated ball count exactly.
    const effRate = durationMs > 0 ? (balls * 1000) / durationMs : 0;
    const window = windowForBurst(clock.state.phase, clock.teleopElapsedMs);
    const burst: FuelBurst = { startMs: start, endMs: start + durationMs, rate: effRate, window };
    const nextBursts = [...burstsRef.current, burst];
    burstsRef.current = nextBursts;
    setBursts(nextBursts);
    persistDraft({ bursts: nextBursts, inactiveFirst, rate, deferred: deferredRef.current });
  }, [
    clock.state.phase,
    clock.teleopElapsedMs,
    clock.autoElapsedMs,
    rate,
    inactiveFirst,
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
    feedWallRef.current = performance.now();
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
      const wallStart = feedWallRef.current;
      const balls = feedAccumRef.current + (finalSegRate * Math.max(0, end - sampleMs)) / 1000;
      feedStartMsRef.current = null;
      setFeedStartMs(null);
      feedAccumRef.current = 0;
      feedRateRef.current = 0;
      feedSampleMsRef.current = null;
      feedWallRef.current = null;

      let durationMs = Math.max(0, end - start);
      if (durationMs <= 0 && wallStart !== null) {
        // Backwards re-anchor mid-hold — see holdEnd. Wall-clock fallback.
        durationMs = Math.max(0, performance.now() - wallStart);
      }
      const effRate = durationMs > 0 ? (balls * 1000) / durationMs : 0;
      const window = windowForBurst(clock.state.phase, clock.teleopElapsedMs);
      const burst: FuelBurst = { startMs: start, endMs: start + durationMs, rate: effRate, window };
      const next = [...feedingBurstsRef.current, burst];
      feedingBurstsRef.current = next;
      setFeedingBursts(next);
      persistDraft({ inactiveFirst, rate, deferred: deferredRef.current, feedingBursts: next });
    },
    [
      clock.state.phase,
      clock.teleopElapsedMs,
      clock.autoElapsedMs,
      inactiveFirst,
      rate,
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
      // Same phase with a forward-moving clock: end on the live phase clock
      // (keeps timeline coords exact). Crossed the boundary — OR the phase clock
      // jumped BACKWARDS mid-interval (0:30 cue re-anchor): anchor end off
      // start + the real wall-clock duration, so the interval isn't computed
      // as ≤ 0 and silently dropped.
      const liveEndMs = phaseElapsed();
      const useLiveClock = samePhase && liveEndMs > startMs;
      const endMs = useLiveClock ? liveEndMs : startMs + wallDurationMs;
      const durationMs = useLiveClock ? endMs - startMs : wallDurationMs;
      if (durationMs <= 0) return;
      const prev = deferredRef.current;
      const next: DeferredState = {
        ...prev,
        [durationKey]: prev[durationKey] + durationMs,
        [intervalsKey]: [...prev[intervalsKey], { startMs, endMs, phase: s.phase }],
      };
      deferredRef.current = next;
      setDeferred(next);
      persistDraft({ inactiveFirst, rate, deferred: next });
    },
    [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs, inactiveFirst, rate, persistDraft],
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
    const prev = burstsRef.current;
    if (prev.length === 0) return;
    const next = prev.slice(0, -1);
    burstsRef.current = next;
    setBursts(next);
    persistDraft({ bursts: next, inactiveFirst, rate, deferred: deferredRef.current });
  }, [inactiveFirst, rate, persistDraft]);

  // Pop the most-recent committed FEEDING burst (feeding was previously not
  // undoable at all — onShootEnd never recorded an undo event).
  const undoLastFeedingBurst = useCallback(() => {
    const prev = feedingBurstsRef.current;
    if (prev.length === 0) return;
    const next = prev.slice(0, -1);
    feedingBurstsRef.current = next;
    setFeedingBursts(next);
    persistDraft({ inactiveFirst, rate, deferred: deferredRef.current, feedingBursts: next });
  }, [inactiveFirst, rate, persistDraft]);

  // Atomically pop the last defense/being-defended interval AND subtract that
  // exact interval's duration from the running total, so the uploaded report's
  // intervals always equal its duration. (The old undo only adjusted the scalar
  // by CaptureScreen's separately-measured ms and left the interval in the report.)
  const undoLastDefenseInterval = useCallback(() => {
    const prev = deferredRef.current;
    const ivs = prev.defenseIntervals;
    if (ivs.length === 0) return;
    const last = ivs[ivs.length - 1];
    const dur = Math.max(0, last.endMs - last.startMs);
    const next: DeferredState = {
      ...prev,
      defenseIntervals: ivs.slice(0, -1),
      defenseDurationMs: Math.max(0, prev.defenseDurationMs - dur),
    };
    deferredRef.current = next;
    setDeferred(next);
    persistDraft({ inactiveFirst, rate, deferred: next });
  }, [inactiveFirst, rate, persistDraft]);

  const undoLastDefendedInterval = useCallback(() => {
    const prev = deferredRef.current;
    const ivs = prev.defendedIntervals;
    if (ivs.length === 0) return;
    const last = ivs[ivs.length - 1];
    const dur = Math.max(0, last.endMs - last.startMs);
    const next: DeferredState = {
      ...prev,
      defendedIntervals: ivs.slice(0, -1),
      defendedDurationMs: Math.max(0, prev.defendedDurationMs - dur),
    };
    deferredRef.current = next;
    setDeferred(next);
    persistDraft({ inactiveFirst, rate, deferred: next });
  }, [inactiveFirst, rate, persistDraft]);

  const updateDeferred = useCallback(
    <K extends keyof DeferredState>(key: K, value: DeferredState[K]) => {
      const next = { ...deferredRef.current, [key]: value };
      deferredRef.current = next;
      setDeferred(next);
      persistDraft({ inactiveFirst, rate, deferred: next });
    },
    [inactiveFirst, rate, persistDraft],
  );

  // Hand-corrected defense/defended TOTAL from the Review step. Updates the
  // scalar AND re-fits the recorded intervals in one atomic write, so the
  // uploaded report never ships duration ≠ Σ intervals (which made the match
  // timeline disagree with the ranked totals).
  const setDurationAdjusted = useCallback(
    (
      durationKey: 'defenseDurationMs' | 'defendedDurationMs',
      intervalsKey: 'defenseIntervals' | 'defendedIntervals',
      ms: number,
    ) => {
      const prev = deferredRef.current;
      const next: DeferredState = {
        ...prev,
        [durationKey]: ms,
        [intervalsKey]: adjustIntervalsTotal(prev[intervalsKey], ms),
      };
      deferredRef.current = next;
      setDeferred(next);
      persistDraft({ inactiveFirst, rate, deferred: next });
    },
    [inactiveFirst, rate, persistDraft],
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
      driverSkill: deferred.driverSkill,
      agility: deferred.agility,
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
    sessionFinalizedRef.current = true;
    await draftWriteChainRef.current;
    try {
      // Edit mode never wrote a live-capture draft (persistDraft short-circuits), so
      // there is no draft to delete; leaving any unrelated fresh draft for the same
      // key intact. Fresh captures still clear their own draft.
      if (!editing && storage.finalizeReport) {
        await storage.finalizeReport(report, draftKey);
      } else {
        await storage.saveReport(report);
      }
      if (!editing && !storage.finalizeReport) {
        await storage.deleteDraft(draftKey);
      }
    } catch (error) {
      sessionFinalizedRef.current = false;
      throw error;
    }
    return report.id;
  }, [
    inactiveFirst,
    bursts,
    feedingBursts,
    deferred,
    clock.state.teleopClockUnconfirmed,
    target,
    draftKey,
    storage,
  ]);

  return {
    clock,
    // Alliance color drives the half-field placement picker (red = left half,
    // blue = right half). Surfaced from the target so CaptureScreen doesn't need
    // the whole target threaded through.
    allianceColor: target.allianceColor,
    station: target.station,
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
    setDefenseRating: (v: QualitativeRating) => updateDeferred('defenseRating', v),
    driverSkill: deferred.driverSkill,
    setDriverSkill: (v: QualitativeRating) => updateDeferred('driverSkill', v),
    agility: deferred.agility,
    setAgility: (v: QualitativeRating) => updateDeferred('agility', v),
    defenseDurationMs: deferred.defenseDurationMs,
    setDefenseDurationMs: (v: number) =>
      setDurationAdjusted('defenseDurationMs', 'defenseIntervals', v),
    defendedDurationMs: deferred.defendedDurationMs,
    setDefendedDurationMs: (v: number) =>
      setDurationAdjusted('defendedDurationMs', 'defendedIntervals', v),
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
    hydrationStatus,
    storageError,
    flowStage: flowState.stage,
    setFlowStage: (stage: CaptureFlowStage) => updateFlowState({ stage }),
    reviewStep: flowState.reviewStep,
    setReviewStep: (reviewStep: number) =>
      updateFlowState({ reviewStep: Math.max(0, Math.min(4, reviewStep)) }),
    placementComplete: flowState.placementComplete,
    setPlacementComplete: (placementComplete: boolean) =>
      updateFlowState({ placementComplete }),
    showGo: flowState.showGo,
    setShowGo: (showGo: boolean) => updateFlowState({ showGo }),
  };
}
