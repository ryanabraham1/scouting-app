// src/capture/SliderShoot.tsx
// Combined press-drag "slider-shoot" control. Press and drag UP to set the BPS
// rate (0..max). While held above 0 the robot is "shooting"; on release the thumb
// SPRINGS BACK TO 0 and a fuel burst is committed at the dragged rate.
//
// This replaces the old separate HOLD-WHILE-SHOOTING button + 1..5 rate slider.
import { useCallback, useRef, useState } from 'react';
import { Flame } from 'lucide-react';

export const DEFAULT_MAX_BPS = 30;

/**
 * Map a pointer Y to a rate in [0, max]. Top of the track = max, bottom = 0.
 * Pure + exported so the gesture math is unit-testable without a real layout.
 */
export function rateFromPointer(
  clientY: number,
  rect: { top: number; height: number },
  max: number = DEFAULT_MAX_BPS,
): number {
  if (rect.height <= 0) return 0;
  const fromTop = clientY - rect.top;
  const frac = 1 - fromTop / rect.height; // 0 at bottom, 1 at top
  const clamped = Math.max(0, Math.min(1, frac));
  return Math.round(clamped * max);
}

export interface SliderShootProps {
  /** Called once when the press begins (start of the shooting burst). */
  onShootStart: () => void;
  /** Called once on release with the final dragged rate; commit the burst. */
  onShootEnd: (rate: number) => void;
  max?: number;
  disabled?: boolean;
  ['data-testid']?: string;
}

export function SliderShoot(props: SliderShootProps): JSX.Element {
  const { onShootStart, onShootEnd, max = DEFAULT_MAX_BPS, disabled } = props;
  const testid = props['data-testid'] ?? 'slider-shoot';
  const trackRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(false);
  const rateRef = useRef(0);
  const [rate, setRate] = useState(0);
  const [active, setActive] = useState(false);

  const rectOf = useCallback((): { top: number; height: number } => {
    const el = trackRef.current;
    if (!el) return { top: 0, height: 0 };
    const r = el.getBoundingClientRect();
    return { top: r.top, height: r.height };
  }, []);

  const setFromPointer = useCallback(
    (clientY: number) => {
      if (!Number.isFinite(clientY)) return; // guard envs that don't carry coords
      const r = rateFromPointer(clientY, rectOf(), max);
      rateRef.current = r;
      setRate(r);
    },
    [rectOf, max],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      activeRef.current = true;
      setActive(true);
      setFromPointer(e.clientY);
      onShootStart();
    },
    [disabled, setFromPointer, onShootStart],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!activeRef.current) return;
      setFromPointer(e.clientY);
    },
    [setFromPointer],
  );

  const end = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    const finalRate = rateRef.current;
    setActive(false);
    rateRef.current = 0;
    setRate(0); // spring back to 0
    onShootEnd(finalRate);
  }, [onShootEnd]);

  const pct = max > 0 ? (rate / max) * 100 : 0;

  return (
    <div
      ref={trackRef}
      data-testid={testid}
      data-active={active ? 'true' : 'false'}
      data-rate={rate}
      role="slider"
      aria-label="Shooting rate (BPS)"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={rate}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      className={`relative flex w-24 select-none flex-col items-center justify-end overflow-hidden rounded-2xl border-2 transition-colors ${
        active ? 'border-orange-400 bg-orange-500/20' : 'border-border bg-muted/40'
      } ${disabled ? 'opacity-50' : ''}`}
      style={{ touchAction: 'none', minHeight: 220 }}
    >
      {/* fill */}
      <div
        data-testid={`${testid}-fill`}
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-orange-500/60"
        style={{ height: `${pct}%` }}
      />
      <div className="pointer-events-none relative z-10 flex flex-col items-center gap-1 py-4">
        <Flame className={active ? 'size-8 text-orange-300' : 'size-8 text-muted-foreground'} />
        <span className="text-3xl font-bold tabular-nums">{rate}</span>
        <span className="text-xs uppercase tracking-wide text-muted-foreground">BPS</span>
      </div>
      <span className="pointer-events-none relative z-10 pb-3 text-center text-xs text-muted-foreground">
        {active ? 'SHOOTING' : 'Hold + drag up'}
      </span>
    </div>
  );
}

export default SliderShoot;
