// src/dash/strategy/useTeamEpaTrends.ts
// Season-wide EPA trend detection for the Strategy tab's red flags. For each
// matchup team we compute the IN-HOUSE EPA (localEpa — the Statbotics-port
// model over TBA season results) twice:
//   * "now"    — over the team's full season to date;
//   * "before" — over the same season EXCLUDING the team's most recent
//                EPA_TREND_WINDOW played matches.
// A significant now-vs-before drop (cutoffs in redFlags.evaluateEpaDrop) means
// the team's on-field output is falling — worth a flag next to died/tipped/etc.
//
// All TBA fetches ride the shared cached fan-out (fetchSeasonMatchRows →
// per-event/per-team React Query cache entries, persisted to IndexedDB), so
// this adds no new endpoints and degrades to "no flags" on any TBA outage.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { computeLocalEpa } from '@/dash/localEpa';
import { fetchSeasonMatchRows, EPA_STALE_TIME } from '@/dash/seasonEpa';
import { queryClient } from '@/lib/queryPersist';
import { EPA_RECENCY_BOOST } from '@/dash/constants';
import { evaluateEpaDrop, type RedFlag } from '@/dash/strategy/redFlags';
import type { MatchRow } from '@/dash/useEventData';

/** The team's most recent played matches treated as "the recent window". */
export const EPA_TREND_WINDOW = 4;
/** Below this many season matches the baseline is too thin to call a trend. */
export const EPA_TREND_MIN_MATCHES = 8;

function isPlayed(m: MatchRow): boolean {
  return m.actual_red_score != null && m.actual_blue_score != null;
}

function involves(m: MatchRow, team: number): boolean {
  return (
    m.red1 === team ||
    m.red2 === team ||
    m.red3 === team ||
    m.blue1 === team ||
    m.blue2 === team ||
    m.blue3 === team
  );
}

/**
 * The EPA-drop flag for one team, or null. Cached per (team, year) — shares
 * the season match rows with the EPA fallback, so repeat calls are free.
 */
export async function epaTrendForTeam(
  team: number,
  eventKey: string,
  year: string,
): Promise<RedFlag | null> {
  return queryClient.fetchQuery({
    queryKey: ['epa', 'trend', team, year, EPA_RECENCY_BOOST],
    staleTime: EPA_STALE_TIME,
    retry: false,
    queryFn: async (): Promise<RedFlag | null> => {
      const rows = await fetchSeasonMatchRows([team], eventKey, year);
      // The team's played matches in model order (tbaMatchesToRows encodes
      // cross-event chronology into match_number — the order computeLocalEpa
      // itself replays).
      const teamPlayed = rows
        .filter((m) => isPlayed(m) && involves(m, team))
        .sort((a, b) => a.match_number - b.match_number);
      if (teamPlayed.length < EPA_TREND_MIN_MATCHES) return null;

      const recentKeys = new Set(
        teamPlayed.slice(-EPA_TREND_WINDOW).map((m) => m.match_key),
      );
      // IMPORTANT: both runs use the SAME complete match set minus the window —
      // never a single team's slice (see seasonEpa.ts's model contract).
      const now = computeLocalEpa(rows, { recencyBoost: EPA_RECENCY_BOOST }).get(team) ?? null;
      const before =
        computeLocalEpa(
          rows.filter((m) => !recentKeys.has(m.match_key)),
          { recencyBoost: EPA_RECENCY_BOOST },
        ).get(team) ?? null;
      return evaluateEpaDrop(before, now);
    },
  });
}

/**
 * EPA-drop flags for a matchup's teams as a team→flag Map (teams without a
 * significant drop are absent). Degrades to an empty Map on any failure —
 * trend flags are additive intel, never a reason to block the tab.
 */
export function useTeamEpaTrends(
  teamNumbers: number[],
  eventKey: string | null,
): UseQueryResult<Map<number, RedFlag>> {
  const sortedTeams = [...teamNumbers].sort((a, b) => a - b);
  const year = eventKey ? eventKey.slice(0, 4) : '';
  return useQuery({
    queryKey: ['epa', 'trend-flags', eventKey, sortedTeams.join(',')],
    enabled: !!eventKey && sortedTeams.length > 0,
    staleTime: EPA_STALE_TIME,
    queryFn: async (): Promise<Map<number, RedFlag>> => {
      const results = await Promise.all(
        sortedTeams.map(async (team) => {
          try {
            return [team, await epaTrendForTeam(team, eventKey as string, year)] as const;
          } catch {
            return [team, null] as const;
          }
        }),
      );
      const map = new Map<number, RedFlag>();
      for (const [team, flag] of results) {
        if (flag) map.set(team, flag);
      }
      return map;
    },
  });
}
