import { describe, it, expect } from 'vitest';
import { evalStat } from '../statExpr';

const values: Record<string, number> = { '1678.bsr': 88.2, '3256.bsr': 71.4, 'our.auto': 26.1, '254.auto': 29.8 };
const resolve = (team: number | 'our', metric: string): number | null => values[`${team}.${metric}`] ?? null;

describe('evalStat', () => {
  it('subtracts two team metrics', () => {
    expect(evalStat('1678.bsr - 3256.bsr', resolve)).toBeCloseTo(16.8, 5);
  });
  it('supports our, epa alias, precedence and parentheses', () => {
    expect(evalStat('(254.auto - our.auto) * 2', resolve)).toBeCloseTo(7.4, 5);
    expect(evalStat('1678.epa / 2 + 1', resolve)).toBeCloseTo(45.1, 5);
    expect(evalStat('-3256.bsr', resolve)).toBeCloseTo(-71.4, 5);
  });
  it('returns null for unknown metrics, missing values, junk and division by zero', () => {
    expect(evalStat('1678.flying', resolve)).toBeNull();
    expect(evalStat('9999.bsr', resolve)).toBeNull();
    expect(evalStat('1678.bsr +', resolve)).toBeNull();
    expect(evalStat('alert(1)', resolve)).toBeNull();
    expect(evalStat('1 / 0', resolve)).toBeNull();
  });
});
