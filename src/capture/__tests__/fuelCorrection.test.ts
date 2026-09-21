import { describe, it, expect } from 'vitest';
import {
  adjustFuelTotal,
  groupFuelMax,
  groupFuelTotal,
  FUEL_GROUP_WINDOWS,
} from '@/capture/fuelCorrection';
import { computeAggregates, SCHEMA_VERSION, type FuelBurst } from '@/scoring';

const TELEOP = FUEL_GROUP_WINDOWS.teleop;

const bursts: FuelBurst[] = [
  { startMs: 1000, endMs: 3000, rate: 5, window: 'auto' }, // 10
  { startMs: 2000, endMs: 4000, rate: 4, window: 'transition' }, // 8
  { startMs: 12000, endMs: 15000, rate: 3, window: 'shift1' }, // 9
  { startMs: 40000, endMs: 41500, rate: 2, window: 'shift2' }, // 3
  { startMs: 120000, endMs: 122000, rate: 6, window: 'endgame' }, // 12
];

function agg(b: FuelBurst[]) {
  return computeAggregates({
    schemaVersion: SCHEMA_VERSION,
    inactiveFirst: false,
    fuelBursts: b,
    noShow: false,
  });
}

describe('adjustFuelTotal', () => {
  it('reports the same totals computeAggregates does', () => {
    const a = agg(bursts);
    expect(groupFuelTotal(bursts, FUEL_GROUP_WINDOWS.auto)).toBe(a.autoFuel);
    expect(groupFuelTotal(bursts, TELEOP)).toBe(a.teleopFuelActive + a.teleopFuelInactive);
    expect(groupFuelTotal(bursts, FUEL_GROUP_WINDOWS.endgame)).toBe(a.endgameFuel);
  });

  it('is a no-op (same reference) when the target already matches', () => {
    expect(adjustFuelTotal(bursts, TELEOP, 20)).toBe(bursts);
  });

  it('decrease trims from the END and keeps earlier bursts intact', () => {
    const out = adjustFuelTotal(bursts, TELEOP, 18);
    expect(agg(out).teleopFuelActive).toBe(18);
    // transition + shift1 untouched; shift2 shrank.
    expect(out.filter((b) => b.window === 'transition')).toEqual([bursts[1]]);
    expect(out.filter((b) => b.window === 'shift1')).toEqual([bursts[2]]);
    const s2 = out.filter((b) => b.window === 'shift2');
    expect(s2).toHaveLength(1);
    expect(s2[0].startMs).toBe(40000);
    expect(s2[0].endMs).toBeLessThan(41500);
    // Other groups never move.
    expect(agg(out).autoFuel).toBe(10);
    expect(agg(out).endgameFuel).toBe(12);
  });

  it('decrease drops whole bursts when needed and lands exactly', () => {
    const out = adjustFuelTotal(bursts, TELEOP, 5);
    expect(agg(out).teleopFuelActive).toBe(5);
    expect(out.some((b) => b.window === 'shift2')).toBe(false);
    expect(out.some((b) => b.window === 'shift1')).toBe(false);
    const tr = out.filter((b) => b.window === 'transition');
    expect(tr).toHaveLength(1);
    expect(tr[0].startMs).toBe(2000);
  });

  it('decrease to zero removes every burst in the group only', () => {
    const out = adjustFuelTotal(bursts, TELEOP, 0);
    expect(out.filter((b) => TELEOP.includes(b.window))).toHaveLength(0);
    expect(out).toHaveLength(2);
    expect(agg(out).autoFuel).toBe(10);
    expect(agg(out).endgameFuel).toBe(12);
  });

  it('increase appends ONE correction burst in the latest active window', () => {
    const out = adjustFuelTotal(bursts, TELEOP, 27);
    expect(agg(out).teleopFuelActive).toBe(27);
    expect(out).toHaveLength(bursts.length + 1);
    const added = out[out.length - 1];
    expect(added.window).toBe('shift2');
    expect(added.endMs).toBe(60000);
    expect(added.rate).toBeLessThanOrEqual(30);
    // Originals are byte-identical.
    expect(out.slice(0, bursts.length)).toEqual(bursts);
  });

  it('increase on an empty group lands in its final window', () => {
    const out = adjustFuelTotal(bursts.filter((b) => b.window !== 'auto'), ['auto'], 7);
    expect(agg(out).autoFuel).toBe(7);
    const a = out.filter((b) => b.window === 'auto');
    expect(a).toHaveLength(1);
    expect(a[0].endMs).toBe(20000);
    expect(a[0].rate).toBe(7);
  });

  it('large increases respect the 30/s rate cap by stretching duration', () => {
    const out = adjustFuelTotal([], FUEL_GROUP_WINDOWS.endgame, 95);
    expect(agg(out).endgameFuel).toBe(95);
    expect(out[0].rate).toBeLessThanOrEqual(30);
    expect(out[0].endMs - out[0].startMs).toBe(4000);
  });

  it('clamps to the physical ceiling of the group', () => {
    const max = groupFuelMax(FUEL_GROUP_WINDOWS.auto);
    expect(max).toBe(600);
    const out = adjustFuelTotal([], FUEL_GROUP_WINDOWS.auto, 10_000);
    expect(agg(out).autoFuel).toBe(max);
  });

  it('lands exactly across a sweep of targets (rounding ties included)', () => {
    const tie: FuelBurst[] = [
      { startMs: 0, endMs: 1000, rate: 0.5, window: 'shift3' }, // exactly 0.5 → rounds to 1
      { startMs: 2000, endMs: 2333, rate: 7.77, window: 'shift3' },
      { startMs: 50000, endMs: 50101, rate: 14.705882352941176, window: 'shift4' },
    ];
    const base = groupFuelTotal(tie, TELEOP);
    for (let t = 0; t <= base + 40; t += 1) {
      const out = adjustFuelTotal(tie, TELEOP, t);
      expect(groupFuelTotal(out, TELEOP), `target ${t}`).toBe(t);
    }
  });
});
