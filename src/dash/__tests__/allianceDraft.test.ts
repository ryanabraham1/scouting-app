import { describe, expect, it } from 'vitest';
import { allianceGrid, firstOpenTurn, isSeated, pickableCaptains, setAllianceSeat } from '../allianceDraft';
import { EMPTY_DRAFT_STATE, toggleDeclined } from '../draftBoard';

// Ranks 1..10: team = 100 + rank (rank 1 = 101 ... rank 10 = 110).
const ranks = new Map<number, number>(Array.from({ length: 10 }, (_, i) => [101 + i, i + 1]));
const BASE = 3256; // not ranked top-8: we're not a captain

describe('alliance draft captain promotion', () => {
  it('moves alliances up when A1 picks the A2 captain', () => {
    const grid = allianceGrid(EMPTY_DRAFT_STATE, ranks, BASE);
    const next = setAllianceSeat(EMPTY_DRAFT_STATE, grid, 0, 1, 102, BASE, ranks);
    expect(next.alliances?.map((r) => r[0])).toEqual([101, 103, 104, 105, 106, 107, 108, 109]);
    expect(next.alliances?.[0]).toEqual([101, 102, null]);
    expect(next.alliances?.[1]).toEqual([103, null, null]);
  });

  it('promotes from the vacated row only, keeping alliances above intact', () => {
    let state = EMPTY_DRAFT_STATE;
    let grid = allianceGrid(state, ranks, BASE);
    state = setAllianceSeat(state, grid, 0, 1, 150, BASE, ranks); // A1 picks an unranked-top-8 team
    grid = allianceGrid(state, ranks, BASE);
    state = setAllianceSeat(state, grid, 1, 1, 105, BASE, ranks); // A2 picks the A5 captain
    expect(state.alliances?.map((r) => r[0])).toEqual([101, 102, 103, 104, 106, 107, 108, 109]);
    expect(state.alliances?.[1]).toEqual([102, 105, null]);
  });

  it('skips already-seated or crossed-off teams when filling the 8th captain', () => {
    const state = { ...EMPTY_DRAFT_STATE, taken: [109] };
    const grid = allianceGrid(state, ranks, BASE);
    const next = setAllianceSeat(state, grid, 0, 1, 102, BASE, ranks);
    expect(next.alliances?.[7]?.[0]).toBe(110);
  });

  it('does not promote when picking a non-captain or without ranks', () => {
    const grid = allianceGrid(EMPTY_DRAFT_STATE, ranks, BASE);
    const plain = setAllianceSeat(EMPTY_DRAFT_STATE, grid, 0, 1, 150, BASE, ranks);
    expect(plain.alliances?.map((r) => r[0])).toEqual([101, 102, 103, 104, 105, 106, 107, 108]);
    const noRanks = setAllianceSeat(EMPTY_DRAFT_STATE, grid, 0, 1, 102, BASE);
    expect(noRanks.alliances?.[1]?.[0]).toBeNull();
  });
});

describe('draft turn helpers', () => {
  it('finds the earliest open pick seat in snake order', () => {
    const grid = allianceGrid(EMPTY_DRAFT_STATE, ranks, BASE);
    expect(firstOpenTurn(grid)).toBe(0);
    for (let i = 0; i < 8; i++) grid[i][1] = 200 + i;
    expect(firstOpenTurn(grid)).toBe(8); // round 2 starts with alliance 8
    grid[3][1] = null;
    expect(firstOpenTurn(grid)).toBe(3);
    expect(isSeated(grid, 205)).toBe(true);
    expect(isSeated(grid, 203)).toBe(false);
  });
});

describe('FRC selection rules', () => {
  it('keeps captains who have not picked yet in the pick pool', () => {
    let state = EMPTY_DRAFT_STATE;
    let grid = allianceGrid(state, ranks, BASE);
    state = setAllianceSeat(state, grid, 0, 1, 150, BASE, ranks); // A1 picks a non-captain
    grid = allianceGrid(state, ranks, BASE);
    // A1 picked, so its captain is out; A2..A8 captains are still pickable.
    expect(state.taken).toContain(101);
    expect(state.taken).not.toContain(102);
    expect([...pickableCaptains(grid).keys()]).toEqual([102, 103, 104, 105, 106, 107, 108]);
    // A2 can pick the A3 captain; alliances below move up.
    state = setAllianceSeat(state, grid, 1, 1, 103, BASE, ranks);
    expect(state.alliances?.map((r) => r[0])).toEqual([101, 102, 104, 105, 106, 107, 108, 109]);
  });

  it('lets a team that declined still be promoted to captain', () => {
    const state = toggleDeclined(109, EMPTY_DRAFT_STATE);
    expect(state.declined).toEqual([109]);
    const grid = allianceGrid(state, ranks, BASE);
    const next = setAllianceSeat(state, grid, 0, 1, 102, BASE, ranks);
    expect(next.alliances?.[7]?.[0]).toBe(109);
    expect(toggleDeclined(109, state).declined).toEqual([]);
  });
});
