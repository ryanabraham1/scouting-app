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
import { formatMatchKey } from '@/lib/formatMatch';

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
export function nextMatchForTeam(matches: MatchRow[], teamNumber: number): MatchRow | null {
  const ordered = matches
    .filter((m) => isUnplayedMatch(m) && includesTeam(m, teamNumber))
    .sort((a, b) => {
      const lr = levelRank(a.comp_level) - levelRank(b.comp_level);
      return lr !== 0 ? lr : a.match_number - b.match_number;
    });
  return ordered[0] ?? null;
}

/** Does a Nexus match include `teamNumber` on either alliance? */
function nexusIncludesTeam(nm: NexusMatch, teamNumber: number): boolean {
  return nm.redTeams.includes(teamNumber) || nm.blueTeams.includes(teamNumber);
}

/**
 * Map a Nexus match to the scheduled MatchRow it represents. Nexus labels look
 * like "Qualification 12" while our schedule keys are "Qual 12", so we match on
 * the trailing number plus a shared (first-4-char, lowercased) level prefix.
 * Mirrors the defensive matching used elsewhere in the view.
 */
export function matchRowForNexus(matches: MatchRow[], nm: NexusMatch): MatchRow | null {
  const a = nm.label.toLowerCase();
  return (
    matches.find((m) => {
      const label = formatMatchKey(m.comp_level, m.match_number).toLowerCase();
      return a.endsWith(` ${m.match_number}`) && a.split(' ')[0].startsWith(label.split(' ')[0].slice(0, 4));
    }) ?? null
  );
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
    const ourUpcoming = status.upcoming.find((nm) => nexusIncludesTeam(nm, teamNumber));
    if (ourUpcoming) {
      const row = matchRowForNexus(matches, ourUpcoming);
      if (row) return row;
    }
  }
  return nextMatchForTeam(matches, teamNumber);
}
