// src/scoring/compute.ts
import type { MatchReportInputs, MatchReportAggregates, MatchWindow } from './types';
import { SCORING } from './constants';
import { isWindowActive } from './windows';

const RATE_SCALE_DIGITS = 9;
const WINDOW_DIVISOR = 1_000_000_000_000n;
const WINDOW_HALF = WINDOW_DIVISOR / 2n;

// PostgreSQL receives a JSON number's decimal spelling, converts it to numeric,
// then applies floor(rate * 1e9 + 0.5). Parse the same decimal spelling instead
// of multiplying an IEEE-754 value: the audited 14.705882352941176 × 102 ms
// counterexample otherwise lands on the opposite side of the .5 boundary.
function quantizeRateNano(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) return 0n;
  const match = rate.toString().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) return 0n;
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  const digits = BigInt(`${match[1]}${fraction}`);
  const shift = RATE_SCALE_DIGITS + exponent - fraction.length;
  if (shift >= 0) return digits * (10n ** BigInt(shift));

  const divisor = 10n ** BigInt(-shift);
  const quotient = digits / divisor;
  const remainder = digits % divisor;
  return quotient + (remainder * 2n >= divisor ? 1n : 0n);
}

function burstNumerator(rate: number, startMs: number, endMs: number): bigint {
  const durationMs = Math.max(0, endMs - startMs);
  if (!Number.isSafeInteger(durationMs)) return 0n;
  return quantizeRateNano(rate) * BigInt(durationMs);
}

function roundWindow(numerator: bigint): number {
  return Number((numerator + WINDOW_HALF) / WINDOW_DIVISOR);
}

export function computeAggregates(input: MatchReportInputs): MatchReportAggregates {
  // Accumulate nano-balls/second × milliseconds as exact integers per window.
  const numeratorByWindow: Record<MatchWindow, bigint> = {
    auto: 0n,
    transition: 0n,
    shift1: 0n,
    shift2: 0n,
    shift3: 0n,
    shift4: 0n,
    endgame: 0n,
  };

  for (const b of input.fuelBursts) {
    numeratorByWindow[b.window] += burstNumerator(b.rate, b.startMs, b.endMs);
  }

  // Divide by 1e9 nano-units and 1000 ms/s, half-up ONCE per window.
  const roundedByWindow: Record<MatchWindow, number> = {
    auto: roundWindow(numeratorByWindow.auto),
    transition: roundWindow(numeratorByWindow.transition),
    shift1: roundWindow(numeratorByWindow.shift1),
    shift2: roundWindow(numeratorByWindow.shift2),
    shift3: roundWindow(numeratorByWindow.shift3),
    shift4: roundWindow(numeratorByWindow.shift4),
    endgame: roundWindow(numeratorByWindow.endgame),
  };

  const fuelByShift: [number, number, number, number] = [
    roundedByWindow.shift1,
    roundedByWindow.shift2,
    roundedByWindow.shift3,
    roundedByWindow.shift4,
  ];

  let teleopFuelActive = roundedByWindow.transition; // transition is always active teleop
  let teleopFuelInactive = 0;
  for (const w of ['shift1', 'shift2', 'shift3', 'shift4'] as const) {
    if (isWindowActive(w, input.inactiveFirst)) {
      teleopFuelActive += roundedByWindow[w];
    } else {
      teleopFuelInactive += roundedByWindow[w];
    }
  }

  // fuelPoints = sum of rounded fuel in ACTIVE windows * FUEL_POINTS.
  // auto + transition + endgame always active; shiftN if active.
  let activeFuel = roundedByWindow.auto + roundedByWindow.transition + roundedByWindow.endgame;
  for (const w of ['shift1', 'shift2', 'shift3', 'shift4'] as const) {
    if (isWindowActive(w, input.inactiveFirst)) {
      activeFuel += roundedByWindow[w];
    }
  }
  const fuelPoints = activeFuel * SCORING.FUEL_POINTS;

  return {
    autoFuel: roundedByWindow.auto,
    teleopFuelActive,
    teleopFuelInactive,
    endgameFuel: roundedByWindow.endgame,
    fuelByShift,
    fuelPoints,
  };
}
