// src/dash/nextMatch.ts
// Pure selectors for "OUR next match" — the match the Next-Match view tracks.
//
// Two sources, in priority order:
//   1. Nexus live status (when available) — the field is actively queuing/playing
//      matches, so Nexus' notion of our next not-yet-completed match is the truth.
//   2. The schedule — the earliest unplayed match (by comp level then number) whose
//      alliances include our base team. This is the offline/no-Nexus fallback.
//
// Everything here is pure + injectable so the tracking behavior is unit-testable
// without rendering the view or hitting the network.

import type { MatchRow } from '@/dash/useEventData';
import type { NexusEventStatus, NexusMatch } from '@/dash/nexusClient';
import { compareMatchKeys } from '@/lib/formatMatch';

/** Selector order for "earliest" match: qm → ef → qf → sf → f, then number. */
const LEVEL_ORDER: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };

function levelRank(compLevel: string): number {
  return LEVEL_ORDER[compLevel] ?? 9;
}

function redTeamsOf(m: MatchRow): number[] {
  return [m.red1, m.red2, m.red3].filter((t): t is number => t != null);
}
function blueTeamsOf(m: MatchRow): number[] {
  return [m.blue1, m.blue2, m.blue3].filter((t): t is number => t != null);
}

/** A match is "unplayed" when it has no actual score and no winner / synced result. */
export function isUnplayedMatch(m: MatchRow): boolean {
  return (
    m.actual_red_score == null &&
    m.actual_blue_score == null &&
    m.winner == null &&
    m.result_synced_at == null
  );
}

function includesTeam(m: MatchRow, team: number): boolean {
  return redTeamsOf(m).includes(team) || blueTeamsOf(m).includes(team);
}

/**
 * OUR next match from the SCHEDULE: the earliest unplayed match (by comp level
 * then match number) whose alliances include `teamNumber`. Returns null when the
 * team has no scheduled unplayed match. Pure — no Nexus, no network.
 */
/**
 * Compare two MatchRows in PLAY order: comp level (qm→ef→qf→sf→f) then the
 * "<level><set>m<game>" key tail. compareMatchKeys orders double-elim playoff
 * sets correctly (sf1m1 < sf2m1 …), where a bare match_number sort would tie
 * every semifinal at 1.
 */
function byPlayOrder(a: MatchRow, b: MatchRow): number {
  const lr = levelRank(a.comp_level) - levelRank(b.comp_level);
  return lr !== 0 ? lr : compareMatchKeys(a.match_key, b.match_key);
}

export function nextMatchForTeam(matches: MatchRow[], teamNumber: number): MatchRow | null {
  const ordered = matches
    .filter((m) => isUnplayedMatch(m) && includesTeam(m, teamNumber))
    .sort(byPlayOrder);
  return ordered[0] ?? null;
}

/**
 * OUR most recent match by play order (last one we're in). Used when the event
 * has no unplayed match left for us — the dashboard shows our last match instead
 * of an empty state. Returns null when the team has no matches.
 */
export function lastMatchForTeam(matches: MatchRow[], teamNumber: number): MatchRow | null {
  const ours = matches.filter((m) => includesTeam(m, teamNumber)).sort(byPlayOrder);
  return ours.length ? ours[ours.length - 1] : null;
}

/** The event's last match by play order (any team) — final fallback when our team has none. */
export function lastMatchOverall(matches: MatchRow[]): MatchRow | null {
  if (matches.length === 0) return null;
  return matches.slice().sort(byPlayOrder)[matches.length - 1];
}

/** Does a Nexus match include `teamNumber` on either alliance? */
function nexusIncludesTeam(nm: NexusMatch, teamNumber: number): boolean {
  return nm.redTeams.includes(teamNumber) || nm.blueTeams.includes(teamNumber);
}

type LabelKind = 'qual' | 'ef' | 'qf' | 'sf' | 'final' | 'playoff' | 'practice' | 'other';

/**
 * Classify a Nexus match label into a (kind, number). Nexus uses "Qualification N",
 * "Quarterfinal N", "Semifinal N", "Final N", "Playoff N" (double-elim bracket
 * position), or "Practice N". The trailing number means the qual number, the
 * playoff SET/bracket position, or the final GAME number depending on kind.
 */
function parseNexusLabel(label: string): { kind: LabelKind; num: number } | null {
  const s = (label ?? '').trim().toLowerCase();
  const tail = s.match(/(\d+)\s*$/);
  if (!tail) return null;
  const num = Number(tail[1]);
  if (!Number.isFinite(num)) return null;
  let kind: LabelKind;
  if (s.startsWith('practice')) kind = 'practice';
  else if (s.startsWith('quarter') || s.startsWith('qf')) kind = 'qf';
  else if (s.startsWith('semi') || s.startsWith('sf')) kind = 'sf';
  else if (s.startsWith('eighth') || s.startsWith('ef')) kind = 'ef';
  else if (s.startsWith('final') || /^f\s*\d/.test(s)) kind = 'final';
  else if (s.startsWith('playoff')) kind = 'playoff';
  else if (s.startsWith('qual') || s.startsWith('qm') || /^q\s*\d/.test(s)) kind = 'qual';
  else kind = 'other';
  return { kind, num };
}

/** Parse "<level><set>m<game>" from a match key tail (qm12 / sf3m1 / f1m2). */
function setGameOf(matchKey: string): { set: number | null; game: number | null } {
  const t = matchKey.includes('_') ? matchKey.slice(matchKey.lastIndexOf('_') + 1) : matchKey;
  const m = t.match(/^[a-zA-Z]+(\d+)(?:m(\d+))?/);
  if (!m) return { set: null, game: null };
  return { set: Number(m[1]), game: m[2] != null ? Number(m[2]) : null };
}

/**
 * Does a Nexus match refer to the same match as this scheduled MatchRow? Handles
 * quals (by match number) AND playoffs: "Final N" → the f row's game N; a
 * bracket label ("Semifinal N" / "Playoff N") → the playoff row whose SET (parsed
 * from its match_key, e.g. sf3m1 → 3) is N. Exported so the view and the tracker
 * share one resolver instead of three drifting copies.
 */
export function nexusMatchesRow(nm: NexusMatch, m: MatchRow): boolean {
  const p = parseNexusLabel(nm.label);
  if (!p) return false;
  const lvl = m.comp_level.toLowerCase();
  switch (p.kind) {
    case 'qual':
      return lvl === 'qm' && m.match_number === p.num;
    case 'final': {
      const game = setGameOf(m.match_key).game ?? m.match_number;
      return lvl === 'f' && game === p.num;
    }
    case 'qf':
    case 'sf':
    case 'ef':
      return lvl === p.kind && setGameOf(m.match_key).set === p.num;
    case 'playoff':
      // Double-elim bracket: every match is 'sf' (older formats use ef/qf), the
      // bracket position equals the set number in the key.
      return (lvl === 'sf' || lvl === 'qf' || lvl === 'ef') && setGameOf(m.match_key).set === p.num;
    default:
      return false;
  }
}

/** Map a Nexus match to the scheduled MatchRow it represents (quals + playoffs). */
export function matchRowForNexus(matches: MatchRow[], nm: NexusMatch): MatchRow | null {
  return matches.find((m) => nexusMatchesRow(nm, m)) ?? null;
}

/**
 * OUR next match the view should track, preferring LIVE Nexus data when it's
 * available and falling back to the schedule otherwise:
 *
 *   - When `status` is present, take the earliest not-yet-completed Nexus match
 *     for our team (Nexus' `upcoming` is already ordered by estimated start),
 *     resolve it to a scheduled MatchRow, and return that. If Nexus has no
 *     upcoming match for us OR we can't resolve it to a row, fall through.
 *   - Otherwise (Nexus unavailable, or no resolvable Nexus match) use the
 *     schedule-derived `nextMatchForTeam`.
 *
 * Pure — callers pass the parsed Nexus status (or null when unavailable).
 */
export function trackedNextMatch(
  matches: MatchRow[],
  teamNumber: number,
  status: NexusEventStatus | null,
): MatchRow | null {
  if (status) {
    // Walk Nexus' ordered upcoming list and take the first of OUR matches that
    // resolves to a schedule row WE STILL HAVEN'T PLAYED. The isUnplayedMatch
    // guard is the fix for the live-path stick: Nexus often leaves a finished
    // match flagged "On field" (never flipping it to "Completed"), so it lingers
    // at the head of `upcoming`. Without this check we'd return that already-
    // scored row (results now flow in from the webhook), re-pinning the hero to a
    // match we already played. A played/unresolvable entry is skipped, not
    // returned — so we fall through to the schedule only when Nexus offers nothing
    // live for us.
    for (const nm of status.upcoming) {
      if (!nexusIncludesTeam(nm, teamNumber)) continue;
      const row = matchRowForNexus(matches, nm);
      if (row && isUnplayedMatch(row)) return row;
    }
  }
  return nextMatchForTeam(matches, teamNumber);
}
