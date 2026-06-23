// src/scoring/windows.ts
import type { MatchWindow } from './types';

// Teleop ms from teleop start. Auto [0,20000) handled separately.
export const SHIFT_BOUNDS: Record<
  'shift1' | 'shift2' | 'shift3' | 'shift4' | 'transition' | 'endgame',
  { start: number; end: number }
> = {
  transition: { start: 0, end: 10000 },
  shift1: { start: 10000, end: 35000 },
  shift2: { start: 35000, end: 60000 },
  shift3: { start: 60000, end: 85000 },
  shift4: { start: 85000, end: 110000 },
  endgame: { start: 110000, end: 140000 },
};

export function isInactive(shiftNumber: 1 | 2 | 3 | 4, inactiveFirst: boolean): boolean {
  return ((shiftNumber % 2) === 1) === inactiveFirst;
}

export function shiftNumberOf(window: MatchWindow): 1 | 2 | 3 | 4 | null {
  switch (window) {
    case 'shift1':
      return 1;
    case 'shift2':
      return 2;
    case 'shift3':
      return 3;
    case 'shift4':
      return 4;
    default:
      return null;
  }
}

export function isWindowActive(window: MatchWindow, inactiveFirst: boolean): boolean {
  const n = shiftNumberOf(window);
  if (n === null) return true; // auto / transition / endgame are always active
  return !isInactive(n, inactiveFirst);
}
