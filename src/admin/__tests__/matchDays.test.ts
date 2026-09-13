import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applyDaysOff, loadDaysOff, matchDayKey, matchDays, saveDaysOff } from '../matchDays';
import type { AssignMatch, AssignScout } from '../types';

// The jsdom-compat env ships a non-functional localStorage; install a minimal
// in-memory polyfill so the real persistence logic is exercised.
beforeAll(() => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
});

// Noon local on each day so the bucket is unambiguous regardless of test tz.
const sat = new Date(2026, 2, 14, 12, 0).toISOString();
const sun = new Date(2026, 2, 15, 12, 0).toISOString();

const MATCHES: AssignMatch[] = [
  { matchKey: 'e_qm1', redTeams: [1, 2, 3], blueTeams: [4, 5, 6], scheduledTime: sat },
  { matchKey: 'e_qm2', redTeams: [1, 2, 3], blueTeams: [4, 5, 6], scheduledTime: sat },
  { matchKey: 'e_qm3', redTeams: [1, 2, 3], blueTeams: [4, 5, 6], scheduledTime: sun },
  { matchKey: 'e_qm4', redTeams: [1, 2, 3], blueTeams: [4, 5, 6], scheduledTime: null },
];

describe('matchDays', () => {
  it('buckets matches by local calendar day in schedule order', () => {
    const days = matchDays(MATCHES, 'en-US');
    expect(days.map((d) => d.weekday)).toEqual(['Saturday', 'Sunday']);
    expect(days[0].matchKeys).toEqual(['e_qm1', 'e_qm2']);
    expect(days[1].matchKeys).toEqual(['e_qm3']);
    expect(days[0].date).toBe('Mar 14');
  });

  it('skips matches with no usable time', () => {
    expect(matchDayKey(null)).toBeNull();
    expect(matchDayKey('garbage')).toBeNull();
    expect(matchDays([MATCHES[3]])).toEqual([]);
  });
});

describe('applyDaysOff', () => {
  const scouts: AssignScout[] = [
    { id: 'a', displayName: 'A' },
    { id: 'b', displayName: 'B', unavailableMatchKeys: ['e_qm1'] },
  ];
  const days = matchDays(MATCHES);

  it('expands a day off into that day\'s match keys, merging existing exclusions', () => {
    const out = applyDaysOff(scouts, days, { a: [days[1].key], b: [days[0].key] });
    expect(out[0].unavailableMatchKeys).toEqual(['e_qm3']);
    expect(new Set(out[1].unavailableMatchKeys)).toEqual(new Set(['e_qm1', 'e_qm2']));
  });

  it('returns the same scout object when nothing is excluded', () => {
    const out = applyDaysOff(scouts, days, {});
    expect(out[0]).toBe(scouts[0]);
    expect(out[1]).toBe(scouts[1]);
  });
});

describe('days-off persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips per event and drops empty entries', () => {
    saveDaysOff('e1', { a: ['2026-03-15'], b: [] });
    expect(loadDaysOff('e1')).toEqual({ a: ['2026-03-15'] });
    expect(loadDaysOff('e2')).toEqual({});
    saveDaysOff('e1', { a: [] });
    expect(loadDaysOff('e1')).toEqual({});
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem('assignment_days_off:e1', '[1,2');
    expect(loadDaysOff('e1')).toEqual({});
  });
});
