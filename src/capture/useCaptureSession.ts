import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeAggregates,
  SCHEMA_VERSION,
  type FuelBurst,
  type MatchReportInputs,
} from '@/scoring';
import { useMatchClock, windowForBurst } from '@/capture/clock';
import { saveDraft, getDraft, deleteDraft, saveReport } from '@/db/localStore';
import type { LocalMatchReport } from '@/db/types';

export interface CaptureTarget {
  eventKey: string;
  matchKey: string;
  scoutId: string;
  targetTeamNumber: number;
  allianceColor: 'red' | 'blue';
  station: 1 | 2 | 3;
}

interface DeferredState {
  climbLevel: 0 | 1 | 2 | 3;
  climbAttempted: boolean;
  climbSuccess: boolean;
  intakeSources: string[];
  maxFuelCapacityObserved: number;
  defenseRating: 0 | 1 | 2 | 3;
  pins: number;
  foulsMinor: number;
  foulsMajor: number;
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
  pins: 0,
  foulsMinor: 0,
  foulsMajor: 0,
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
}

export function useCaptureSession(target: CaptureTarget) {
  const clock = useMatchClock();
  const draftKey = useMemo(
    () => `${target.matchKey}:${target.scoutId}:${target.targetTeamNumber}`,
    [target.matchKey, target.scoutId, target.targetTeamNumber],
  );

  const [bursts, setBursts] = useState<FuelBurst[]>([]);
  const [inactiveFirst, setInactiveFirstState] = useState<boolean | null>(null);
  const [rate, setRateState] = useState<number>(1);
  const [deferred, setDeferred] = useState<DeferredState>(initialDeferred);
  const [draftResumed, setDraftResumed] = useState(false);

  const holdStartMsRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);

  // Resume an existing draft on mount.
  useEffect(() => {
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
      void saveDraft(draftKey, { ...next, target });
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
    holdStartMsRef.current =
      clock.state.phase === 'teleop' ? clock.teleopElapsedMs : clock.autoElapsedMs;
  }, [clock.state.phase, clock.teleopElapsedMs, clock.autoElapsedMs]);

  const holdEnd = useCallback(() => {
    const start = holdStartMsRef.current;
    if (start === null) {
      return;
    }
    holdStartMsRef.current = null;
    const end =
      clock.state.phase === 'teleop' ? clock.teleopElapsedMs : clock.autoElapsedMs;
    const window = windowForBurst(clock.state.phase, clock.teleopElapsedMs);
    const burst: FuelBurst = { startMs: start, endMs: Math.max(end, start), rate, window };
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

  const save = useCallback(async (): Promise<string> => {
    const inputs: MatchReportInputs = {
      schemaVersion: SCHEMA_VERSION,
      inactiveFirst: inactiveFirst === null ? false : inactiveFirst,
      fuelBursts: bursts,
      climbLevel: deferred.climbLevel,
      autoClimbLevel1: deferred.autoClimbLevel1,
    };
    const agg = computeAggregates(inputs);
    const report: LocalMatchReport = {
      id: crypto.randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      appVersion: '2.0.0',
      deviceId: 'device-local',
      createdAt: new Date().toISOString(),
      eventKey: target.eventKey,
      matchKey: target.matchKey,
      scoutId: target.scoutId,
      targetTeamNumber: target.targetTeamNumber,
      allianceColor: target.allianceColor,
      station: target.station,
      inactiveFirst,
      inactiveFirstSource: inactiveFirst === null ? null : 'scout',
      teleopClockUnconfirmed: clock.state.teleopClockUnconfirmed,
      fuelBursts: bursts,
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
      pins: deferred.pins,
      foulsMinor: deferred.foulsMinor,
      foulsMajor: deferred.foulsMajor,
      noShow: deferred.noShow,
      died: deferred.died,
      tipped: deferred.tipped,
      droppedFuel: deferred.droppedFuel,
      fedCorral: deferred.fedCorral,
      notes: deferred.notes,
      // Rate-derived fuel estimate -> low confidence.
      fuelEstimateConfidence: 0.3,
      syncState: 'dirty',
    };
    await saveReport(report);
    await deleteDraft(draftKey);
    return report.id;
  }, [inactiveFirst, bursts, deferred, clock.state.teleopClockUnconfirmed, target, draftKey]);

  return {
    clock,
    bursts,
    holdStart,
    holdEnd,
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
    pins: deferred.pins,
    setPins: (v: number) => updateDeferred('pins', v),
    foulsMinor: deferred.foulsMinor,
    setFoulsMinor: (v: number) => updateDeferred('foulsMinor', v),
    foulsMajor: deferred.foulsMajor,
    setFoulsMajor: (v: number) => updateDeferred('foulsMajor', v),
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
