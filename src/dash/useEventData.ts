import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { tbaGet, statboticsGet, epaFromTeamEvent } from '@/dash/proxies';
import type { MsrRow } from '@/dash/types';

const STALE_TIME = 60_000;

export interface TeamRow {
  team_number: number;
  nickname: string | null;
}

export interface MatchRow {
  match_key: string;
  event_key: string;
  comp_level: string;
  match_number: number;
  scheduled_time: string | null;
  red1: number | null;
  red2: number | null;
  red3: number | null;
  blue1: number | null;
  blue2: number | null;
  blue3: number | null;
  actual_red_score: number | null;
  actual_blue_score: number | null;
  winner: string | null;
  result_synced_at: string | null;
}

export interface EventEpa {
  epaByTeam: Map<number, number | null>;
  available: boolean;
}

/** Scouting reports for an event (deleted rows excluded; RLS-scoped). */
export function useEventReports(eventKey: string | null): UseQueryResult<MsrRow[]> {
  return useQuery({
    queryKey: ['reports', eventKey],
    enabled: !!eventKey,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<MsrRow[]> => {
      const { data, error } = await supabase
        .from('match_scouting_report')
        .select('*')
        .eq('event_key', eventKey as string)
        .eq('deleted', false);
      if (error) {
        throw error;
      }
      return (data ?? []) as MsrRow[];
    },
  });
}

/** Match schedule (and live results, when synced) for an event. */
export function useEventMatches(eventKey: string | null): UseQueryResult<MatchRow[]> {
  return useQuery({
    queryKey: ['matches', eventKey],
    enabled: !!eventKey,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<MatchRow[]> => {
      const { data, error } = await supabase
        .from('match')
        .select('*')
        .eq('event_key', eventKey as string)
        .order('match_number', { ascending: true });
      if (error) {
        throw error;
      }
      return (data ?? []) as MatchRow[];
    },
  });
}

/** Teams participating in an event (via event_team → team). */
export function useEventTeams(eventKey: string | null): UseQueryResult<TeamRow[]> {
  return useQuery({
    queryKey: ['teams', eventKey],
    enabled: !!eventKey,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<TeamRow[]> => {
      const { data, error } = await supabase
        .from('event_team')
        .select('team:team(team_number,nickname)')
        .eq('event_key', eventKey as string);
      if (error) {
        throw error;
      }
      const rows = (data ?? []) as unknown as Array<{ team: TeamRow | null }>;
      return rows
        .map((r) => r.team)
        .filter((t): t is TeamRow => t !== null);
    },
  });
}

/** TBA event rankings (through the tba-proxy). */
export function useTbaRankings<T = unknown>(eventKey: string | null): UseQueryResult<T> {
  return useQuery({
    queryKey: ['tba', 'rankings', eventKey],
    enabled: !!eventKey,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<T> => tbaGet<T>(`/event/${eventKey}/rankings`),
  });
}

/**
 * Statbotics EPA for a set of teams at an event. Degrades gracefully: a team
 * whose proxy call returns the unavailable sentinel (or has no parseable EPA)
 * maps to null. `available` is false only when EVERY team came back
 * unavailable — i.e. Statbotics is down.
 */
export function useEventEpa(
  teamNumbers: number[],
  eventKey: string | null,
): UseQueryResult<EventEpa> {
  const sortedTeams = [...teamNumbers].sort((a, b) => a - b);
  return useQuery({
    queryKey: ['epa', eventKey, sortedTeams.join(',')],
    enabled: !!eventKey && sortedTeams.length > 0,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<EventEpa> => {
      const epaByTeam = new Map<number, number | null>();
      let anyAvailable = false;

      const results = await Promise.all(
        sortedTeams.map(async (team) => {
          const json = await statboticsGet<unknown>(`/team_event/${team}/${eventKey}`);
          const unavailable =
            typeof json === 'object' &&
            json !== null &&
            (json as { available?: unknown }).available === false;
          return { team, json, unavailable };
        }),
      );

      for (const { team, json, unavailable } of results) {
        if (unavailable) {
          epaByTeam.set(team, null);
          continue;
        }
        anyAvailable = true;
        epaByTeam.set(team, epaFromTeamEvent(json));
      }

      return { epaByTeam, available: anyAvailable };
    },
  });
}
