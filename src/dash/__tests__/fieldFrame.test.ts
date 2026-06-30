// src/dash/__tests__/fieldFrame.test.ts
import { describe, it, expect } from 'vitest';
import { rotate180, pointToFrame } from '@/dash/fieldFrame';
import { autoPathToFrame } from '@/dash/autoGrouping';
import type { AutoPath } from '@/dash/AutoHeatmap';

describe('rotate180 (red↔blue 180° field rotation)', () => {
  it('flips both axes about the center', () => {
    expect(rotate180({ x: 0.3, y: 0.2 })).toEqual({ x: 0.7, y: 0.8 });
    expect(rotate180({ x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 }); // center fixed
  });

  it('is its own inverse', () => {
    const p = { x: 0.18, y: 0.42 };
    const back = rotate180(rotate180(p));
    expect(back.x).toBeCloseTo(p.x, 10);
    expect(back.y).toBeCloseTo(p.y, 10);
  });
});

describe('pointToFrame', () => {
  it('is identity when from === to, rotates otherwise', () => {
    const p = { x: 0.3, y: 0.2 };
    expect(pointToFrame(p, 'red', 'red')).toBe(p);
    expect(pointToFrame(p, 'red', 'blue')).toEqual({ x: 0.7, y: 0.8 });
    expect(pointToFrame(p, 'blue', 'red')).toEqual({ x: 0.7, y: 0.8 });
  });
});

describe('autoPathToFrame', () => {
  const redAuto: AutoPath = {
    matchKey: 'e_qm1',
    label: 'Q1',
    start: { x: 0.2, y: 0.3 },
    path: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.3 }],
    alliance: 'red',
  };

  it('re-frames a red routine onto blue (start + every vertex rotated)', () => {
    const blue = autoPathToFrame(redAuto, 'blue');
    expect(blue.alliance).toBe('blue');
    expect(blue.start).toEqual({ x: 0.8, y: 0.7 });
    expect(blue.path).toEqual([{ x: 0.8, y: 0.7 }, { x: 0.6, y: 0.7 }]);
    // Label/match preserved.
    expect(blue.label).toBe('Q1');
  });

  it('returns the same routine unchanged when already on the target side', () => {
    expect(autoPathToFrame(redAuto, 'red')).toBe(redAuto);
  });
});
