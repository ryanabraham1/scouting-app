// src/dash/__tests__/draftBoard.test.ts
// Unit tests for the draft-board pure helpers: status transitions (single-bucket
// invariant), toggle, best-remaining (skips taken/ours/DNP), and localStorage
// round-trip with corrupt-data guards.

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  statusOf,
  setStatus,
  toggleStatus,
  bestRemaining,
  compareDraftOrder,
  loadDraftState,
  saveDraftState,
  draftStorageKey,
  firstPickDone,
  draftActiveList,
  withAutoListSwitch,
  EMPTY_DRAFT_STATE,
  type DraftRow,
  type DraftState,
} from '@/dash/draftBoard';

// The jsdom-compat env ships a non-functional localStorage; install a minimal
// in-memory polyfill so the persistence round-trip is exercised (mirrors
// RankingView.test.tsx).
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

describe('status transitions', () => {
  it('defaults to available', () => {
    expect(statusOf(254, EMPTY_DRAFT_STATE)).toBe('available');
  });

  it('setStatus keeps a team in exactly one bucket', () => {
    let s: DraftState = EMPTY_DRAFT_STATE;
    s = setStatus(254, 'ours', s);
    expect(statusOf(254, s)).toBe('ours');
    // Re-assigning to taken removes it from ours (no double-bucket).
    s = setStatus(254, 'taken', s);
    expect(statusOf(254, s)).toBe('taken');
    expect(s.ours).not.toContain(254);
    expect(s.taken).toContain(254);
    // Back to available clears both.
    s = setStatus(254, 'available', s);
    expect(statusOf(254, s)).toBe('available');
    expect(s.ours).toHaveLength(0);
    expect(s.taken).toHaveLength(0);
  });

  it('toggleStatus flips a team on/off the target bucket', () => {
    let s: DraftState = EMPTY_DRAFT_STATE;
    s = toggleStatus(1678, 'taken', s);
    expect(statusOf(1678, s)).toBe('taken');
    s = toggleStatus(1678, 'taken', s);
    expect(statusOf(1678, s)).toBe('available');
  });

  it('does not mutate the input state', () => {
    const s = EMPTY_DRAFT_STATE;
    setStatus(9, 'ours', s);
    expect(s.ours).toHaveLength(0);
  });
});

function draftRow(overrides: Partial<DraftRow>): DraftRow {
  return {
    teamNumber: 1,
    nickname: null,
    epa: 0,
    expectedPoints: 0,
    climbSuccessRate: 0,
    matchesScouted: 0,
    dnp: false,
    tier: null,
    note: null,
    picklistRank: null,
    onOtherList: false,
    tbaRank: null,
    blockedByRank: false,
    blockedTop8: false,
    isUs: false,
    status: 'available',
    ...overrides,
  };
}

describe('bestRemaining', () => {
  it('returns top-N available, non-DNP rows in input order', () => {
    const rows = [
      draftRow({ teamNumber: 1, status: 'taken' }), // crossed off
      draftRow({ teamNumber: 2 }), // best available
      draftRow({ teamNumber: 3, dnp: true }), // skipped (do not pick)
      draftRow({ teamNumber: 4, status: 'ours' }), // already ours
      draftRow({ teamNumber: 5 }), // next available
      draftRow({ teamNumber: 6 }),
    ];
    const best = bestRemaining(rows, 2);
    expect(best.map((r) => r.teamNumber)).toEqual([2, 5]);
  });

  it('skips teams ranked above us (blockedByRank)', () => {
    const rows = [
      draftRow({ teamNumber: 1, blockedByRank: true }), // ranked above us — can't pick
      draftRow({ teamNumber: 2 }),
    ];
    expect(bestRemaining(rows).map((r) => r.teamNumber)).toEqual([2]);
  });

  it('never recommends our own team (isUs)', () => {
    const rows = [draftRow({ teamNumber: 3256, isUs: true }), draftRow({ teamNumber: 2 })];
    expect(bestRemaining(rows).map((r) => r.teamNumber)).toEqual([2]);
  });

  it('skips top-8 seeds once we have picked (blockedTop8)', () => {
    const rows = [
      draftRow({ teamNumber: 1, blockedTop8: true }), // top-8, gone by our 2nd pick
      draftRow({ teamNumber: 2 }),
    ];
    expect(bestRemaining(rows).map((r) => r.teamNumber)).toEqual([2]);
  });

  it('returns [] when nothing is available', () => {
    const rows = [draftRow({ teamNumber: 1, status: 'taken' })];
    expect(bestRemaining(rows)).toEqual([]);
  });
});

describe('compareDraftOrder', () => {
  it('orders picklisted teams (by picklist position) above non-picklisted', () => {
    const rows = [
      draftRow({ teamNumber: 10, epa: 999, picklistRank: null }), // huge EPA, not on list
      draftRow({ teamNumber: 20, epa: 1, picklistRank: 1 }), // 2nd on picklist
      draftRow({ teamNumber: 30, epa: 1, picklistRank: 0 }), // 1st on picklist
    ];
    const order = rows.slice().sort(compareDraftOrder).map((r) => r.teamNumber);
    expect(order).toEqual([30, 20, 10]);
  });

  it('falls back to EPA desc among non-picklisted teams', () => {
    const rows = [
      draftRow({ teamNumber: 10, epa: 50 }),
      draftRow({ teamNumber: 20, epa: 90 }),
      draftRow({ teamNumber: 30, epa: null }), // unknown EPA sinks to the bottom
    ];
    const order = rows.slice().sort(compareDraftOrder).map((r) => r.teamNumber);
    expect(order).toEqual([20, 10, 30]);
  });
});

describe('active list auto-switch (1st pick → 2nd pick)', () => {
  it('defaults to the 1st-pick list', () => {
    expect(draftActiveList(EMPTY_DRAFT_STATE)).toBe('first');
  });

  it('firstPickDone is true once we picked OR got picked', () => {
    expect(firstPickDone(EMPTY_DRAFT_STATE)).toBe(false);
    expect(firstPickDone({ ours: [254], taken: [] })).toBe(true);
    expect(firstPickDone({ ours: [], taken: [], pickedBy: 1678 })).toBe(true);
    expect(firstPickDone({ ours: [], taken: [], pickedBy: null })).toBe(false);
  });

  it('auto-switches to the 2nd-pick list when our first pick lands', () => {
    const prev: DraftState = { ours: [], taken: [] };
    const next = withAutoListSwitch(prev, setStatus(254, 'ours', prev));
    expect(draftActiveList(next)).toBe('second');
  });

  it('auto-switches when we GET picked (pickedBy set)', () => {
    const prev: DraftState = { ours: [], taken: [] };
    const next = withAutoListSwitch(prev, { ...prev, pickedBy: 1678 });
    expect(draftActiveList(next)).toBe('second');
  });

  it('switches back to the 1st-pick list when the first pick is undone', () => {
    const prev: DraftState = { ours: [254], taken: [], activeList: 'second' };
    const next = withAutoListSwitch(prev, setStatus(254, 'available', prev));
    expect(draftActiveList(next)).toBe('first');
  });

  it('a manual switch sticks across non-boundary updates', () => {
    // First pick already made, lead manually flipped back to the 1st list…
    const prev: DraftState = { ours: [254], taken: [], activeList: 'first' };
    // …then crosses off another team: no boundary crossing → manual choice kept.
    const next = withAutoListSwitch(prev, setStatus(999, 'taken', prev));
    expect(draftActiveList(next)).toBe('first');
  });

  it('marking a SECOND pick does not flip the list again', () => {
    const prev: DraftState = { ours: [254], taken: [], activeList: 'second' };
    const next = withAutoListSwitch(prev, setStatus(1678, 'ours', prev));
    expect(draftActiveList(next)).toBe('second');
  });
});

describe('localStorage round-trip', () => {
  const EVENT = '2026test';
  beforeEach(() => window.localStorage.clear());

  it('saves and loads', () => {
    const s: DraftState = { ours: [254], taken: [1678, 118] };
    saveDraftState(EVENT, s);
    expect(loadDraftState(EVENT)).toEqual(s);
  });

  it('round-trips activeList and drops invalid values', () => {
    const s: DraftState = { ours: [], taken: [], activeList: 'second' };
    saveDraftState(EVENT, s);
    expect(loadDraftState(EVENT).activeList).toBe('second');

    window.localStorage.setItem(
      draftStorageKey(EVENT),
      JSON.stringify({ ours: [], taken: [], activeList: 'third' }),
    );
    expect(loadDraftState(EVENT).activeList).toBeUndefined();
  });

  it('returns empty on missing key', () => {
    expect(loadDraftState(EVENT)).toEqual(EMPTY_DRAFT_STATE);
  });

  it('guards corrupt JSON', () => {
    window.localStorage.setItem(draftStorageKey(EVENT), '{not json');
    expect(loadDraftState(EVENT)).toEqual(EMPTY_DRAFT_STATE);
  });

  it('filters non-number entries', () => {
    window.localStorage.setItem(
      draftStorageKey(EVENT),
      JSON.stringify({ ours: [254, 'x', null], taken: 'nope' }),
    );
    expect(loadDraftState(EVENT)).toEqual({ ours: [254], taken: [] });
  });
});
