import { describe, expect, it } from 'vitest';
import { computeAggregates, SCHEMA_VERSION } from '@/scoring';
import {
  canonicalDemoFuelBursts,
  demoFuelFromAttribution,
} from '../../supabase/functions/_shared/demoScoring';

describe('seed-demo canonical report generation', () => {
  it('derives deterministic all-scored aggregates from raw bursts', () => {
    const bursts = canonicalDemoFuelBursts(7, 43, 5);
    const result = computeAggregates({
      schemaVersion: SCHEMA_VERSION,
      inactiveFirst: false,
      fuelBursts: bursts,
      noShow: false,
    });

    expect(result).toMatchObject({
      autoFuel: 7,
      teleopFuelActive: 43,
      teleopFuelInactive: 0,
      endgameFuel: 5,
      fuelPoints: 55,
    });
    expect(canonicalDemoFuelBursts(7, 43, 5)).toEqual(bursts);
    expect(bursts.every((burst) => burst.rate >= 0 && burst.rate <= 30)).toBe(true);
  });

  it('passes attributed points through as fuel and zeroes no-shows', () => {
    expect(demoFuelFromAttribution(100, false)).toBe(100);
    expect(demoFuelFromAttribution(-5, false)).toBe(0);
    expect(demoFuelFromAttribution(100, true)).toBe(0);
  });
});
