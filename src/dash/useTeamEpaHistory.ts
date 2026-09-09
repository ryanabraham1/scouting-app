import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  computeLocalEpaHistory,
  type LocalEpaHistoryPoint,
} from '@/dash/localEpa';
import {
  EPA_STALE_TIME,
  SEASON_EPA_CLOSURE_VERSION,
  fetchSeasonMatchRows,
} from '@/dash/seasonEpa';
import { EPA_RECENCY_BOOST } from '@/dash/constants';

/**
 * The selected team's in-house EPA after each match it played this season.
 * This reuses the same complete-event match closure and exact recurrence as the
 * headline EPA value, so the last chart point cannot drift from the dashboard.
 */
export async function teamEpaHistoryForTeam(
  team: number,
  eventKey: string,
  year: string,
): Promise<LocalEpaHistoryPoint[]> {
  const rows = await fetchSeasonMatchRows([team], eventKey, year);
  return computeLocalEpaHistory(rows, team, { recencyBoost: EPA_RECENCY_BOOST });
}

export function useTeamEpaHistory(
  team: number | null,
  eventKey: string | null,
): UseQueryResult<LocalEpaHistoryPoint[]> {
  const year = eventKey?.slice(0, 4) ?? '';
  return useQuery({
    queryKey: [
      'epa',
      'history',
      SEASON_EPA_CLOSURE_VERSION,
      eventKey,
      team,
      year,
      EPA_RECENCY_BOOST,
    ],
    enabled: team != null && !!eventKey,
    staleTime: EPA_STALE_TIME,
    retry: false,
    queryFn: () => teamEpaHistoryForTeam(team as number, eventKey as string, year),
  });
}

