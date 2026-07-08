// src/dash/draftBoard.ts
// Live alliance-selection draft board — PURE state + helpers (no React, no I/O
// beyond localStorage). During the real-time alliance selection a lead crosses
// off teams as they're picked/declined and the board surfaces the best remaining
// pick from our ranking, respecting picklist "do not pick" flags.
//
// EPHEMERAL by design: the board state is a per-event scratchpad persisted to
// localStorage (survives a refresh during selection) — NOT a synced server
// table, so there is NO migration and NO wire-shape change. The ranking it reads
// is the same aggregate + best-available-EPA the Ranking tab uses.

import type { PicklistId } from '@/dash/picklistClient';

/**
 * A team's status during the draft:
 *  - `available` — not yet picked (in the pool).
 *  - `ours`      — we picked it onto our alliance.
 *  - `taken`     — picked by another alliance (crossed off, out of the pool).
 */
export type DraftStatus = 'available' | 'ours' | 'taken';

/** Persisted scratch state: the team numbers in each non-default bucket. */
export interface DraftState {
  ours: number[];
  taken: number[];
  /**
   * Set to the CAPTAIN team that picked US — when present, we joined another
   * alliance instead of building our own. Absent/undefined = we're the captain.
   */
  pickedBy?: number | null;
  /**
   * Which picklist drives the board's ranking: absent → the 1st-pick list.
   * Auto-flipped to `'second'` by `withAutoListSwitch` once our alliance's
   * first pick lands (we picked, or we got picked); manually switchable.
   */
  activeList?: PicklistId;
}

export const EMPTY_DRAFT_STATE: DraftState = { ours: [], taken: [] };

/** localStorage key for one event's draft scratchpad. */
export function draftStorageKey(eventKey: string): string {
  return `draft-board:${eventKey}`;
}

/** Resolve a team's status from the state (default `available`). */
export function statusOf(teamNumber: number, state: DraftState): DraftStatus {
  if (state.ours.includes(teamNumber)) return 'ours';
  if (state.taken.includes(teamNumber)) return 'taken';
  return 'available';
}

/**
 * Set a team to a status, returning a NEW state (immutable). Setting
 * `available` removes it from both buckets; `ours`/`taken` move it into exactly
 * one bucket (removing it from the other so a team is never in two buckets).
 */
export function setStatus(
  teamNumber: number,
  status: DraftStatus,
  state: DraftState,
): DraftState {
  const ours = state.ours.filter((t) => t !== teamNumber);
  const taken = state.taken.filter((t) => t !== teamNumber);
  if (status === 'ours') ours.push(teamNumber);
  else if (status === 'taken') taken.push(teamNumber);
  // Spread `state` first so `pickedBy` (and any future field) is preserved.
  return { ...state, ours, taken };
}

/**
 * Toggle helper for a one-tap control: if the team is already in `target`, clear
 * it back to available; otherwise set it to `target`. Pure.
 */
export function toggleStatus(
  teamNumber: number,
  target: Exclude<DraftStatus, 'available'>,
  state: DraftState,
): DraftState {
  const current = statusOf(teamNumber, state);
  return setStatus(teamNumber, current === target ? 'available' : target, state);
}

/**
 * True once our alliance's FIRST pick has happened: either we (as captain)
 * marked a pick ours, or another captain picked us. Either way the next pick
 * that matters is a second-round pick — the trigger for the list auto-switch.
 */
export function firstPickDone(state: DraftState): boolean {
  return state.ours.length >= 1 || (state.pickedBy ?? null) != null;
}

/** The picklist currently driving the board's ranking (default: 1st-pick list). */
export function draftActiveList(state: DraftState): PicklistId {
  return state.activeList ?? 'first';
}

/**
 * Apply the list AUTO-SWITCH to a state transition: when `next` crosses the
 * first-pick boundary (we picked / got picked — or that was undone), flip
 * `activeList` to the matching list. Any non-boundary update (including a
 * manual list switch) passes through untouched, so manual control always
 * sticks until the next boundary crossing. Pure.
 */
export function withAutoListSwitch(prev: DraftState, next: DraftState): DraftState {
  const before = firstPickDone(prev);
  const after = firstPickDone(next);
  if (before === after) return next;
  return { ...next, activeList: after ? 'second' : 'first' };
}

/** Load a draft scratch state from localStorage (defaults to empty; SSR-safe). */
export function loadDraftState(eventKey: string): DraftState {
  if (typeof window === 'undefined') return { ...EMPTY_DRAFT_STATE };
  try {
    const raw = window.localStorage.getItem(draftStorageKey(eventKey));
    if (!raw) return { ...EMPTY_DRAFT_STATE };
    const parsed = JSON.parse(raw) as Partial<DraftState>;
    const nums = (xs: unknown): number[] =>
      Array.isArray(xs) ? xs.filter((n): n is number => typeof n === 'number') : [];
    const out: DraftState = { ours: nums(parsed.ours), taken: nums(parsed.taken) };
    // Only keep a real captain number; absent/null stays omitted (we're captain).
    if (typeof parsed.pickedBy === 'number') out.pickedBy = parsed.pickedBy;
    // Only keep a valid list id; anything else falls back to the default (first).
    if (parsed.activeList === 'first' || parsed.activeList === 'second') {
      out.activeList = parsed.activeList;
    }
    return out;
  } catch {
    return { ...EMPTY_DRAFT_STATE };
  }
}

/** Persist a draft scratch state; swallow quota/serialization errors. */
export function saveDraftState(eventKey: string, state: DraftState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(draftStorageKey(eventKey), JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

/** A ranked, draft-annotated team row consumed by the board UI. */
export interface DraftRow {
  teamNumber: number;
  nickname: string | null;
  /** Best-available EPA (Statbotics → local → in-house), null when unknown. */
  epa: number | null;
  expectedPoints: number;
  climbSuccessRate: number;
  matchesScouted: number;
  /** picklist "do not pick" flag (best-remaining skips these). */
  dnp: boolean;
  /** free-text picklist tier note. */
  tier: string | null;
  /** the picklist note saved for this team (shown for the best remaining picks). */
  note: string | null;
  /**
   * 0-based position on the ACTIVE picklist (1st- or 2nd-pick, per
   * `DraftState.activeList`); null when not on that list.
   */
  picklistRank: number | null;
  /** True when the team is picklisted but on the INACTIVE list (badge only). */
  onOtherList: boolean;
  /** official event rank from TBA; null when unknown. */
  tbaRank: number | null;
  /**
   * True when this team is ranked ABOVE us at the event (better TBA rank) — we
   * can't pick it in alliance selection, so best-remaining skips it. Computed by
   * the caller (it needs OUR rank); false when ranks are unknown.
   */
  blockedByRank: boolean;
  /**
   * True once we've made our first pick: a top-8-ranked team is unavailable for
   * our SECOND pick (it's a captain, or a higher captain will take it first).
   * Computed by the caller (needs rank + pick count); best-remaining skips it.
   */
  blockedTop8: boolean;
  /** True for OUR OWN team — we're the captain, so we never "pick" ourselves. */
  isUs: boolean;
  status: DraftStatus;
}

/**
 * Draft pick ordering (pure comparator): OUR PICKLIST FIRST (in picklist order),
 * then everyone else by best-available EPA descending. Team number breaks ties.
 * This is the order the board ranks the pool + draws "best remaining" from, so a
 * lead's hand-built picklist drives the recommendation and EPA only fills in
 * below it (or entirely, when there's no picklist).
 */
export function compareDraftOrder(a: DraftRow, b: DraftRow): number {
  const aOnList = a.picklistRank != null;
  const bOnList = b.picklistRank != null;
  // Picklisted teams sort above non-picklisted ones.
  if (aOnList !== bOnList) return aOnList ? -1 : 1;
  // Both on the picklist → by picklist position.
  if (aOnList && bOnList) {
    if (a.picklistRank !== b.picklistRank) return (a.picklistRank as number) - (b.picklistRank as number);
    return a.teamNumber - b.teamNumber;
  }
  // Neither on the picklist → by EPA desc (unknown EPA sinks to the bottom).
  const ae = a.epa ?? Number.NEGATIVE_INFINITY;
  const be = b.epa ?? Number.NEGATIVE_INFINITY;
  if (ae !== be) return be - ae;
  return a.teamNumber - b.teamNumber;
}

/**
 * The best remaining picks from an ALREADY-SORTED (draft-order) row list: the top
 * `n` rows still available, NOT flagged do-not-pick, and NOT ranked above us
 * (blockedByRank). Pure.
 */
export function bestRemaining(sortedRows: DraftRow[], n = 3): DraftRow[] {
  const out: DraftRow[] = [];
  for (const r of sortedRows) {
    if (r.status !== 'available') continue;
    if (r.dnp) continue;
    if (r.blockedByRank) continue;
    if (r.blockedTop8) continue; // top-8 team, gone by our 2nd pick
    if (r.isUs) continue; // we're the captain — never recommend picking ourselves
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}
