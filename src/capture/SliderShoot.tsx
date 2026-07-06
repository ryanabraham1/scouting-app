// src/capture/SliderShoot.tsx
// Combined press-drag "slider-shoot" control — HORIZONTAL. Press anywhere on the
// full-width bar and drag SIDEWAYS to set the BPS rate (left = 0, right = max).
// While held above 0 the robot is "shooting"; on release the thumb SPRINGS BACK
// TO 0 and a fuel burst is committed at the dragged rate.
//
// This replaces the old vertical track + separate 1..5 rate slider.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Flame, Send } from 'lucide-react';

export const DEFAULT_MAX_BPS = 30;

/**
 * Map a pointer X to a rate in [0, max]. Left edge of the track = 0, right = max.
 * Pure + exported so the gesture math is unit-testable without a real layout.
 */
export function rateFromPointer(
  clientX: number,
  rect: { left: number; width: number },
  max: number = DEFAULT_MAX_BPS,
): number {
  if (rect.width <= 0) return 0;
  const fromLeft = clientX - rect.left;
  const frac = fromLeft / rect.width; // 0 at left, 1 at right
  const clamped = Math.max(0, Math.min(1, frac));
  return Math.round(clamped * max);
}

/**
 * Visual accent for the slider. `energy` (default) = orange "FUEL"/scoring;
 * `brand` = cyan "FEED"/feeding. Each maps to a set of Tailwind classes so the
 * two parallel sliders are instantly distinguishable in the live layout.
 */
export type SliderTone = 'energy' | 'brand';

interface ToneClasses {
  activeBorder: string;
  activeBg: string;
  fill: string;
  thumbActive: string;
  readoutActive: string;
}

const TONES: Record<SliderTone, ToneClasses> = {
  energy: {
    activeBorder: 'border-energy',
    activeBg: 'bg-energy/15',
    fill: 'bg-energy/40',
    thumbActive: 'border-energy bg-energy text-energy-foreground',
    readoutActive: 'text-energy',
  },
  brand: {
    activeBorder: 'border-brand',
    activeBg: 'bg-brand/15',
    fill: 'bg-brand/40',
    thumbActive: 'border-brand bg-brand text-brand-foreground',
    readoutActive: 'text-brand',
  },
};

export interface SliderShootProps {
  /** Called once when the press begins (start of the shooting burst). */
  onShootStart: () => void;
  /** Called once on release with the final dragged rate; commit the burst. */
  onShootEnd: (rate: number) => void;
  /** Called on press and on every drag with the live rate (for a live readout). */
  onShootRate?: (rate: number) => void;
  max?: number;
  disabled?: boolean;
  /** Visual accent + default labels/icon. Defaults to the orange scoring tone. */
  tone?: SliderTone;
  /** Short unit/metric label shown next to the live value (e.g. "BPS"). */
  unitLabel?: string;
  /** Verb shown while active (e.g. "SHOOTING" / "FEEDING"). */
  activeLabel?: string;
  /** Hint shown while idle (e.g. "Hold + slide →"). */
  idleLabel?: string;
  /** ARIA label for the slider role. */
  ['aria-label']?: string;
  /** Extra classes merged onto the track (e.g. `h-full` to fill a flex cell). */
  className?: string;
  ['data-testid']?: string;
}

export function SliderShoot(props: SliderShootProps): JSX.Element {
  const {
    onShootStart,
    onShootEnd,
    onShootRate,
    max = DEFAULT_MAX_BPS,
    disabled,
    tone = 'energy',
    unitLabel = 'BPS',
    activeLabel,
    idleLabel = 'Hold + slide →',
  } = props;
  const testid = props['data-testid'] ?? 'slider-shoot';
  const ariaLabel = props['aria-label'] ?? 'Shooting rate (BPS)';
  const toneCls = TONES[tone];
  const Icon = tone === 'brand' ? Send : Flame;
  const activeText = activeLabel ?? (tone === 'brand' ? 'FEEDING' : 'SHOOTING');

  const trackRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(false);
  const rateRef = useRef(0);
  const [rate, setRate] = useState(0);
  const [active, setActive] = useState(false);

  const rectOf = useCallback((): { left: number; width: number } => {
    const el = trackRef.current;
    if (!el) return { left: 0, width: 0 };
    const r = el.getBoundingClientRect();
    return { left: r.left, width: r.width };
  }, []);

  const setFromPointer = useCallback(
    (clientX: number) => {
      if (!Number.isFinite(clientX)) return; // guard envs that don't carry coords
      const r = rateFromPointer(clientX, rectOf(), max);
      rateRef.current = r;
      setRate(r);
      onShootRate?.(r);
    },
    [rectOf, max, onShootRate],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      // setPointerCapture throws InvalidStateError for an inactive pointer id
      // (e.g. synthetic events); capture is a nice-to-have, never block the gesture.
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore — proceed without pointer capture */
      }
      activeRef.current = true;
      setActive(true);
      setFromPointer(e.clientX);
      onShootStart();
    },
    [disabled, setFromPointer, onShootStart],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!activeRef.current) return;
      setFromPointer(e.clientX);
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
    onShootRate?.(0);
    onShootEnd(finalRate);
  }, [onShootEnd, onShootRate]);

  // Commit an in-flight hold if the control unmounts mid-gesture (screen swap
  // to the GO interstitial / review) — otherwise onShootEnd never fires and the
  // integrated balls are silently dropped while the session's hold refs keep
  // ghost-integrating.
  const endRef = useRef(end);
  endRef.current = end;
  useEffect(() => () => endRef.current(), []);

  const pct = max > 0 ? (rate / max) * 100 : 0;
  // The thumb is half its own width (size-16 = 4rem → 2rem radius). Inset its
  // travel by THUMB_INSET on both sides so at rate 0 (left) and rate max (right)
  // the whole thumb — including the icon — stays fully on-screen instead of being
  // clipped by the container's overflow-hidden.
  const THUMB_INSET = '2.25rem';
  const thumbLeft = `calc(${THUMB_INSET} + (100% - 2 * ${THUMB_INSET}) * ${pct / 100})`;

  return (
    <div
      ref={trackRef}
      data-testid={testid}
      data-active={active ? 'true' : 'false'}
      data-rate={rate}
      data-tone={tone}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={rate}
      aria-orientation="horizontal"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      className={`relative flex w-full select-none items-center overflow-hidden rounded-2xl border-2 transition-colors ${
        active ? `${toneCls.activeBorder} ${toneCls.activeBg}` : 'border-border bg-muted/40'
      } ${disabled ? 'opacity-50' : ''} ${props.className ?? ''}`}
      style={{ touchAction: 'none', minHeight: 72 }}
    >
      {/* horizontal fill: left edge → thumb center */}
      <div
        data-testid={`${testid}-fill`}
        className={`pointer-events-none absolute inset-y-0 left-0 ${toneCls.fill} transition-[width]`}
        style={{ width: thumbLeft }}
      />
      {/* thumb — inset so the icon is never clipped at rate 0 or rate max */}
      <div
        data-testid={`${testid}-thumb`}
        className={`pointer-events-none absolute top-1/2 z-10 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border-2 shadow-lg transition-colors ${
          active ? toneCls.thumbActive : 'border-border bg-card text-muted-foreground'
        }`}
        style={{ left: thumbLeft }}
      >
        <Icon className="size-7" />
      </div>
      {/* right-anchored live readout so it never sits under the thumb (which
          starts at the LEFT) and is never clipped by overflow-hidden. */}
      <div className="pointer-events-none relative z-20 ml-auto mr-6 flex flex-col items-end text-right">
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold tabular-nums leading-none sm:text-4xl">{rate}</span>
          <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {unitLabel}
          </span>
        </div>
        <span
          className={`text-sm font-semibold uppercase tracking-wide ${
            active ? toneCls.readoutActive : 'text-muted-foreground'
          }`}
        >
          {active ? activeText : idleLabel}
        </span>
      </div>
    </div>
  );
}

export default SliderShoot;
