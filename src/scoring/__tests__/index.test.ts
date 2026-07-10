// src/scoring/__tests__/index.test.ts
import { describe, it, expect } from 'vitest';
import * as scoring from '../index';

describe('scoring public API surface', () => {
  it('re-exports the frozen value exports', () => {
    expect(scoring.SCHEMA_VERSION).toBe(2);
    expect(scoring.SCORING.FUEL_POINTS).toBe(1);
    expect(typeof scoring.isInactive).toBe('function');
    expect(typeof scoring.isWindowActive).toBe('function');
    expect(typeof scoring.shiftNumberOf).toBe('function');
    expect(typeof scoring.computeAggregates).toBe('function');
    expect(typeof scoring.migrateUp).toBe('function');
    expect(scoring.SHIFT_BOUNDS.shift1).toEqual({ start: 10000, end: 35000 });
  });

  it('wires computeAggregates end-to-end through the barrel', () => {
    const agg = scoring.computeAggregates({
      schemaVersion: scoring.SCHEMA_VERSION,
      inactiveFirst: false,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [{ startMs: 0, endMs: 10000, rate: 1, window: 'auto' }], // 10
    });
    expect(agg.autoFuel).toBe(10);
    expect(agg.fuelPoints).toBe(10);
  });
});
