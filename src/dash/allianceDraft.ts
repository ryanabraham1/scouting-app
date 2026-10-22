import type { DraftState } from './draftBoard';

export type AllianceGrid = (number | null)[][];
export const DRAFT_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0];

/** Seed captains only from official ranks; unknown seats stay visibly empty. */
export function allianceGrid(state: DraftState, ranks: ReadonlyMap<number, number>, baseTeam: number): AllianceGrid {
  const grid: AllianceGrid = Array.from({ length: 8 }, (_, i) => [...(state.alliances?.[i] ?? [null, null, null])]);
  if (!state.alliances) {
    for (const [team, rank] of ranks) if (rank >= 1 && rank <= 8) grid[rank - 1][0] = team;
    const captain = state.pickedBy ?? baseTeam;
    let ours = grid.findIndex(row => row[0] === captain);
    if (ours < 0 && !ranks.size) { ours = 0; grid[0][0] = captain; }
    if (ours >= 0) {
      const picks = state.pickedBy ? [baseTeam, ...state.ours] : state.ours;
      for (let i = 0; i < Math.min(2, picks.length); i++) grid[ours][i + 1] = picks[i];
    }
  }
  return grid;
}

/** A team occupies one seat; edits reconcile both availability buckets. */
export function setAllianceSeat(state: DraftState, grid: AllianceGrid, row: number, seat: number, team: number | null, baseTeam: number): DraftState {
  const next = grid.map(r => [...r]);
  if (team != null) for (const r of next) for (let s = 0; s < 3; s++) if (r[s] === team) r[s] = null;
  next[row][seat] = team;
  const ourRow = next.find(r => r.includes(baseTeam));
  const ours = ourRow?.slice(1).filter((n): n is number => n != null && n !== baseTeam) ?? [];
  const captain = ourRow?.[0];
  const removed = new Set(grid.flat().filter((n): n is number => n != null));
  const taken = new Set(state.taken.filter(n => !removed.has(n)));
  for (const r of next) if (r !== ourRow) for (const n of r) if (n != null && n !== baseTeam) taken.add(n);
  return { ...state, alliances: next, ours, taken: [...taken], pickedBy: captain != null && captain !== baseTeam ? captain : null };
}
