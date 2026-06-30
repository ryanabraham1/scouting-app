// src/dash/__tests__/autoGrouping.test.ts
import { describe, it, expect } from 'vitest';
import { groupAutoPaths, resample } from '@/dash/autoGrouping';
import type { AutoPath } from '@/dash/AutoHeatmap';

function mk(label: string, start: { x: number; y: number } | null, path: { x: number; y: number }[] | null): AutoPath {
  return { matchKey: `e_${label}`, label, start, path, alliance: 'blue' };
}

describe('resample', () => {
  it('returns n copies of the single point for a degenerate polyline', () => {
    expect(resample([{ x: 0.2, y: 0.3 }], 4)).toEqual([
      { x: 0.2, y: 0.3 },
      { x: 0.2, y: 0.3 },
      { x: 0.2, y: 0.3 },
      { x: 0.2, y: 0.3 },
    ]);
  });

  it('places endpoints at the polyline ends and spaces by arc length', () => {
    const out = resample([{ x: 0, y: 0 }, { x: 1, y: 0 }], 3);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[2]).toEqual({ x: 1, y: 0 });
    expect(out[1].x).toBeCloseTo(0.5, 6);
  });
});

describe('groupAutoPaths', () => {
  it('folds near-identical routines into ONE option (jitter tolerated)', () => {
    const a = mk('q1', { x: 0.1, y: 0.5 }, [{ x: 0.4, y: 0.5 }, { x: 0.7, y: 0.5 }]);
    const b = mk('q2', { x: 0.11, y: 0.51 }, [{ x: 0.41, y: 0.49 }, { x: 0.69, y: 0.5 }]);
    const groups = groupAutoPaths([a, b]);
    expect(groups.length).toBe(1);
    expect(groups[0].members.length).toBe(2);
  });

  it('separates genuinely different paths into distinct options', () => {
    const left = mk('q1', { x: 0.1, y: 0.2 }, [{ x: 0.4, y: 0.2 }]);
    const right = mk('q2', { x: 0.1, y: 0.8 }, [{ x: 0.4, y: 0.8 }]);
    const groups = groupAutoPaths([left, right]);
    expect(groups.length).toBe(2);
  });

  it('orders options most-run first and exposes a representative', () => {
    const common = (l: string) => mk(l, { x: 0.2, y: 0.3 }, [{ x: 0.5, y: 0.3 }]);
    const rare = mk('q9', { x: 0.2, y: 0.9 }, [{ x: 0.5, y: 0.9 }]);
    const groups = groupAutoPaths([common('q1'), rare, common('q2'), common('q3')]);
    expect(groups[0].members.length).toBe(3); // the common option leads
    expect(groups[1].members.length).toBe(1);
    expect(groups[0].representative.start).toEqual({ x: 0.2, y: 0.3 });
  });
});
