import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { useCaptureSession } from '@/capture/useCaptureSession';

export function CaptureScreen(props: {
  session: ReturnType<typeof useCaptureSession>;
  onToReview: () => void;
}) {
  const s = props.session;
  const [showGo, setShowGo] = useState(false);

  const fuelCount = s.bursts.length;
  const phase = s.clock.state.phase;

  if (showGo) {
    return (
      <div
        data-testid="capture-go-interstitial"
        className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6 text-foreground"
      >
        <p className="text-xl font-semibold">Your HUB inactive first?</p>
        <div className="flex w-full max-w-sm gap-4">
          <Button
            data-testid="capture-inactive-yes"
            className="h-16 min-h-[44px] flex-1 text-lg"
            onClick={() => {
              s.setInactiveFirst(true);
              s.clock.markGo();
              setShowGo(false);
            }}
          >
            Yes
          </Button>
          <Button
            data-testid="capture-inactive-no"
            variant="secondary"
            className="h-16 min-h-[44px] flex-1 text-lg"
            onClick={() => {
              s.setInactiveFirst(false);
              s.clock.markGo();
              setShowGo(false);
            }}
          >
            No
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col gap-4 bg-background p-4 text-foreground">
      <div className="flex items-center justify-between">
        <span
          data-testid="capture-window"
          className="text-sm uppercase tracking-wide text-muted-foreground"
        >
          {phase} · {s.clock.window}
        </span>
        <span className="text-sm">
          {s.inactiveFirst === null ? '—' : s.inactiveFirst ? 'INACTIVE 1st' : 'ACTIVE 1st'}
        </span>
      </div>

      <div
        data-testid="capture-running-fuel"
        className="text-center text-5xl font-bold tabular-nums"
      >
        {fuelCount}
      </div>

      {phase === 'idle' && (
        <Button
          data-testid="capture-start"
          className="h-20 min-h-[44px] text-2xl"
          onClick={() => s.clock.startAuto()}
        >
          START
        </Button>
      )}

      {(phase === 'auto' || phase === 'pause') && (
        <Button
          data-testid="capture-go"
          className="h-20 min-h-[44px] text-2xl"
          onClick={() => setShowGo(true)}
        >
          GO (Teleop)
        </Button>
      )}

      <Button
        data-testid="capture-hold"
        className="h-40 min-h-[44px] touch-none select-none text-3xl"
        onPointerDown={() => s.holdStart()}
        onPointerUp={() => s.holdEnd()}
        onPointerLeave={() => s.holdEnd()}
      >
        HOLD WHILE SHOOTING
      </Button>

      <div className="flex items-center gap-2">
        <span className="text-sm">Rate</span>
        <input
          data-testid="capture-rate"
          type="range"
          min={1}
          max={5}
          step={1}
          value={s.rate}
          onChange={(e) => s.setRate(Number(e.target.value))}
          className="h-11 flex-1"
        />
        <span className="w-6 text-center tabular-nums">{s.rate}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          data-testid="capture-foul"
          variant="secondary"
          className="h-14 min-h-[44px]"
          onClick={() => s.setFoulsMinor(s.foulsMinor + 1)}
        >
          FOUL ({s.foulsMinor})
        </Button>
        <Button
          data-testid="capture-defense"
          variant="secondary"
          className="h-14 min-h-[44px]"
          onClick={() => s.setDefenseRating(Math.min(3, s.defenseRating + 1) as 0 | 1 | 2 | 3)}
        >
          DEFENSE ({s.defenseRating})
        </Button>
        <Button
          variant={s.autoLeftStartingLine ? 'default' : 'outline'}
          className="h-14 min-h-[44px]"
          onClick={() => s.setAutoLeftStartingLine(!s.autoLeftStartingLine)}
        >
          LEFT LINE
        </Button>
        <Button
          variant={s.autoClimbLevel1 ? 'default' : 'outline'}
          className="h-14 min-h-[44px]"
          onClick={() => s.setAutoClimbLevel1(!s.autoClimbLevel1)}
        >
          AUTO CLIMB
        </Button>
      </div>

      {phase === 'teleop' && (
        <Button
          data-testid="capture-reanchor"
          variant="outline"
          className="h-14 min-h-[44px]"
          onClick={() => s.reAnchorCue()}
        >
          0:30 Endgame cue
        </Button>
      )}

      <Button
        data-testid="capture-to-review"
        variant="secondary"
        className="mt-auto h-16 min-h-[44px] text-xl"
        onClick={props.onToReview}
      >
        To Review
      </Button>
    </div>
  );
}
