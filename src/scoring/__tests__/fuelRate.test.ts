import { describe, it, expect } from 'vitest';
import { computeAggregates, SCHEMA_VERSION, type FuelBurst } from '@/scoring';

// Regression: bots commonly exceed 5 BPS, so the slider-shoot rate ranges 0..30.
// computeAggregates multiplies rate * duration, so a high rate must scale linearly.
describe('computeAggregates with rate > 5 (0..30 BPS)', () => {
  it('scales fuel linearly with a 20 BPS burst', () => {
    const burst: FuelBurst = { startMs: 0, endMs: 1000, rate: 20, window: 'transition' };
    const agg = computeAggregates({
      schemaVersion: SCHEMA_VERSION,
      inactiveFirst: false,
      fuelBursts: [burst],
      climbLevel: 0,
      autoClimbLevel1: false,
    });
    // 20 BPS for 1.0s = 20 fuel in the (always-active) transition window.
    expect(agg.teleopFuelActive).toBe(20);
  });

  it('handles the 30 BPS ceiling', () => {
    const burst: FuelBurst = { startMs: 0, endMs: 2000, rate: 30, window: 'transition' };
    const agg = computeAggregates({
      schemaVersion: SCHEMA_VERSION,
      inactiveFirst: false,
      fuelBursts: [burst],
      climbLevel: 0,
      autoClimbLevel1: false,
    });
    // 30 BPS for 2.0s = 60 fuel.
    expect(agg.teleopFuelActive).toBe(60);
  });
});
