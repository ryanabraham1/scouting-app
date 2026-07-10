import { describe, expect, it } from 'vitest';
import { computeAggregates, SCHEMA_VERSION } from '@/scoring';
import {
  canonicalDemoFuelBursts,
  demoFuelFromAttribution,
} from '../../supabase/functions/_shared/demoScoring';

describe('seed-demo canonical report generation', () => {
  it.each([false, true])(
    'derives deterministic aggregates from raw bursts (inactiveFirst=%s)',
    (inactiveFirst) => {
      const bursts = canonicalDemoFuelBursts(7, 31, 12, 5, inactiveFirst);
      const result = computeAggregates({
        schemaVersion: SCHEMA_VERSION,
        inactiveFirst,
        fuelBursts: bursts,
        climbLevel: 0,
        autoClimbLevel1: false,
      });

      expect(result).toMatchObject({
        autoFuel: 7,
        teleopFuelActive: 31,
        teleopFuelInactive: 12,
        endgameFuel: 5,
        fuelPoints: 43,
      });
      expect(canonicalDemoFuelBursts(7, 31, 12, 5, inactiveFirst)).toEqual(bursts);
      expect(bursts.every((burst) => burst.rate >= 0 && burst.rate <= 30)).toBe(true);
    },
  );

  it('subtracts both climb phases and zeroes no-shows', () => {
    expect(demoFuelFromAttribution(100, 30, true, false)).toBe(55);
    expect(demoFuelFromAttribution(10, 30, true, false)).toBe(0);
    expect(demoFuelFromAttribution(100, 30, true, true)).toBe(0);
  });
});
