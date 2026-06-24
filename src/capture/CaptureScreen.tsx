import { useRef, useState } from 'react';
import { Shield, ShieldAlert, Undo2, Flag, Play, FastForward, Timer, Plane, MoveUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldDiagram, type FieldPoint } from '@/components/FieldDiagram';
import { useCaptureEvents, type DefenseIntervalPayload } from '@/capture/useCaptureEvents';
import type { useCaptureSession } from '@/capture/useCaptureSession';

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

// Combined press-drag slider-shoot lives inline so it can wire straight into the
// session's holdStart/holdEnd (rate-override) without prop drilling timing.
import { SliderShoot } from '@/capture/SliderShoot';

export function CaptureScreen(props: {
  session: ReturnType<typeof useCaptureSession>;
  onToReview: () => void;
}) {
  const s = props.session;
  const [showGo, setShowGo] = useState(false);

  const fuelCount = s.bursts.length;
  const phase = s.clock.state.phase;

  // Defense / being-defended press-and-hold timers (exact ms; no buckets).
  const defenseStartRef = useRef<number | null>(null);
  const defendedStartRef = useRef<number | null>(null);

  const events = useCaptureEvents({
    onUndoDefense: (p: DefenseIntervalPayload) =>
      s.setDefenseDurationMs(Math.max(0, s.defenseDurationMs - p.durationMs)),
    onUndoDefended: (p: DefenseIntervalPayload) =>
      s.setDefendedDurationMs(Math.max(0, s.defendedDurationMs - p.durationMs)),
    onUndoFoul: () => s.setFoulsMinor(Math.max(0, s.foulsMinor - 1)),
    onUndoToggle: (p) => {
      if (p.key === 'autoLeftStartingLine') s.setAutoLeftStartingLine(p.prev);
      if (p.key === 'autoClimbLevel1') s.setAutoClimbLevel1(p.prev);
    },
  });

  const beginDefense = () => {
    defenseStartRef.current = performance.now();
    buzz();
  };
  const endDefense = () => {
    const start = defenseStartRef.current;
    if (start === null) return;
    defenseStartRef.current = null;
    const end = performance.now();
    const durationMs = Math.max(0, end - start);
    s.setDefenseDurationMs(s.defenseDurationMs + durationMs);
    events.recordDefense({ startMs: start, endMs: end, durationMs });
  };

  const beginDefended = () => {
    defendedStartRef.current = performance.now();
    buzz();
  };
  const endDefended = () => {
    const start = defendedStartRef.current;
    if (start === null) return;
    defendedStartRef.current = null;
    const end = performance.now();
    const durationMs = Math.max(0, end - start);
    s.setDefendedDurationMs(s.defendedDurationMs + durationMs);
    events.recordDefended({ startMs: start, endMs: end, durationMs });
  };

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
              buzz(25);
              setShowGo(false);
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
              buzz(25);
              setShowGo(false);
            }}
          >
            No
          </Button>
        </div>
      </div>
    );
  }

  const elapsedMs = phase === 'teleop' ? s.clock.teleopElapsedMs : phase === 'auto' ? s.clock.autoElapsedMs : 0;
  const inAuto = phase === 'auto' || phase === 'pause' || phase === 'idle';

  return (
    <div className="flex min-h-screen flex-col gap-3 bg-background p-3 text-foreground">
      {/* Top bar: team badge · phase/window · timer · undo */}
      <header className="flex items-center justify-between gap-3">
        <span
          data-testid="capture-window"
          className="text-sm uppercase tracking-wide text-muted-foreground"
        >
          {phase} · {s.clock.window}
        </span>
        <span className="flex items-center gap-1 text-lg font-semibold tabular-nums">
          <Timer className="size-5" /> {mmss(elapsedMs)}
        </span>
        <Button
          data-testid="capture-undo"
          variant="outline"
          size="icon"
          className="h-12 w-12"
          aria-label="Undo last action"
          disabled={!events.canUndo}
          onClick={() => {
            events.undoLast();
            buzz();
          }}
        >
          <Undo2 className="size-5" />
        </Button>
      </header>

      {/* Body: landscape two-column (field + controls) */}
      <div className="flex flex-1 flex-col gap-3 landscape:flex-row">
        <div className="relative landscape:flex-1">
          <FieldDiagram
            mode={phase === 'idle' || phase === 'auto' ? 'pick-start' : 'view'}
            startPosition={s.autoStartPosition}
            path={s.autoPath}
            onStartChange={(p: FieldPoint) => s.setAutoStartPosition(p)}
            data-testid="capture-field"
          />
          <div
            data-testid="capture-running-fuel"
            className="pointer-events-none absolute left-2 top-2 rounded-lg bg-background/80 px-3 py-1 text-4xl font-bold tabular-nums"
          >
            {fuelCount}
          </div>
        </div>

        <div className="flex flex-col gap-3 landscape:w-72">
          {/* Phase-scoped primary action */}
          {phase === 'idle' && (
            <Button data-testid="capture-start" size="big" className="text-2xl" onClick={() => { s.clock.startAuto(); buzz(25); }}>
              <Play /> START
            </Button>
          )}
          {(phase === 'auto' || phase === 'pause') && (
            <Button data-testid="capture-go" size="big" className="text-2xl" onClick={() => setShowGo(true)}>
              <FastForward /> GO (Teleop)
            </Button>
          )}
          {phase === 'teleop' && (
            <Button data-testid="capture-reanchor" variant="outline" size="big" onClick={() => { s.reAnchorCue(); buzz(); }}>
              0:30 Endgame cue
            </Button>
          )}

          {/* Combined slider-shoot + defense holds */}
          <div className="flex items-stretch gap-3">
            <SliderShoot
              data-testid="capture-hold"
              onShootStart={() => { s.holdStart(); buzz(); }}
              onShootEnd={(rate) => { s.holdEnd(rate); events.recordBurst({ rate }); buzz(20); }}
            />
            <div className="flex flex-1 flex-col gap-3">
              <Button
                data-testid="capture-defense"
                variant="secondary"
                size="big"
                className="flex-1 touch-none select-none flex-col"
                onPointerDown={beginDefense}
                onPointerUp={endDefense}
                onPointerLeave={endDefense}
                onPointerCancel={endDefense}
              >
                <Shield /> Defense
                <span className="text-sm tabular-nums">{secs(s.defenseDurationMs)}</span>
              </Button>
              <Button
                data-testid="capture-defended"
                variant="secondary"
                size="big"
                className="flex-1 touch-none select-none flex-col"
                onPointerDown={beginDefended}
                onPointerUp={endDefended}
                onPointerLeave={endDefended}
                onPointerCancel={endDefended}
              >
                <ShieldAlert /> Defended
                <span className="text-sm tabular-nums">{secs(s.defendedDurationMs)}</span>
              </Button>
            </div>
          </div>

          {/* Secondary actions */}
          <div className="grid grid-cols-2 gap-2">
            <Button
              data-testid="capture-foul"
              variant="outline"
              size="big"
              onClick={() => { s.setFoulsMinor(s.foulsMinor + 1); events.recordFoul({ kind: 'minor' }); buzz(); }}
            >
              <Flag /> Foul ({s.foulsMinor})
            </Button>
            {inAuto && (
              <Button
                variant={s.autoLeftStartingLine ? 'default' : 'outline'}
                size="big"
                onClick={() => { const prev = s.autoLeftStartingLine; s.setAutoLeftStartingLine(!prev); events.recordToggle({ key: 'autoLeftStartingLine', value: !prev, prev }); buzz(); }}
              >
                <MoveUpRight /> Left Line
              </Button>
            )}
            {inAuto && (
              <Button
                variant={s.autoClimbLevel1 ? 'default' : 'outline'}
                size="big"
                onClick={() => { const prev = s.autoClimbLevel1; s.setAutoClimbLevel1(!prev); events.recordToggle({ key: 'autoClimbLevel1', value: !prev, prev }); buzz(); }}
              >
                <Plane /> Auto Climb
              </Button>
            )}
          </div>

          <Button data-testid="capture-to-review" variant="secondary" size="big" className="mt-auto" onClick={props.onToReview}>
            To Review
          </Button>
        </div>
      </div>
    </div>
  );
}
