// src/dash/matchOrder.ts
// Shared match-list helpers for the Pit Display and Strategy tabs: alliance
// team extraction, play-order sorting, and the match-selector option label.
// Split out of NextMatchView when the selector moved to the Strategy tab so
// both screens keep ONE definition of play order.

import type { MatchRow } from '@/dash/useEventData';
import { formatMatchKeyRaw, compareMatchKeys } from '@/lib/formatMatch';

export function redTeamsOf(m: MatchRow): number[] {
  return [m.red1, m.red2, m.red3].filter((t): t is number => t != null);
}
export function blueTeamsOf(m: MatchRow): number[] {
  return [m.blue1, m.blue2, m.blue3].filter((t): t is number => t != null);
}
export function isUnplayed(m: MatchRow): boolean {
  return m.actual_red_score == null && m.actual_blue_score == null;
}

/** Short HH:MM (local) for a scheduled_time ISO string, or null when absent. */
export function shortTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** PLAY order: comp level (qm→ef→qf→sf→f) then the set/game key tail — so
 *  double-elim playoff sets order correctly (sf1m1 < sf2m1), not tied at 1. */
const LEVEL_ORDER: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
export function byPlay(a: MatchRow, b: MatchRow): number {
  const la = LEVEL_ORDER[a.comp_level] ?? 9;
  const lb = LEVEL_ORDER[b.comp_level] ?? 9;
  return la !== lb ? la - lb : compareMatchKeys(a.match_key, b.match_key);
}
export function sortMatchesForSelect(matches: MatchRow[]): MatchRow[] {
  return matches.slice().sort(byPlay);
}

/** Friendly one-line label for a match in the selector. */
export function matchOptionLabel(m: MatchRow): string {
  // From the raw key, not comp_level+match_number: in double-elim every semifinal
  // shares match_number=1 (it's the game-within-set), so the latter labels them all
  // "Semi 1". The key tail (sf3m1) carries the distinguishing SET number.
  const name = formatMatchKeyRaw(m.match_key);
  const red = redTeamsOf(m).join('/') || '—';
  const blue = blueTeamsOf(m).join('/') || '—';
  const time = shortTime(m.scheduled_time);
  const played = !isUnplayed(m) ? ' · played' : '';
  return `${name} — R ${red} vs B ${blue}${time ? ` · ${time}` : ''}${played}`;
}
