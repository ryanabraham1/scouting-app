// src/scoring/__tests__/compute.test.ts
import { describe, it, expect } from 'vitest';
import { computeAggregates } from '../compute';
import type { MatchReportInputs } from '../types';

describe('computeAggregates — multi-burst, boundary-straddle, round-half-up per window', () => {
  // Build a report whose bursts each carry their own pre-classified `window`.
  // Per the frozen semantics, fuel per burst = rate * (endMs - startMs) / 1000,
  // summed per window as a float, then rounded HALF-UP once per window.
  //
  // Straddle case: a burst tagged window='shift1' that physically spans the
  // shift1 lower boundary (10000ms). Window classification is by the burst's
  // declared `window` field; the boundary straddle exercises duration math.
  const input: MatchReportInputs = {
    schemaVersion: 1,
    inactiveFirst: true, // shift1 & shift3 INACTIVE; shift2 & shift4 ACTIVE
    climbLevel: 0,
    autoClimbLevel1: false,
    fuelBursts: [
      // auto: 4.5 fuel -> rounds half-up to 5
      { startMs: 0, endMs: 9000, rate: 0.5, window: 'auto' },
      // transition: 2.5 fuel -> rounds half-up to 3
      { startMs: 0, endMs: 5000, rate: 0.5, window: 'transition' },
      // shift1 (INACTIVE) straddling the 10000ms boundary: 8000..12000 @1.0 = 4.0 -> 4
      { startMs: 8000, endMs: 12000, rate: 1.0, window: 'shift1' },
      //   second shift1 burst: 1500..2000? No — keep within shift1 declared window.
      { startMs: 15000, endMs: 18000, rate: 0.5, window: 'shift1' }, // 1.5 -> shift1 float = 4.0+1.5 = 5.5 -> 6
      // shift2 (ACTIVE): 3.5 -> 4
      { startMs: 35000, endMs: 42000, rate: 0.5, window: 'shift2' },
      // shift3 (INACTIVE): 2.5 -> 3
      { startMs: 60000, endMs: 65000, rate: 0.5, window: 'shift3' },
      // shift4 (ACTIVE): 1.5 -> 2
      { startMs: 85000, endMs: 88000, rate: 0.5, window: 'shift4' },
      // endgame: 6.5 -> 7
      { startMs: 110000, endMs: 123000, rate: 0.5, window: 'endgame' },
    ],
  };

  const agg = computeAggregates(input);

  it('rounds auto half-up once per window', () => {
    expect(agg.autoFuel).toBe(5); // 4.5 -> 5
  });

  it('rounds endgame half-up once per window', () => {
    expect(agg.endgameFuel).toBe(7); // 6.5 -> 7
  });

  it('sums shift floats then rounds once per shift (straddle accumulates before rounding)', () => {
    // shift1 float = 4.0 + 1.5 = 5.5 -> 6
    // shift2 = 3.5 -> 4 ; shift3 = 2.5 -> 3 ; shift4 = 1.5 -> 2
    expect(agg.fuelByShift).toEqual([6, 4, 3, 2]);
  });

  it('teleopFuelActive = transition + active shifts (rounded per window)', () => {
    // transition 3 + shift2 4 + shift4 2 = 9
    expect(agg.teleopFuelActive).toBe(9);
  });

  it('teleopFuelInactive = inactive shifts (rounded per window)', () => {
    // shift1 6 + shift3 3 = 9
    expect(agg.teleopFuelInactive).toBe(9);
  });

  it('fuelPoints = sum of rounded fuel in ACTIVE windows * FUEL_POINTS', () => {
    // active = auto 5 + transition 3 + shift2 4 + shift4 2 + endgame 7 = 21
    expect(agg.fuelPoints).toBe(21);
  });
});

describe('computeAggregates — round-half-up boundary (.5 always up, not banker rounding)', () => {
  it('0.5 rounds to 1, not 0', () => {
    const agg = computeAggregates({
      schemaVersion: 1,
      inactiveFirst: false,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [{ startMs: 0, endMs: 1000, rate: 0.5, window: 'auto' }], // 0.5
    });
    expect(agg.autoFuel).toBe(1);
  });

  it('empty bursts produce all-zero aggregates', () => {
    const agg = computeAggregates({
      schemaVersion: 1,
      inactiveFirst: true,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [],
    });
    expect(agg).toEqual({
      autoFuel: 0,
      teleopFuelActive: 0,
      teleopFuelInactive: 0,
      endgameFuel: 0,
      fuelByShift: [0, 0, 0, 0],
      fuelPoints: 0,
    });
  });
});

describe('computeAggregates — PostgreSQL nano-rate fixed-point parity', () => {
  it('pins the audited decimal counterexample after nano-rate quantization', () => {
    const agg = computeAggregates({
      schemaVersion: 1,
      inactiveFirst: false,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [{
        startMs: 0,
        endMs: 102,
        rate: 14.705882352941176,
        window: 'auto',
      }],
    });

    // floor(rate * 1e9 + .5) = 14_705_882_353 nano-balls/s.
    // 14_705_882_353 * 102 / 1e12 = 1.500000000006 -> 2.
    expect(agg.autoFuel).toBe(2);
  });

  it('rounds the nano-rate boundary before integrating the window', () => {
    const below = computeAggregates({
      schemaVersion: 1,
      inactiveFirst: false,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [{
        startMs: 0,
        endMs: 1000,
        rate: 0.49999999949,
        window: 'auto',
      }],
    });
    const atBoundary = computeAggregates({
      schemaVersion: 1,
      inactiveFirst: false,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [{
        startMs: 0,
        endMs: 1000,
        rate: 0.4999999995,
        window: 'auto',
      }],
    });

    expect(below.autoFuel).toBe(0);
    expect(atBoundary.autoFuel).toBe(1);
  });

  it('accumulates fixed-point burst numerators and rounds once per window', () => {
    const agg = computeAggregates({
      schemaVersion: 1,
      inactiveFirst: false,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [
        { startMs: 0, endMs: 1000, rate: 0.24999999975, window: 'auto' },
        { startMs: 1000, endMs: 2000, rate: 0.24999999975, window: 'auto' },
      ],
    });

    expect(agg.autoFuel).toBe(1);
  });
});

describe('computeAggregates — inactiveFirst:false inverts active/inactive shift attribution', () => {
  // Same 8 bursts as the inactiveFirst:true golden above, but inactiveFirst=false.
  // With inactiveFirst:false: odd shifts (shift1,shift3) are ACTIVE; even (shift2,shift4) INACTIVE.
  // isInactive(n, inactiveFirst) = ((n % 2) === 1) === inactiveFirst
  //   shift1: ((1%2)===1)===false → 1===false → false → ACTIVE
  //   shift2: ((2%2)===1)===false → 0===false → false → ACTIVE? No: isInactive=false → isWindowActive=true (active)
  //   Wait: isWindowActive = !isInactive(n, inactiveFirst)
  //   shift1: isInactive(1, false) = (1===false) = false → isWindowActive = !false = true (ACTIVE)
  //   shift2: isInactive(2, false) = (0===false) = false → isWindowActive = true (ACTIVE)?
  //   That can't be right. Re-check: isInactive = ((n % 2) === 1) === inactiveFirst
  //   shift2: ((2 % 2) === 1) === false = (0 === 1) === false = false === false = true → isInactive=true → INACTIVE
  //   shift1: ((1 % 2) === 1) === false = (1 === 1) === false = true === false = false → isInactive=false → ACTIVE
  //   shift3: ((3 % 2) === 1) === false = true === false = false → ACTIVE
  //   shift4: ((4 % 2) === 1) === false = false === false = true → INACTIVE
  // So with inactiveFirst:false: shift1 & shift3 ACTIVE; shift2 & shift4 INACTIVE.
  const input: MatchReportInputs = {
    schemaVersion: 1,
    inactiveFirst: false, // shift1 & shift3 ACTIVE; shift2 & shift4 INACTIVE
    climbLevel: 0,
    autoClimbLevel1: false,
    fuelBursts: [
      // auto: 4.5 fuel -> rounds half-up to 5
      { startMs: 0, endMs: 9000, rate: 0.5, window: 'auto' },
      // transition: 2.5 fuel -> rounds half-up to 3
      { startMs: 0, endMs: 5000, rate: 0.5, window: 'transition' },
      // shift1 (ACTIVE): float = 4.0 + 1.5 = 5.5 -> 6
      { startMs: 8000, endMs: 12000, rate: 1.0, window: 'shift1' },
      { startMs: 15000, endMs: 18000, rate: 0.5, window: 'shift1' },
      // shift2 (INACTIVE): 3.5 -> 4
      { startMs: 35000, endMs: 42000, rate: 0.5, window: 'shift2' },
      // shift3 (ACTIVE): 2.5 -> 3
      { startMs: 60000, endMs: 65000, rate: 0.5, window: 'shift3' },
      // shift4 (INACTIVE): 1.5 -> 2
      { startMs: 85000, endMs: 88000, rate: 0.5, window: 'shift4' },
      // endgame: 6.5 -> 7
      { startMs: 110000, endMs: 123000, rate: 0.5, window: 'endgame' },
    ],
  };

  const agg = computeAggregates(input);

  it('auto and endgame fuel unchanged (always active)', () => {
    expect(agg.autoFuel).toBe(5);
    expect(agg.endgameFuel).toBe(7);
  });

  it('fuelByShift unchanged (same burst amounts, different active/inactive label)', () => {
    // Per-shift rounded amounts are the same regardless of inactiveFirst
    expect(agg.fuelByShift).toEqual([6, 4, 3, 2]);
  });

  it('teleopFuelActive = transition + shift1(active) + shift3(active)', () => {
    // transition 3 + shift1 6 + shift3 3 = 12  (shift2 & shift4 are now INACTIVE)
    expect(agg.teleopFuelActive).toBe(12);
  });

  it('teleopFuelInactive = shift2(inactive) + shift4(inactive)', () => {
    // shift2 4 + shift4 2 = 6  (shift1 & shift3 are now ACTIVE)
    expect(agg.teleopFuelInactive).toBe(6);
  });

  it('fuelPoints = active fuel * FUEL_POINTS (shift attribution swapped vs inactiveFirst:true)', () => {
    // active = auto 5 + transition 3 + shift1 6 + shift3 3 + endgame 7 = 24
    expect(agg.fuelPoints).toBe(24);
  });
});

describe('computeAggregates — negative-duration bursts contribute ZERO fuel', () => {
  it('a burst with endMs < startMs is clamped, never subtracts from its window', () => {
    // A corrupt/merged burst (e.g. QR-transferred data or a clock jump) with a
    // negative duration used to contribute NEGATIVE fuel, silently deflating
    // the window total and skewing roundHalfUp around zero. It must count as 0.
    const agg = computeAggregates({
      schemaVersion: 1,
      inactiveFirst: false,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [
        { startMs: 0, endMs: 4000, rate: 1.0, window: 'auto' }, // 4.0 fuel
        { startMs: 9000, endMs: 3000, rate: 2.0, window: 'auto' }, // corrupt: -12 → clamps to 0
        { startMs: 5000, endMs: 1000, rate: 5.0, window: 'shift1' }, // corrupt: -20 → clamps to 0
      ],
    });
    expect(agg.autoFuel).toBe(4); // 4.0 + 0, NOT 4.0 - 12
    expect(agg.fuelByShift).toEqual([0, 0, 0, 0]); // 0, NOT -20
    expect(agg.fuelPoints).toBe(4);
  });
});
