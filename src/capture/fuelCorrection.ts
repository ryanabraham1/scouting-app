// src/capture/fuelCorrection.ts — hand-corrected fuel TOTALS from the Review step.
//
// Fuel is never stored as a count: it's integrated from timestamped bursts
// (rate × duration, rounded half-up ONCE per window — see scoring/compute.ts),
// and the dashboard reads those same bursts for tempo, cycle time and defense
// suppression. So a scout correcting "Teleop fuel: 31 → 28" must re-fit the
// bursts, not overwrite a number. This mirrors `adjustIntervalsTotal`'s
// absorb-at-the-END rule so the earlier timeline positions survive:
//   - decrease → bursts shrink (and drop when emptied) from the latest window
//     backwards, one ms at a time once close, until the rounded total lands;
//   - increase → ONE synthetic burst is appended at the end of the latest
//     window that already has shooting (or the group's last window), sized so
//     the rounded total lands exactly on the target.
// Pure. The rounded total is verified against the SAME integer math the
// aggregates use, so preview, local storage and the server RPC all agree.
import {
  AUTO_MS,
  TELEOP_MS,
} from '@/capture/clock';
import {
  SHIFT_BOUNDS,
  roundFuelNumerator,
  windowFuelNumerator,
  windowFuelTotal,
  type FuelBurst,
  type MatchWindow,
} from '@/scoring';

/** Max slider rate the sanitizer/server accept (sanitizeBursts clamps to 30). */
const MAX_RATE = 30;

/** Editable fuel groups on the Review summary, each in timeline order. */
export const FUEL_GROUP_WINDOWS: Record<'auto' | 'teleop' | 'endgame', readonly MatchWindow[]> = {
  auto: ['auto'],
  teleop: ['transition', 'shift1', 'shift2', 'shift3', 'shift4'],
  endgame: ['endgame'],
};
export type FuelGroup = keyof typeof FUEL_GROUP_WINDOWS;

/** Phase-elapsed ms bounds of a window (auto is its own clock; the rest are teleop). */
function windowBounds(window: MatchWindow): { start: number; end: number } {
  if (window === 'auto') return { start: 0, end: AUTO_MS };
  const b = SHIFT_BOUNDS[window];
  return { start: b.start, end: Math.min(b.end, TELEOP_MS) };
}

/** Rounded fuel across a group of windows (Σ of per-window rounded values, as computeAggregates does). */
export function groupFuelTotal(bursts: readonly FuelBurst[], windows: readonly MatchWindow[]): number {
  return windows.reduce((sum, w) => sum + windowFuelTotal(bursts, w), 0);
}

/** Physical ceiling for a group: max rate for the whole span of its windows. */
export function groupFuelMax(windows: readonly MatchWindow[]): number {
  return windows.reduce((sum, w) => {
    const b = windowBounds(w);
    return sum + Math.floor((MAX_RATE * (b.end - b.start)) / 1000);
  }, 0);
}

/**
 * Re-fit `bursts` so the rounded fuel over `windows` equals `target`. Bursts in
 * other windows are returned untouched. Returns the SAME array when nothing
 * changes so callers can cheaply skip a re-persist.
 */
export function adjustFuelTotal(
  bursts: readonly FuelBurst[],
  windows: readonly MatchWindow[],
  target: number,
): FuelBurst[] {
  const goal = Math.min(groupFuelMax(windows), Math.max(0, Math.round(target)));
  const current = groupFuelTotal(bursts, windows);
  if (goal === current || !Number.isFinite(goal)) return bursts as FuelBurst[];
  const out: FuelBurst[] = bursts.map((b) => ({ ...b }));
  return goal > current ? raiseTo(out, windows, goal) : lowerTo(out, windows, goal);
}

function raiseTo(out: FuelBurst[], windows: readonly MatchWindow[], goal: number): FuelBurst[] {
  const delta = goal - groupFuelTotal(out, windows);
  // Latest window that already has shooting keeps the correction near the real
  // activity; an empty group lands the burst in its final window.
  const window =
    [...windows].reverse().find((w) => out.some((b) => b.window === w)) ??
    windows[windows.length - 1];
  const bounds = windowBounds(window);
  const spanMs = bounds.end - bounds.start;
  // Whole seconds at ≤ MAX_RATE so `rate × duration` is a clean integer; fall
  // back to the window span (rate then rises, still capped) when it won't fit.
  const durationMs = Math.min(spanMs, Math.max(1, Math.ceil(delta / MAX_RATE)) * 1000);
  const synthetic: FuelBurst = {
    startMs: bounds.end - durationMs,
    endMs: bounds.end,
    rate: Math.min(MAX_RATE, delta / (durationMs / 1000)),
    window,
  };
  out.push(synthetic);
  // Nano-quantisation of the rate can straddle a half-up tie in the existing
  // numerator; nudge the correction burst by ±1e-6 balls/s until it lands.
  for (let i = 0; i < 8; i += 1) {
    const total = groupFuelTotal(out, windows);
    if (total === goal) break;
    synthetic.rate = Math.min(MAX_RATE, Math.max(0, synthetic.rate + (total < goal ? 1e-6 : -1e-6)));
  }
  return out;
}

function lowerTo(out: FuelBurst[], windows: readonly MatchWindow[], goal: number): FuelBurst[] {
  for (const window of [...windows].reverse()) {
    // Rounded fuel in every OTHER window of the group is fixed while we trim this one.
    const othersTotal = windows
      .filter((w) => w !== window)
      .reduce((sum, w) => sum + windowFuelTotal(out, w), 0);
    const goalHere = goal - othersTotal;
    for (;;) {
      const inWindow = out
        .map((b, index) => ({ b, index }))
        .filter(({ b }) => b.window === window)
        .sort((x, y) => y.b.endMs - x.b.endMs || y.b.startMs - x.b.startMs);
      if (inWindow.length === 0) break;
      if (windowFuelTotal(out, window) <= goalHere) break;
      const { b, index } = inWindow[0];
      const restNumerator = windowFuelNumerator(
        out.filter((_, i) => i !== index),
        window,
      );
      // Dropping the whole burst still leaves us at/above goal → drop it.
      if (roundFuelNumerator(restNumerator) >= goalHere) {
        out.splice(index, 1);
        continue;
      }
      // Otherwise this burst straddles the goal: proportional first guess, then
      // walk endMs by single ms (≤ 0.03 balls each) until the rounded total lands.
      const own = windowFuelNumerator([b], window);
      const need = roundFuelNumerator(restNumerator + own) - goalHere; // balls to shed
      const ownBalls = Number(own) / 1e12;
      const dur = Math.max(0, b.endMs - b.startMs);
      const keep = ownBalls > 0 ? Math.max(0, (ownBalls - need) / ownBalls) : 0;
      const originalEnd = b.endMs;
      b.endMs = b.startMs + Math.floor(dur * keep);
      const totalWith = () => roundFuelNumerator(restNumerator + windowFuelNumerator([b], window));
      while (totalWith() > goalHere && b.endMs > b.startMs) b.endMs -= 1;
      while (totalWith() < goalHere && b.endMs < originalEnd) b.endMs += 1;
      if (b.endMs <= b.startMs) out.splice(index, 1);
      break; // this window now sits exactly on goalHere (or is empty)
    }
    if (groupFuelTotal(out, windows) <= goal) break;
  }
  return out;
}
