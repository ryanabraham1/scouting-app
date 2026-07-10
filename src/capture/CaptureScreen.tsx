import { useCallback, useEffect, useRef, useState } from 'react';
import { Shield, ShieldAlert, Undo2, Flag, Play, FastForward, Timer, Plane, MoveUpRight, Lock, ChevronRight, MapPin, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldDiagram, type FieldPoint } from '@/components/FieldDiagram';
import {
  useCaptureEvents,
  type BurstPayload,
  type CaptureEvent,
  type TogglePayload,
} from '@/capture/useCaptureEvents';
import { AUTO_MS, TELEOP_MS, remainingMs } from '@/capture/clock';
import type { useCaptureSession } from '@/capture/useCaptureSession';

/**
 * True when the viewport is in portrait orientation. Drives the pre-match
 * placement field: portrait → render the field ROTATED 90° (tall + big, so the
 * scout turns the phone sideways); landscape → render it normally (full-width,
 * upright). Re-renders on orientation change.
 */
function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia('(orientation: portrait)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(orientation: portrait)');
    const onChange = (): void => setPortrait(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return portrait;
}

function buzz(ms = 15): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported — non-fatal */
  }
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function undoActionLabel(event: CaptureEvent | undefined): string | null {
  if (!event) return null;
  switch (event.type) {
    case 'defense':
      return 'defense timer';
    case 'defended':
      return 'defended timer';
    case 'burst':
      return (event.payload as BurstPayload).kind === 'feeding'
        ? 'feed burst'
        : 'fuel burst';
    case 'foul':
      return 'foul';
    case 'toggle': {
      const key = (event.payload as TogglePayload).key;
      if (key === 'autoLeftStartingLine') return 'left line';
      if (key === 'autoClimbLevel1') return 'auto climb';
      return 'change';
    }
    default:
      return null;
  }
}

// Combined press-drag slider-shoot lives inline so it can wire straight into the
// session's holdStart/holdEnd (rate-override) without prop drilling timing.
import { SliderShoot } from '@/capture/SliderShoot';

export type CaptureObservedAction =
  | 'placement_set'
  | 'placement_submitted'
  | 'match_started'
  | 'go_pressed'
  | 'inactive_answered'
  | 'fuel_burst'
  | 'left_line'
  | 'auto_climb'
  | 'feeding_burst'
  | 'defense_started'
  | 'defense_locked'
  | 'defense_stopped'
  | 'defended_started'
  | 'defended_locked'
  | 'defended_stopped'
  | 'foul_added'
  | 'undo'
  | 'reanchored'
  | 'to_review';

// Distance the pointer must travel RIGHT (from its press X) to latch a lock.
export const LOCK_SLIDE_PX = 64;

/**
 * Pure lock decision: did the pointer slide RIGHT from its press X by at least
 * `threshold` px? Exported + pure so the gesture math is unit-testable without a
 * real pointer (jsdom synthetic PointerEvents don't carry clientX).
 */
export function shouldLock(
  startX: number,
  clientX: number,
  threshold: number = LOCK_SLIDE_PX,
): boolean {
  if (!Number.isFinite(startX) || !Number.isFinite(clientX)) return false;
  return clientX - startX >= threshold;
}

/**
 * Whole-button HOLD-SLIDE-LOCK control. The entire button is the control:
 *  - press & hold        → activate + start timing
 *  - slide right ≥ thresh → latch locked (stays active after release)
 *  - release (not locked) → commit interval (deactivate)
 *  - tap while locked     → commit interval (deactivate)
 *
 * `active` / `locked` are owned by the parent (so the underlying session interval
 * recording is unchanged); this component only translates the pointer gesture
 * into begin/commit/lock calls.
 */
// The two timers get distinct color identities so they never look alike, while
// keeping the original hold→slide→lock vibe: hold on one hue, and a subtle
// translucent wash of the LOCK hue grows from the left as you slide, previewing
// where the lock lands. Playing defense = green → amber (calm, mirrors the old
// green→warm feel); getting defended = indigo → red (its own hue, red = "under
// threat"). No bright edge / glow — the fill stays understated.
type DefenseTone = 'defense' | 'defended';
const DEFENSE_TONE: Record<DefenseTone, { active: string; locked: string; slide: string }> = {
  defense: {
    active: 'bg-emerald-600 text-white hover:bg-emerald-600',
    locked: 'bg-amber-500 text-neutral-900 hover:bg-amber-500',
    slide: 'bg-amber-400/40',
  },
  defended: {
    active: 'bg-indigo-600 text-white hover:bg-indigo-600',
    locked: 'bg-rose-500 text-white hover:bg-rose-500',
    slide: 'bg-rose-400/40',
  },
};

function HoldSlideLockButton(props: {
  testid: string;
  label: string;
  icon: JSX.Element;
  tone: DefenseTone;
  active: boolean;
  locked: boolean;
  timerText: string;
  /** begin the interval (no-op if already running) */
  onBegin: () => void;
  /** commit + deactivate the interval */
  onCommit: () => void;
  /** latch locked-on */
  onLock: () => void;
}): JSX.Element {
  const { testid, label, icon, tone, active, locked, timerText, onBegin, onCommit, onLock } = props;
  const toneCls = DEFENSE_TONE[tone];
  // startX must survive re-renders (onBegin flips parent state → this re-renders;
  // a useState start would reset to its initial value and the dx math would zero
  // out). A ref is the correct home for the gesture's anchor X.
  const startXRef = useRef<number | null>(null);
  // Did THIS gesture cross the lock threshold? Checked BEFORE the `locked` branch
  // in onPointerEnd so a gesture that just latched lock stays active on release
  // (the previous code hit `if (locked) onCommit()` first and tore it down).
  const slidLockedRef = useRef(false);
  // Was the control already locked when this gesture STARTED? Captured on
  // pointerdown so the release decision doesn't depend on the (possibly stale or
  // mid-gesture-mutated) `locked` prop closure.
  const wasLockedAtDownRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const [slideProgress, setSlideProgress] = useState(0); // 0..1 toward lock

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      // setPointerCapture keeps pointermove flowing even after the finger slides
      // off the button edge; without it the move events stop and lock never
      // latches. It throws for inactive/synthetic pointer ids, so guard it.
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore — proceed without pointer capture */
      }
      pointerIdRef.current = e.pointerId;
      startXRef.current = Number.isFinite(e.clientX) ? e.clientX : 0;
      slidLockedRef.current = false;
      wasLockedAtDownRef.current = locked;
      if (locked) {
        // Tap while locked → commit on release; nothing to begin on down.
        return;
      }
      onBegin();
    },
    [locked, onBegin],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      // Ignore moves when no gesture is down or the control was already locked at
      // press (those gestures are "tap to unlock", not slide).
      if (startXRef.current === null || wasLockedAtDownRef.current) return;
      const dx =
        (Number.isFinite(e.clientX) ? e.clientX : startXRef.current) - startXRef.current;
      setSlideProgress(Math.max(0, Math.min(1, dx / LOCK_SLIDE_PX)));
      if (!slidLockedRef.current && shouldLock(startXRef.current, e.clientX)) {
        slidLockedRef.current = true;
        onLock();
      }
    },
    [onLock],
  );

  const onPointerEnd = useCallback(() => {
    const wasDown = startXRef.current !== null;
    startXRef.current = null;
    pointerIdRef.current = null;
    setSlideProgress(0);
    if (!wasDown) return;
    // ORDER MATTERS: a gesture that latched lock THIS time must keep running —
    // check it before the already-locked (tap-to-unlock) branch.
    if (slidLockedRef.current) {
      slidLockedRef.current = false;
      return; // just latched locked this gesture; stay active with no held finger
    }
    if (wasLockedAtDownRef.current) {
      // Tap while already locked → commit + deactivate.
      onCommit();
      return;
    }
    onCommit(); // plain hold-release → commit interval
  }, [onCommit]);

  return (
    <Button
      data-testid={testid}
      data-active={active ? 'true' : 'false'}
      data-locked={locked ? 'true' : 'false'}
      aria-pressed={active}
      variant={active ? 'default' : 'secondary'}
      size="xl"
      className={`relative h-full w-full touch-none select-none flex-col gap-0.5 overflow-hidden rounded-2xl px-2 text-base ${
        locked ? toneCls.locked : active ? toneCls.active : ''
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={(event) => {
        if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat) return;
        event.preventDefault();
        wasLockedAtDownRef.current = locked;
        startXRef.current = 0;
        if (!locked) onBegin();
      }}
      onKeyUp={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        onPointerEnd();
      }}
    >
      {/* slide-to-lock progress track (only while holding, unlocked) */}
      {active && !locked && (
        <div
          data-testid={`${testid}-slide`}
          className={`pointer-events-none absolute inset-y-0 left-0 ${toneCls.slide}`}
          style={{ width: `${slideProgress * 100}%` }}
        />
      )}
      <span className="relative z-10 flex flex-wrap items-center justify-center gap-1.5 text-center text-sm font-semibold leading-tight sm:text-base">
        {locked ? <Lock className="size-5 shrink-0" /> : icon} {label}
      </span>
      <span data-testid={`${testid}-timer`} className="relative z-10 text-base tabular-nums">
        {timerText}
      </span>
      <span className="relative z-10 flex items-center gap-1 text-sm font-medium">
        {locked ? (
          <>
            <Lock className="size-4" /> LOCKED · tap to stop
          </>
        ) : active ? (
          <>
            slide to lock <ChevronRight className="size-4" />
          </>
        ) : (
          'hold'
        )}
      </span>
    </Button>
  );
}

export function CaptureScreen(props: {
  session: ReturnType<typeof useCaptureSession>;
  onToReview: () => void;
  /** Read-only action observation for wrappers such as training/coaching UI. */
  onAction?: (action: CaptureObservedAction) => void;
  /**
   * Abandon this capture and return to Scout Home. Installed PWAs have no browser
   * back button, so without this an unfinished capture is a dead end. The draft
   * auto-saves continuously, so exiting is non-destructive and resumable.
   */
  onExit?: () => void;
}) {
  const s = props.session;
  const showGo = s.showGo;
  // Pre-match placement step gates the live match screen and persists across reload.
  const placed = s.placementComplete;
  const isPortrait = useIsPortrait();
  // Which half of the field to show on the placement step. The field image is
  // red-structure-left / blue-structure-right, so a red team starts on the LEFT
  // half and a blue team on the RIGHT half.
  const half: 'left' | 'right' = s.allianceColor === 'blue' ? 'right' : 'left';

  const phase = s.clock.state.phase;

  // Running ball count = committed bursts + the live integral of the active hold
  // (∫ rate·dt). The session owns the integration so sliding the BPS up late in a
  // hold no longer retroactively re-prices the whole hold.
  const fuelCount = s.liveFuelCount;

  // Defense / being-defended timers. Each can be a press-and-hold OR a slide-to
  // -lock toggle. `start` is the performance.now() the active interval began;
  // `locked` keeps it running with no held finger. Live elapsed re-renders via a
  // light interval tick below.
  const defenseStartRef = useRef<number | null>(null);
  const defendedStartRef = useRef<number | null>(null);
  const [defenseLocked, setDefenseLocked] = useState(false);
  const [defendedLocked, setDefendedLocked] = useState(false);
  const [defenseActive, setDefenseActive] = useState(false);
  const [defendedActive, setDefendedActive] = useState(false);
  const [, setTick] = useState(0);

  // Tick ~5x/sec while any timer is running so the displayed seconds count UP
  // live (not only on release/unlock).
  useEffect(() => {
    if (!defenseActive && !defendedActive) return;
    const id = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, [defenseActive, defendedActive]);

  const events = useCaptureEvents({
    // The session owns interval+duration bookkeeping atomically, so undo pops the
    // committed interval AND subtracts its exact duration (the old handler only
    // adjusted the scalar and left the interval in the uploaded report).
    onUndoDefense: () => s.undoLastDefenseInterval(),
    onUndoDefended: () => s.undoLastDefendedInterval(),
    // Pop the burst from the slider that committed it (fuel vs feeding). Without
    // this the burst stayed counted forever while the timeline event was consumed.
    onUndoBurst: (p) =>
      p.kind === 'feeding' ? s.undoLastFeedingBurst() : s.undoLastBurst(),
    onUndoFoul: () => s.setFoulsMinor(Math.max(0, s.foulsMinor - 1)),
    onUndoToggle: (p) => {
      if (p.key === 'autoLeftStartingLine') s.setAutoLeftStartingLine(p.prev);
      if (p.key === 'autoClimbLevel1') s.setAutoClimbLevel1(p.prev);
    },
  });

  // The session now OWNS the duration + timestamped-interval bookkeeping
  // (s.beginDefense/s.endDefense). We keep a LOCAL start only to drive the live
  // seconds readout while the interval is open — we do NOT also accumulate into
  // defenseDurationMs here (that would double-count what endDefense() records).

  // ---- Defense (playing defense) ----
  const beginDefense = () => {
    if (defenseStartRef.current !== null) return; // already running (e.g. locked)
    defenseStartRef.current = performance.now();
    setDefenseActive(true);
    s.beginDefense(); // session records the open interval start
    props.onAction?.('defense_started');
    buzz();
  };
  // Commit the in-progress interval and clear active + locked state.
  const commitDefense = () => {
    const start = defenseStartRef.current;
    setDefenseLocked(false);
    if (start === null) {
      setDefenseActive(false);
      return;
    }
    defenseStartRef.current = null;
    setDefenseActive(false);
    const end = performance.now();
    const durationMs = Math.max(0, end - start);
    s.endDefense(); // session commits duration + interval (no manual accumulate)
    events.recordDefense({ startMs: start, endMs: end, durationMs });
    props.onAction?.('defense_stopped');
    buzz(20);
  };
  // Latch locked-on (interval already begun on press).
  const lockDefense = () => {
    setDefenseLocked(true);
    props.onAction?.('defense_locked');
    buzz(20);
  };

  // ---- Defended (getting defended) ----
  const beginDefended = () => {
    if (defendedStartRef.current !== null) return;
    defendedStartRef.current = performance.now();
    setDefendedActive(true);
    s.beginDefended();
    props.onAction?.('defended_started');
    buzz();
  };
  const commitDefended = () => {
    const start = defendedStartRef.current;
    setDefendedLocked(false);
    if (start === null) {
      setDefendedActive(false);
      return;
    }
    defendedStartRef.current = null;
    setDefendedActive(false);
    const end = performance.now();
    const durationMs = Math.max(0, end - start);
    s.endDefended();
    events.recordDefended({ startMs: start, endMs: end, durationMs });
    props.onAction?.('defended_stopped');
    buzz(20);
  };
  const lockDefended = () => {
    setDefendedLocked(true);
    props.onAction?.('defended_locked');
    buzz(20);
  };

  // Live displayed durations: committed total (owned by the session) + the
  // in-progress interval measured from the LOCAL start ref.
  const liveDefenseMs =
    s.defenseDurationMs +
    (defenseStartRef.current !== null
      ? Math.max(0, performance.now() - defenseStartRef.current)
      : 0);
  const liveDefendedMs =
    s.defendedDurationMs +
    (defendedStartRef.current !== null
      ? Math.max(0, performance.now() - defendedStartRef.current)
      : 0);

  // ---- Pre-match placement step ----
  if (!placed) {
    return (
      <div className="flex h-[100dvh] flex-col gap-2 overflow-hidden bg-background px-safe-tight pt-safe-tight pb-safe-tight text-foreground">
        <header className="flex shrink-0 items-center gap-2">
          <span
            data-testid="capture-placement-title"
            className="flex shrink-0 items-center gap-2 text-base font-semibold"
          >
            <MapPin className="size-5 text-brand" />
            <span className="hidden sm:inline">Place the robot</span>
          </span>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <span
              data-testid="capture-target"
              role="group"
              aria-label={`Scouting Team ${s.targetTeamNumber}, ${
                s.allianceColor === 'red' ? 'Red' : 'Blue'
              } alliance station ${s.station}. Tap the field where it starts.`}
              className="flex min-w-0 flex-1 items-center justify-end gap-1.5"
            >
              <span className="flex min-w-0 flex-col items-end text-right">
                <strong className="max-w-full truncate text-base font-extrabold leading-tight text-foreground">
                  Team{' '}
                  <span className="font-mono text-xl font-black tracking-tight">
                    {s.targetTeamNumber}
                  </span>
                </strong>
                <span className="max-w-full truncate text-[11px] leading-tight text-muted-foreground">
                  Tap the field where it starts
                </span>
              </span>
              <span
                data-testid="capture-alliance-station"
                className={`shrink-0 rounded-lg border px-2 py-1 text-xs font-black tracking-wide text-white ${
                  s.allianceColor === 'red'
                    ? 'border-red-700 bg-red-600'
                    : 'border-blue-800 bg-blue-600'
                }`}
              >
                {s.allianceColor === 'red' ? 'RED' : 'BLUE'} {s.station}
              </span>
            </span>
            {props.onExit && (
              <Button
                data-testid="capture-exit"
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                aria-label="Exit capture"
                onClick={props.onExit}
              >
                <X className="size-5" />
              </Button>
            )}
          </div>
        </header>
        {/* We only show the HALF of the field the scouted team plays on (red =
            left, blue = right) so the scout isn't hunting across the whole field
            for a start spot. The inner FieldDiagram still renders the FULL field
            and reports FULL-field {x,y} (so the stored coords stay in the same
            space the review/dash diagrams expect) — we size it 2× the clip and
            translate it so only the team's half is visible, with the clip's
            overflow hidden. Because the clip transform is a pure translate,
            FieldDiagram's getBoundingClientRect-based coordinate math is
            unaffected and a tap lands at its true full-field position.

            Unlike the full field (very wide → rotated 90° on portrait phones), a
            single half is ~square (1951:1584), so it stays UPRIGHT in both
            orientations — matching how the scout sees the real field — and we
            just fit it by height in landscape / by width in portrait so it never
            overflows or gets cut off. */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          <div
            data-testid="capture-half-clip"
            data-half={half}
            style={{
              // Fit the half (≈square) in whichever dimension is the constraint:
              // portrait → full width (height derived); landscape → full height.
              ...(isPortrait ? { width: '100%' } : { height: '100%' }),
              aspectRatio: '1951 / 1584',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <div
              style={{
                // The FULL field, sized 2× the clip (it's twice as wide as one
                // half) and shifted left by one clip-width to reveal the right
                // (blue) half; left:0 keeps the left (red) half in view.
                position: 'absolute',
                top: 0,
                left: half === 'right' ? '-100%' : 0,
                height: '100%',
                aspectRatio: '3902 / 1584',
              }}
            >
              <FieldDiagram
                mode="pick-start"
                fillHeight
                startPosition={s.autoStartPosition}
                onStartChange={(p: FieldPoint) => {
                  s.setAutoStartPosition(p);
                  props.onAction?.('placement_set');
                  buzz();
                }}
                data-testid="capture-field"
              />
            </div>
          </div>
        </div>
        {/* Require a placement tap before starting: without a start position the
            saved report drops out of the dashboard auto-heatmap and the known-auto
            reuse picker (autoStartPosition would silently persist as null). The
            button stays disabled until the scout taps the field. */}
        <Button
          data-testid="capture-placement-submit"
          variant="brand"
          size="big"
          className="h-14 shrink-0 text-xl"
          disabled={!s.autoStartPosition}
          onClick={() => {
            if (!s.autoStartPosition) return;
            s.setPlacementComplete(true);
            props.onAction?.('placement_submitted');
            buzz(25);
          }}
        >
          <Play /> {s.autoStartPosition ? 'Confirm position' : 'Tap the field to place'}
        </Button>
      </div>
    );
  }

  if (showGo) {
    return (
      <div
        data-testid="capture-go-interstitial"
        className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6 text-foreground"
      >
        <p className="text-xl font-semibold">Was your HUB inactive first?</p>
        <div className="flex w-full max-w-lg gap-4">
          <Button
            data-testid="capture-inactive-yes"
            size="big"
            className="flex-1"
            onClick={() => {
              s.setInactiveFirst(true);
              s.clock.markGo();
              props.onAction?.('inactive_answered');
              buzz(25);
              s.setShowGo(false);
            }}
          >
            Yes
          </Button>
          <Button
            data-testid="capture-inactive-no"
            variant="secondary"
            size="big"
            className="flex-1"
            onClick={() => {
              s.setInactiveFirst(false);
              s.clock.markGo();
              props.onAction?.('inactive_answered');
              buzz(25);
              s.setShowGo(false);
            }}
          >
            No
          </Button>
        </div>
      </div>
    );
  }

  if (s.clock.resumeRequired) {
    const savedElapsed =
      phase === 'teleop' ? s.clock.teleopElapsedMs : s.clock.autoElapsedMs;
    const phaseLabel =
      phase === 'teleop'
        ? 'Teleop'
        : phase === 'pause'
          ? 'the Auto-to-Teleop pause'
          : 'Auto';
    return (
      <div
        data-testid="capture-resume-clock"
        className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-background p-6 text-center text-foreground"
      >
        <Timer className="size-10 text-warning" />
        <div className="max-w-md space-y-2">
          <h2 className="text-xl font-bold">Re-anchor the match clock</h2>
          <p className="text-muted-foreground">
            This draft stopped in {phaseLabel} at {mmss(savedElapsed)} elapsed.
            Time while the app was closed was not counted.
          </p>
        </div>
        <div className="flex w-full max-w-md flex-col gap-3 sm:flex-row">
          <Button
            data-testid="capture-resume-clock-confirm"
            size="big"
            className="flex-1"
            onClick={() => s.clock.resumeFromSaved()}
          >
            Resume from {mmss(savedElapsed)}
          </Button>
          <Button
            data-testid="capture-resume-to-review"
            variant="outline"
            size="big"
            className="flex-1"
            onClick={props.onToReview}
          >
            Go to review
          </Button>
        </div>
      </div>
    );
  }

  // Count-DOWN: remaining time in the active phase (auto vs teleop).
  const remaining =
    phase === 'teleop'
      ? remainingMs(TELEOP_MS, s.clock.teleopElapsedMs)
      : phase === 'auto'
        ? remainingMs(AUTO_MS, s.clock.autoElapsedMs)
        : phase === 'pause'
          ? 0
          : AUTO_MS;
  const inAuto = phase === 'auto' || phase === 'pause' || phase === 'idle';
  // `pause` is the match clock's authoritative "Auto elapsed, still awaiting
  // GO" state. Deriving readiness from phase keeps production, resumed drafts,
  // and tutorial-injected clocks on one timing source.
  const autoEndedAwaitingGo = phase === 'pause';
  const latestUndoableEvent = events.events.reduce<CaptureEvent | undefined>(
    (latest, event) => (event.type === 'phase' ? latest : event),
    undefined,
  );
  const latestUndoLabel = undoActionLabel(latestUndoableEvent);

  return (
    <div className="flex h-[100dvh] flex-col gap-2 overflow-hidden bg-background px-safe-tight pt-safe-tight pb-safe-tight text-foreground">
      {/* Top bar stays glanceable: match state · countdown · optional exit. */}
      <header className="flex shrink-0 items-center justify-between gap-1.5">
        <span
          data-testid="capture-window"
          className="min-w-0 truncate text-xs uppercase tracking-wide text-muted-foreground"
        >
          {phase} · {s.clock.window}
        </span>
        <span
          data-testid="capture-clock"
          className="flex shrink-0 items-center gap-1 font-mono text-xl font-bold tabular-nums"
        >
          <Timer className="size-5 max-[380px]:hidden" /> {mmss(remaining)}
        </span>
        {props.onExit && (
          <Button
            data-testid="capture-exit"
            variant="outline"
            size="icon"
            className="size-11 shrink-0"
            aria-label="Exit capture"
            onClick={() => {
              // The draft is resumable — commit open timers/holds into it
              // before leaving so they aren't silently dropped.
              commitDefense();
              commitDefended();
              s.holdEnd();
              s.feedHoldEnd();
              props.onExit?.();
            }}
          >
            <X className="size-5" />
          </Button>
        )}
      </header>

      {/* Body fills the remaining height; the defense + slider regions flex to
          absorb slack so EVERYTHING (incl. To Review) stays on-screen — no scroll
          in portrait. When the viewport is shorter than the regions' minimum
          heights (landscape phone), overflow-y-auto kicks in so Foul/To Review
          stay reachable instead of being clipped by the overflow-hidden root. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {/* Running ball counts. Compact so two cards never overflow the right
            edge on a narrow portrait phone (min-w-0 + truncate). */}
        <div className="flex shrink-0 items-stretch gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-energy/30 bg-energy/10 px-3 py-1.5">
            <span
              data-testid="capture-running-fuel"
              className="shrink-0 font-mono text-4xl font-bold leading-none tabular-nums text-energy"
            >
              {fuelCount}
            </span>
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                fuel scored
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                <span className="font-semibold text-success">{s.committedFuelCount}</span> banked
              </span>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-brand/30 bg-brand/10 px-3 py-1.5">
            <span
              data-testid="capture-running-feed"
              className="shrink-0 font-mono text-4xl font-bold leading-none tabular-nums text-brand"
            >
              {s.liveFeedingCount}
            </span>
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                fed
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                <span className="font-semibold text-success">{s.committedFeedingCount}</span> banked
              </span>
            </div>
          </div>
        </div>

        {/* Phase-scoped primary action */}
        {phase === 'idle' && (
          <Button data-testid="capture-start" size="xl" className="h-12 shrink-0 rounded-2xl text-xl" onClick={() => { s.clock.startAuto(); props.onAction?.('match_started'); buzz(25); }}>
            <Play /> START
          </Button>
        )}
        {(phase === 'auto' || phase === 'pause') && (
          <Button
            data-testid="capture-go"
            data-auto-ended={autoEndedAwaitingGo ? 'true' : 'false'}
            size="xl"
            className={`h-12 shrink-0 rounded-2xl text-xl ${
              autoEndedAwaitingGo
                ? 'bg-success text-success-foreground hover:bg-success'
                : 'bg-energy text-energy-foreground hover:bg-energy'
            }`}
            aria-label={
              autoEndedAwaitingGo
                ? 'GO to Teleop — Auto ended'
                : 'GO to Teleop'
            }
            onClick={() => {
              // Commit any in-flight slider hold NOW: the interstitial swap
              // unmounts the sliders, so onShootEnd would never fire — the
              // integrated balls would be dropped and the live readout would
              // keep ghost-integrating against the stale hold refs.
              s.holdEnd();
              s.feedHoldEnd();
              props.onAction?.('go_pressed');
              s.setShowGo(true);
            }}
          >
            <FastForward />
            {autoEndedAwaitingGo ? 'GO · TELEOP READY' : 'GO (Teleop)'}
          </Button>
        )}
        {phase === 'teleop' && (
          <Button data-testid="capture-reanchor" variant="outline" size="big" className="h-11 shrink-0 rounded-2xl text-base" onClick={() => { s.reAnchorCue(); props.onAction?.('reanchored'); buzz(); }}>
            0:30 Endgame cue
          </Button>
        )}

        {/* Defense / Getting-defended: whole-button HOLD-SLIDE-LOCK pair */}
        <div className="flex min-h-[88px] flex-1 items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <HoldSlideLockButton
              testid="capture-defense"
              label="Playing defense"
              icon={<Shield className="size-5" />}
              tone="defense"
              active={defenseActive}
              locked={defenseLocked}
              timerText={secs(liveDefenseMs)}
              onBegin={beginDefense}
              onCommit={commitDefense}
              onLock={lockDefense}
            />
          </div>
          <div className="min-w-0 flex-1">
            <HoldSlideLockButton
              testid="capture-defended"
              label="Getting defended"
              icon={<ShieldAlert className="size-5" />}
              tone="defended"
              active={defendedActive}
              locked={defendedLocked}
              timerText={secs(liveDefendedMs)}
              onBegin={beginDefended}
              onCommit={commitDefended}
              onLock={lockDefended}
            />
          </div>
        </div>

        {/* Parallel horizontal slider-shoots: SCORING (orange) + FEEDING (cyan).
            Stacked in portrait, side-by-side in landscape. Flex to fill slack. */}
        <div className="flex min-h-[148px] flex-[1.6] flex-col gap-2 landscape:flex-row">
          <div className="flex min-h-0 flex-1">
            <SliderShoot
              data-testid="capture-hold"
              tone="energy"
              unitLabel="BPS"
              activeLabel="SHOOTING"
              idleLabel="FUEL · hold + slide →"
              aria-label="Scoring rate (BPS)"
              className="h-full"
              onShootStart={() => { s.holdStart(); buzz(); }}
              onShootRate={(r) => s.holdSample(r)}
              onShootEnd={(rate) => { s.holdEnd(rate); events.recordBurst({ rate, kind: 'fuel' }); props.onAction?.('fuel_burst'); buzz(20); }}
            />
          </div>
          <div className="flex min-h-0 flex-1">
            <SliderShoot
              data-testid="capture-feed"
              tone="brand"
              unitLabel="BPS"
              activeLabel="FEEDING"
              idleLabel="FEED · hold + slide →"
              aria-label="Feeding rate (BPS)"
              className="h-full"
              onShootStart={() => { s.feedHoldStart(); buzz(); }}
              onShootRate={(r) => s.feedHoldSample(r)}
              onShootEnd={(rate) => { s.feedHoldEnd(rate); events.recordBurst({ rate, kind: 'feeding' }); props.onAction?.('feeding_burst'); buzz(20); }}
            />
          </div>
        </div>

        {/* Secondary actions */}
        <div className={`grid shrink-0 gap-2 ${inAuto ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <Button
            data-testid="capture-foul"
            variant="outline"
            size="big"
            className={`h-11 gap-1.5 rounded-2xl px-1.5 text-base [&_svg]:size-5 ${s.foulsMinor > 0 ? 'border-warning text-warning' : ''}`}
            onClick={() => { s.setFoulsMinor(s.foulsMinor + 1); events.recordFoul({ kind: 'minor' }); props.onAction?.('foul_added'); buzz(); }}
          >
            <Flag /> Foul ({s.foulsMinor})
          </Button>
          {inAuto && (
            <Button
              data-testid="capture-left-line"
              variant={s.autoLeftStartingLine ? 'default' : 'outline'}
              aria-pressed={s.autoLeftStartingLine}
              size="big"
              className="h-11 gap-1.5 rounded-2xl px-1.5 text-base [&_svg]:size-5"
              onClick={() => { const prev = s.autoLeftStartingLine; s.setAutoLeftStartingLine(!prev); events.recordToggle({ key: 'autoLeftStartingLine', value: !prev, prev }); props.onAction?.('left_line'); buzz(); }}
            >
              <MoveUpRight /> Left Line
            </Button>
          )}
          {inAuto && (
            <Button
              data-testid="capture-auto-climb"
              variant={s.autoClimbLevel1 ? 'default' : 'outline'}
              aria-pressed={s.autoClimbLevel1}
              size="big"
              className="h-11 gap-1.5 rounded-2xl px-1.5 text-base [&_svg]:size-5"
              onClick={() => { const prev = s.autoClimbLevel1; s.setAutoClimbLevel1(!prev); events.recordToggle({ key: 'autoClimbLevel1', value: !prev, prev }); props.onAction?.('auto_climb'); buzz(); }}
            >
              <Plane /> Auto Climb
            </Button>
          )}
        </div>

        {/* Persistent bottom action row: correction sits beside the forward
            action it balances. Undo only occupies space when there is something
            real to reverse, and names that action before the scout commits. */}
        <div className="flex shrink-0 gap-2">
          {events.canUndo && latestUndoLabel && (
            <Button
              data-testid="capture-undo"
              variant="outline"
              size="big"
              className="h-11 min-w-0 flex-[1.15] justify-start gap-1.5 rounded-2xl border-warning/50 bg-warning/5 px-3 text-base hover:bg-warning/10 [&_svg]:size-5"
              aria-label={`Undo last action: ${latestUndoLabel}`}
              title={`Undo ${latestUndoLabel}`}
              onClick={() => {
                events.undoLast();
                props.onAction?.('undo');
                buzz();
              }}
            >
              <Undo2 />
              <span className="min-w-0 truncate">Undo {latestUndoLabel}</span>
            </Button>
          )}
          <Button
            data-testid="capture-to-review"
            variant="secondary"
            size="big"
            className="h-11 min-w-0 flex-1 rounded-2xl px-3 text-base"
            onClick={() => {
              // CaptureScreen unmounts on the stage switch. Commit anything still
              // open — a slide-LOCKED defense/defended timer (the lock exists
              // precisely so no finger is on it at match end) and any in-flight
              // slider hold — or that data silently vanishes from the report.
              commitDefense();
              commitDefended();
              s.holdEnd();
              s.feedHoldEnd();
              props.onAction?.('to_review');
              props.onToReview();
            }}
          >
            To Review
          </Button>
        </div>
      </div>
    </div>
  );
}
