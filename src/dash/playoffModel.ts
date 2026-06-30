// src/dash/playoffModel.ts
// The FRC 8-alliance double-elimination bracket as data: every semifinal set's two
// feeds (which alliance seed or which earlier match's winner/loser plays there) and,
// derived from those feeds, where the WINNER advances and where the LOSER drops.
// Pure — no React, no I/O — so the "our path" panel can answer "if we win we go to
// M11, if we lose we drop to M9, and our opponent is the winner of M8" without
// hard-coding the tree in the view. (FRC 2023+ double elim; only rosters change.)

import type { MatchRow } from '@/dash/useEventData';

export type Feed =
  | { kind: 'seed'; n: number }
  | { kind: 'winner'; set: number }
  | { kind: 'loser'; set: number };

const seed = (n: number): Feed => ({ kind: 'seed', n });
const win = (set: number): Feed => ({ kind: 'winner', set });
const lose = (set: number): Feed => ({ kind: 'loser', set });

export interface PlayoffSlot {
  set: number;
  tag: string; // "M7"
  round: string; // human round label
  bracket: 'upper' | 'lower';
  top: Feed;
  bottom: Feed;
}

/** The 13 semifinal sets, in play order. Finals (best-of-3) are handled apart. */
export const SLOTS: PlayoffSlot[] = [
  { set: 1, tag: 'M1', round: 'Upper Round 1', bracket: 'upper', top: seed(1), bottom: seed(8) },
  { set: 2, tag: 'M2', round: 'Upper Round 1', bracket: 'upper', top: seed(4), bottom: seed(5) },
  { set: 3, tag: 'M3', round: 'Upper Round 1', bracket: 'upper', top: seed(2), bottom: seed(7) },
  { set: 4, tag: 'M4', round: 'Upper Round 1', bracket: 'upper', top: seed(3), bottom: seed(6) },
  { set: 5, tag: 'M5', round: 'Lower Round 1', bracket: 'lower', top: lose(1), bottom: lose(2) },
  { set: 6, tag: 'M6', round: 'Lower Round 1', bracket: 'lower', top: lose(3), bottom: lose(4) },
  { set: 7, tag: 'M7', round: 'Upper Round 2', bracket: 'upper', top: win(1), bottom: win(2) },
  { set: 8, tag: 'M8', round: 'Upper Round 2', bracket: 'upper', top: win(3), bottom: win(4) },
  { set: 9, tag: 'M9', round: 'Lower Round 2', bracket: 'lower', top: win(6), bottom: lose(7) },
  { set: 10, tag: 'M10', round: 'Lower Round 2', bracket: 'lower', top: win(5), bottom: lose(8) },
  { set: 11, tag: 'M11', round: 'Upper Final', bracket: 'upper', top: win(7), bottom: win(8) },
  { set: 12, tag: 'M12', round: 'Lower Round 3', bracket: 'lower', top: win(9), bottom: win(10) },
  { set: 13, tag: 'M13', round: 'Lower Final', bracket: 'lower', top: lose(11), bottom: win(12) },
];

/** The finalists: winner of the upper final (M11) vs winner of the lower final (M13). */
export const FINALS_FEEDS = { red: win(11), blue: win(13) } as const;

const SLOT_BY_SET = new Map(SLOTS.map((s) => [s.set, s]));

export function slotForSet(set: number): PlayoffSlot | undefined {
  return SLOT_BY_SET.get(set);
}

export function feedLabel(f: Feed): string {
  if (f.kind === 'seed') return `Alliance ${f.n}`;
  return `${f.kind === 'winner' ? 'Winner' : 'Loser'} of M${f.set}`;
}

function feedEq(a: Feed, b: Feed): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'seed' ? a.n === (b as { n: number }).n : a.set === (b as { set: number }).set;
}

/** Where a feed leads: the slot that consumes it (and the OTHER side of that slot). */
function slotConsuming(target: Feed): { slot: PlayoffSlot; opponent: Feed } | null {
  for (const s of SLOTS) {
    if (feedEq(s.top, target)) return { slot: s, opponent: s.bottom };
    if (feedEq(s.bottom, target)) return { slot: s, opponent: s.top };
  }
  return null;
}

export type Destination =
  | { kind: 'set'; slot: PlayoffSlot; opponent: Feed }
  | { kind: 'finals'; opponent: Feed }
  | { kind: 'champion' }
  | { kind: 'eliminated' };

/** Where the WINNER of `set` goes next, and who they'd face there. */
export function winDestination(set: number): Destination {
  // Both finals feeds come from winning M11 / M13.
  if (set === 11) return { kind: 'finals', opponent: FINALS_FEEDS.blue };
  if (set === 13) return { kind: 'finals', opponent: FINALS_FEEDS.red };
  const next = slotConsuming(win(set));
  if (!next) return { kind: 'champion' };
  return { kind: 'set', slot: next.slot, opponent: next.opponent };
}

/** Where the LOSER of `set` goes next (or out of the tournament). */
export function loseDestination(set: number): Destination {
  const next = slotConsuming(lose(set));
  if (!next) return { kind: 'eliminated' };
  return { kind: 'set', slot: next.slot, opponent: next.opponent };
}

// ── Schedule helpers ──────────────────────────────────────────────────────────
export function redTeams(m: MatchRow): number[] {
  return [m.red1, m.red2, m.red3].filter((t): t is number => t != null);
}
export function blueTeams(m: MatchRow): number[] {
  return [m.blue1, m.blue2, m.blue3].filter((t): t is number => t != null);
}
export function isPlayed(m: MatchRow): boolean {
  return m.actual_red_score != null || m.actual_blue_score != null;
}

/** Semifinal SET number from a key tail like "sf3m1" (falls back to match_number). */
export function sfSet(m: MatchRow): number | null {
  const tail = m.match_key.split('_').pop() ?? '';
  const hit = /^sf(\d+)m\d+$/i.exec(tail) ?? /^sf(\d+)$/i.exec(tail);
  return hit ? Number(hit[1]) : m.comp_level.toLowerCase() === 'sf' ? m.match_number : null;
}

/**
 * Resolve a winner/loser feed to the actual teams once that match has a result;
 * `null` while it's undetermined (so the caller shows "Winner of M8" instead).
 */
export function resolveFeedTeams(feed: Feed, bySet: Map<number, MatchRow>): number[] | null {
  if (feed.kind === 'seed') return null;
  const row = bySet.get(feed.set);
  if (!row || (row.winner !== 'red' && row.winner !== 'blue')) return null;
  const winners = row.winner === 'red' ? redTeams(row) : blueTeams(row);
  const losers = row.winner === 'red' ? blueTeams(row) : redTeams(row);
  return feed.kind === 'winner' ? winners : losers;
}
