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

/**
 * FRC selection rule: when an alliance picks a LOWER alliance's captain, every
 * alliance below the vacated one moves up a row and the highest-ranked team
 * not already seated becomes the new 8th captain. Mutates `next`.
 */
function promoteCaptains(
  next: AllianceGrid,
  vacatedRow: number,
  ranks: ReadonlyMap<number, number>,
  unavailable: ReadonlySet<number>,
): void {
  next.splice(vacatedRow, 1);
  const seated = new Set(next.flat().filter((n): n is number => n != null));
  let captain: number | null = null;
  let best = Infinity;
  for (const [team, rank] of ranks) {
    if (rank >= 1 && rank < best && !seated.has(team) && !unavailable.has(team)) {
      best = rank;
      captain = team;
    }
  }
  next.push([captain, null, null]);
}

/**
 * A team occupies one seat; edits reconcile both availability buckets. Picking
 * a lower alliance's captain into a pick seat moves the alliances below up
 * (see promoteCaptains) when `ranks` are known.
 */
export function setAllianceSeat(
  state: DraftState,
  grid: AllianceGrid,
  row: number,
  seat: number,
  team: number | null,
  baseTeam: number,
  ranks?: ReadonlyMap<number, number>,
): DraftState {
  const next = grid.map(r => [...r]);
  const vacatedCaptainRow =
    team != null && seat > 0 ? grid.findIndex((r, i) => i > row && r[0] === team) : -1;
  if (team != null) for (const r of next) for (let s = 0; s < 3; s++) if (r[s] === team) r[s] = null;
  next[row][seat] = team;
  if (vacatedCaptainRow > row && ranks && ranks.size > 0) {
    // Teams already picked elsewhere can't be promoted to captain. A team that
    // DECLINED can (it only loses the right to be picked).
    promoteCaptains(next, vacatedCaptainRow, ranks, new Set(state.taken));
  }
  const ourRow = next.find(r => r.includes(baseTeam));
  const ours = ourRow?.slice(1).filter((n): n is number => n != null && n !== baseTeam) ?? [];
  const captain = ourRow?.[0];
  const removed = new Set(grid.flat().filter((n): n is number => n != null));
  const taken = new Set(state.taken.filter(n => !removed.has(n)));
  // A captain whose alliance hasn't picked yet is still pickable by a higher
  // alliance, so it stays in the pool; every other seated team is out.
  for (const r of next) {
    if (r === ourRow || (r[1] == null && r[2] == null)) continue;
    for (const n of r) if (n != null && n !== baseTeam) taken.add(n);
  }
  return { ...state, alliances: next, ours, taken: [...taken], pickedBy: captain != null && captain !== baseTeam ? captain : null };
}

/** Pick slot `turn` fills: round 1 fills seat 1, round 2 (snake) fills seat 2. */
export function turnSeat(turn: number): { row: number; seat: number } | null {
  return turn >= 0 && turn < DRAFT_ORDER.length ? { row: DRAFT_ORDER[turn], seat: turn < 8 ? 1 : 2 } : null;
}

/** First pick slot in draft order whose seat is still empty (16 = selection complete). */
export function firstOpenTurn(grid: AllianceGrid): number {
  for (let t = 0; t < DRAFT_ORDER.length; t++) {
    const slot = turnSeat(t)!;
    if (grid[slot.row]?.[slot.seat] == null) return t;
  }
  return DRAFT_ORDER.length;
}

/** True when `team` sits in any alliance seat. */
export function isSeated(grid: AllianceGrid, team: number): boolean {
  return grid.some(row => row.includes(team));
}

/**
 * Captains whose alliance hasn't made a pick yet. Under FRC rules a higher
 * alliance may still pick them (the alliances below then move up).
 */
export function pickableCaptains(grid: AllianceGrid): Map<number, number> {
  const out = new Map<number, number>();
  grid.forEach((row, i) => {
    if (row[0] != null && row[1] == null && row[2] == null) out.set(row[0], i);
  });
  return out;
}
