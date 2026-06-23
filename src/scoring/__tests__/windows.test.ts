// src/scoring/__tests__/windows.test.ts
import { describe, it, expect } from 'vitest';
import {
  SHIFT_BOUNDS,
  isInactive,
  isWindowActive,
  shiftNumberOf,
} from '../windows';

describe('isInactive — 8 parity cases (shiftNumber × inactiveFirst)', () => {
  // Rule: ((shiftNumber % 2) === 1) === inactiveFirst
  // inactiveFirst = true  -> odd shifts (1,3) inactive; even shifts (2,4) active
  // inactiveFirst = false -> even shifts (2,4) inactive; odd shifts (1,3) active
  const cases: Array<{ shift: 1 | 2 | 3 | 4; inactiveFirst: boolean; expected: boolean }> = [
    { shift: 1, inactiveFirst: true, expected: true },
    { shift: 2, inactiveFirst: true, expected: false },
    { shift: 3, inactiveFirst: true, expected: true },
    { shift: 4, inactiveFirst: true, expected: false },
    { shift: 1, inactiveFirst: false, expected: false },
    { shift: 2, inactiveFirst: false, expected: true },
    { shift: 3, inactiveFirst: false, expected: false },
    { shift: 4, inactiveFirst: false, expected: true },
  ];

  for (const c of cases) {
    it(`shift ${c.shift}, inactiveFirst=${c.inactiveFirst} -> ${c.expected}`, () => {
      expect(isInactive(c.shift, c.inactiveFirst)).toBe(c.expected);
    });
  }
});

describe('isWindowActive — always-active phases', () => {
  for (const inactiveFirst of [true, false]) {
    it(`auto is always active (inactiveFirst=${inactiveFirst})`, () => {
      expect(isWindowActive('auto', inactiveFirst)).toBe(true);
    });
    it(`transition is always active (inactiveFirst=${inactiveFirst})`, () => {
      expect(isWindowActive('transition', inactiveFirst)).toBe(true);
    });
    it(`endgame is always active (inactiveFirst=${inactiveFirst})`, () => {
      expect(isWindowActive('endgame', inactiveFirst)).toBe(true);
    });
  }

  it('shift windows mirror !isInactive', () => {
    // inactiveFirst=true: shift1 inactive -> not active
    expect(isWindowActive('shift1', true)).toBe(false);
    expect(isWindowActive('shift2', true)).toBe(true);
    expect(isWindowActive('shift3', true)).toBe(false);
    expect(isWindowActive('shift4', true)).toBe(true);
    // inactiveFirst=false: shift1 active
    expect(isWindowActive('shift1', false)).toBe(true);
    expect(isWindowActive('shift2', false)).toBe(false);
    expect(isWindowActive('shift3', false)).toBe(true);
    expect(isWindowActive('shift4', false)).toBe(false);
  });
});

describe('shiftNumberOf', () => {
  it('maps shift windows to their number', () => {
    expect(shiftNumberOf('shift1')).toBe(1);
    expect(shiftNumberOf('shift2')).toBe(2);
    expect(shiftNumberOf('shift3')).toBe(3);
    expect(shiftNumberOf('shift4')).toBe(4);
  });
  it('returns null for non-shift windows', () => {
    expect(shiftNumberOf('auto')).toBeNull();
    expect(shiftNumberOf('transition')).toBeNull();
    expect(shiftNumberOf('endgame')).toBeNull();
  });
});

describe('SHIFT_BOUNDS — frozen teleop boundaries (ms from teleop start)', () => {
  it('matches the frozen window table', () => {
    expect(SHIFT_BOUNDS.transition).toEqual({ start: 0, end: 10000 });
    expect(SHIFT_BOUNDS.shift1).toEqual({ start: 10000, end: 35000 });
    expect(SHIFT_BOUNDS.shift2).toEqual({ start: 35000, end: 60000 });
    expect(SHIFT_BOUNDS.shift3).toEqual({ start: 60000, end: 85000 });
    expect(SHIFT_BOUNDS.shift4).toEqual({ start: 85000, end: 110000 });
    expect(SHIFT_BOUNDS.endgame).toEqual({ start: 110000, end: 140000 });
  });
});
