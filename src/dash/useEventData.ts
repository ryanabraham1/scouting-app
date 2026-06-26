import { useEffect } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { tbaGet, statboticsGet, nexusGet, syncEventResults } from '@/dash/proxies';
import { queryClient } from '@/lib/queryPersist';
import { computeLocalEpa } from '@/dash/localEpa';
import { fetchSeasonMatchRows, EPA_STALE_TIME } from '@/dash/seasonEpa';
import {
  parseNexusEventStatus,
  type NexusEventStatus,
} from '@/dash/nexusClient';
import {
  parseStatboticsTeamYear,
  seasonRecordFromTbaMatches,
  type EpaSource,
} from '@/dash/SeasonStats';
import type { EventWebcast } from '@/dash/EventStream';
import type { MsrRow } from '@/dash/types';
import {
  NEXUS_POLL_MS,
  NEXUS_STALE_MS,
  RESULTS_RECONCILE_MS,
  EPA_RECENCY_BOOST,
} from '@/dash/constants';

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

export interface ScoutRow {
  id: string;
  display_name: string | null;
  event_key: string;
}

export interface EventEpa {
  epaByTeam: Map<number, number | null>;
  available: boolean;
  /**
   * Where the EPA values came from:
   *  - 'statbotics': live Statbotics EPA for at least one team.
   *  - 'local': Statbotics was down for ALL teams, so we computed a simplified
   *    local EPA from this event's played match results (see computeLocalEpa).
   *  - 'none': neither source produced anything (e.g. no matches passed in).
   * Additive + OPTIONAL so existing object-literal fixtures (e.g. RankingView /
   * TeamView tests owned by another agent) keep type-checking. `useEventEpa`
   * ALWAYS sets it, so hook consumers can rely on a concrete value.
   */
  source?: 'statbotics' | 'local' | 'none';
}

/** Parsed Nexus live status plus an availability flag for graceful degradation. */
export interface NexusStatusResult {
  status: NexusEventStatus | null;
  available: boolean;
  /**
   * True when the freshest snapshot we hold is older than NEXUS_STALE_MS — the
   * field has likely gone quiet / the push stopped. Callers treat a stale
   * snapshot as not-live and degrade to the schedule. Optional so existing
   * mocked fixtures (tests) that omit it keep type-checking.
   */
  stale?: boolean;
  /** Where this snapshot came from: webhook (DB push), proxy (direct pull), or none. */
  source?: 'webhook' | 'proxy' | 'none';
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

/** Scouters registered for an event (read from the open `scout` table, 0009 RLS). */
export function useEventScouts(eventKey: string | null): UseQueryResult<ScoutRow[]> {
  return useQuery({
    queryKey: ['scouts', eventKey],
    enabled: !!eventKey,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<ScoutRow[]> => {
      const { data, error } = await supabase
        .from('scout')
        .select('id,display_name,event_key')
        .eq('event_key', eventKey as string);
      if (error) {
        throw error;
      }
      return (data ?? []) as ScoutRow[];
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

function asString(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** TBA team header info (`/team/frcN`): identity + location. */
export interface TbaTeamInfo {
  nickname: string | null;
  name: string | null;
  city: string | null;
  stateProv: string | null;
  country: string | null;
  rookieYear: number | null;
  website: string | null;
}

/**
 * TBA team header (nickname, location, rookie year, website) for a single team.
 * Degrades to `null` when TBA is unreachable or the team is unknown — never
 * hard-fails the team view.
 */
export function useTbaTeam(team: number | null): UseQueryResult<TbaTeamInfo | null> {
  return useQuery({
    queryKey: ['tba', 'team', team],
    enabled: team != null && team > 0,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<TbaTeamInfo | null> => {
      try {
        const d = await tbaGet<Record<string, unknown>>(`/team/frc${team}`);
        if (typeof d !== 'object' || d === null) return null;
        return {
          nickname: asString(d.nickname),
          name: asString(d.name),
          city: asString(d.city),
          stateProv: asString(d.state_prov),
          country: asString(d.country),
          rookieYear: asFiniteNumber(d.rookie_year),
          website: asString(d.website),
        };
      } catch {
        return null;
      }
    },
  });
}

/** A team's status AT a specific event (rank, record, alliance) from TBA. */
export interface TbaTeamEventStatus {
  rank: number | null;
  numTeams: number | null;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  allianceName: string | null;
}

/**
 * TBA `/team/frcN/event/{eventKey}/status`: this team's qual ranking + record at
 * this event, plus playoff alliance when seeded. Degrades to `null` (TBA down,
 * or the team isn't at this event / no ranking yet) so the view never hard-fails.
 */
export function useTbaTeamEventStatus(
  team: number | null,
  eventKey: string | null,
): UseQueryResult<TbaTeamEventStatus | null> {
  return useQuery({
    queryKey: ['tba', 'team-event-status', team, eventKey],
    enabled: team != null && team > 0 && !!eventKey,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<TbaTeamEventStatus | null> => {
      try {
        const d = await tbaGet<Record<string, unknown>>(
          `/team/frc${team}/event/${eventKey}/status`,
        );
        // TBA returns a bare `null` body when the team has no status at the event.
        if (typeof d !== 'object' || d === null) return null;
        const qual = d.qual as Record<string, unknown> | null | undefined;
        const ranking = qual?.ranking as Record<string, unknown> | null | undefined;
        const record = ranking?.record as Record<string, unknown> | null | undefined;
        const alliance = d.alliance as Record<string, unknown> | null | undefined;
        return {
          rank: asFiniteNumber(ranking?.rank),
          numTeams: asFiniteNumber(qual?.num_teams),
          wins: asFiniteNumber(record?.wins),
          losses: asFiniteNumber(record?.losses),
          ties: asFiniteNumber(record?.ties),
          allianceName: asString(alliance?.name),
        };
      } catch {
        return null;
      }
    },
  });
}

/** A team's season EPA from one cached source (so every display agrees). */
export interface TeamSeasonEpa {
  epa: number | null;
  worldRank: number | null;
  record: string | null;
  source: 'statbotics' | 'inhouse' | 'none';
}

/**
 * SINGLE SOURCE OF TRUTH for a team's season EPA, cached per (team, year,
 * recency). Statbotics season EPA (`team_year`) when available; otherwise the
 * recency-weighted in-house model over the union of events THAT TEAM attended
 * (full alliances — never a single event, which cold-starts and underestimates).
 *
 * Both the Total-EPA tile (useTeamSeasonStats) and the match prediction
 * (useEventEpa) read THIS, so a team shows the SAME EPA everywhere — and both use
 * the same `team_year` metric, fixing the old `team_event` vs `team_year` and
 * "6-team combined run vs single-team run" discrepancies. Cached + persisted
 * (queryPersist) so it computes once per team and serves offline.
 */
export async function seasonEpaForTeam(
  team: number,
  eventKey: string,
  year: string,
): Promise<TeamSeasonEpa> {
  return queryClient.fetchQuery({
    queryKey: ['epa', 'season-team', team, year, EPA_RECENCY_BOOST],
    staleTime: EPA_STALE_TIME,
    queryFn: async (): Promise<TeamSeasonEpa> => {
      const json = await statboticsGet<unknown>(`/team_year/${team}/${year}`);
      const unavailable =
        typeof json === 'object' &&
        json !== null &&
        (json as { available?: unknown }).available === false;
      const sb = unavailable
        ? { worldRank: null, totalEpa: null, record: null }
        : parseStatboticsTeamYear(json);
      if (sb.totalEpa != null) {
        return { epa: sb.totalEpa, worldRank: sb.worldRank, record: sb.record, source: 'statbotics' };
      }
      const rows = await fetchSeasonMatchRows([team], eventKey, year);
      const epa = computeLocalEpa(rows, { recencyBoost: EPA_RECENCY_BOOST }).get(team) ?? null;
      return {
        epa,
        worldRank: sb.worldRank,
        record: sb.record,
        source: epa != null ? 'inhouse' : 'none',
      };
    },
  });
}

/**
 * EPA per team for a match, for the prediction. Reads {@link seasonEpaForTeam}
 * for EACH team, so every team's prediction EPA EQUALS its Total-EPA tile (no
 * more 303-vs-290 discrepancy). `source` is 'statbotics' if any team has a
 * Statbotics season EPA, else 'local' if any team has an in-house estimate, else
 * 'none'. The third arg is accepted for call-site compatibility but unused — EPA
 * is season-wide, not derived from the current event's rows.
 */
export function useEventEpa(
  teamNumbers: number[],
  eventKey: string | null,
  _matches: MatchRow[] = [],
): UseQueryResult<EventEpa> {
  const sortedTeams = [...teamNumbers].sort((a, b) => a - b);
  const year = eventKey ? eventKey.slice(0, 4) : '';
  return useQuery({
    queryKey: ['epa', 'event', eventKey, sortedTeams.join(',')],
    enabled: !!eventKey && sortedTeams.length > 0,
    staleTime: EPA_STALE_TIME,
    queryFn: async (): Promise<EventEpa> => {
      const results = await Promise.all(
        sortedTeams.map((team) => seasonEpaForTeam(team, eventKey as string, year)),
      );
      const epaByTeam = new Map<number, number | null>();
      let anyStatbotics = false;
      let anyEpa = false;
      sortedTeams.forEach((team, i) => {
        const r = results[i];
        epaByTeam.set(team, r.epa);
        if (r.epa != null) {
          anyEpa = true;
          if (r.source === 'statbotics') anyStatbotics = true;
        }
      });
      const source: EventEpa['source'] = anyStatbotics ? 'statbotics' : anyEpa ? 'local' : 'none';
      return { epaByTeam, available: anyEpa, source };
    },
  });
}

/**
 * Is a snapshot with this `dataAsOfTime` (unix-ms) older than the live window?
 * Accepts a string too: PostgREST serializes the `bigint` column as a JSON
 * string, so a naive `typeof === 'number'` check would silently ignore it and
 * disable the guard. We coerce, then fall back to `receivedAt` only when there's
 * no usable timestamp.
 */
function isNexusStale(
  dataAsOfTime: number | string | null,
  receivedAt: string | null,
): boolean {
  const asNum = typeof dataAsOfTime === 'string' ? Number(dataAsOfTime) : dataAsOfTime;
  const ref =
    typeof asNum === 'number' && Number.isFinite(asNum)
      ? asNum
      : receivedAt
        ? Date.parse(receivedAt)
        : NaN;
  if (!Number.isFinite(ref)) return false; // unknown age -> don't penalize
  return Date.now() - ref > NEXUS_STALE_MS;
}

/** Build a NexusStatusResult from a nexus_event_status DB row (webhook snapshot). */
function statusFromDbRow(row: {
  payload: unknown;
  data_as_of_time: number | string | null;
  received_at: string | null;
}): NexusStatusResult {
  const status = parseNexusEventStatus(row.payload);
  // Prefer dataAsOfTime parsed from the JSONB payload (always a real number);
  // fall back to the bigint column then received_at inside isNexusStale.
  const asOf = status.dataAsOfTime ?? row.data_as_of_time;
  return {
    status,
    available: true,
    stale: isNexusStale(asOf, row.received_at),
    source: 'webhook',
  };
}

/** Read the latest webhook-pushed Nexus snapshot for an event from our DB. */
async function readNexusStatusFromDb(eventKey: string): Promise<NexusStatusResult | null> {
  const { data, error } = await supabase
    .from('nexus_event_status')
    .select('payload, data_as_of_time, received_at')
    .eq('event_key', eventKey);
  if (error || !data) return null;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { payload: unknown; data_as_of_time: number | string | null; received_at: string | null }
    | undefined;
  if (!row || !row.payload) return null;
  return statusFromDbRow(row);
}

/**
 * Live field status for an event. PRIMARY source is the webhook snapshot Nexus
 * pushes into our `nexus_event_status` table — delivered to the dashboard over
 * Supabase Realtime (see useEventLiveSync) so On-Field / Queuing advance the
 * instant the field changes, with no poll lag and a `dataAsOfTime` staleness
 * guard. FALLBACK (events with no webhook configured) is a direct pull through
 * nexus-proxy. The `refetchInterval` is a slow safety net; Realtime does the
 * real work. `available`/`stale` let callers degrade to the schedule.
 */
export function useNexusEventStatus(
  eventKey: string | null,
): UseQueryResult<NexusStatusResult> {
  return useQuery({
    queryKey: ['nexus', 'event', eventKey],
    enabled: !!eventKey,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: NEXUS_POLL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    queryFn: async (): Promise<NexusStatusResult> => {
      // 1. Prefer a FRESH real-time webhook snapshot from our DB.
      const fromDb = await readNexusStatusFromDb(eventKey as string);
      if (fromDb && !fromDb.stale) return fromDb;
      // 2. DB snapshot missing or stale (webhook stopped pushing mid-event): try a
      //    live direct pull so a dead webhook doesn't freeze the field when Nexus
      //    REST is still serving fresh data.
      const json = await nexusGet<unknown>(`/event/${eventKey}`);
      const unavailable =
        typeof json === 'object' &&
        json !== null &&
        (json as { available?: unknown }).available === false;
      if (!unavailable) {
        return { status: parseNexusEventStatus(json), available: true, source: 'proxy' };
      }
      // 3. Proxy also down: use the stale DB snapshot if we have one (callers see
      //    stale:true and degrade to the schedule), else nothing.
      if (fromDb) return fromDb;
      return { status: null, available: false, source: 'none' };
    },
  });
}

/**
 * Real-time glue for the live dashboard. For the active event it:
 *   - subscribes to `nexus_event_status` changes and pushes each new snapshot
 *     straight into the nexus query cache (instant On-Field / Queuing updates);
 *   - subscribes to `match` changes and invalidates the matches query so a freshly
 *     scored result advances the next-match selector immediately;
 *   - kicks a TBA results reconcile on mount and on RESULTS_RECONCILE_MS as a
 *     safety net for any webhook that was dropped/delayed.
 * No-op (and harmless) when there's no event, or when the Supabase client lacks
 * Realtime (e.g. mocked in unit tests). Call once high in the dashboard tree.
 */
export function useEventLiveSync(eventKey: string | null): void {
  const queryClient = useQueryClient();

  // Realtime subscriptions.
  useEffect(() => {
    if (!eventKey || typeof supabase.channel !== 'function') return;
    const channel = supabase
      .channel(`live-${eventKey}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'nexus_event_status',
          filter: `event_key=eq.${eventKey}`,
        },
        (payload: { new?: Record<string, unknown> }) => {
          const row = payload.new;
          if (row && row.payload) {
            queryClient.setQueryData<NexusStatusResult>(
              ['nexus', 'event', eventKey],
              statusFromDbRow({
                payload: row.payload,
                data_as_of_time: (row.data_as_of_time as number | string | null) ?? null,
                received_at: (row.received_at as string | null) ?? null,
              }),
            );
          } else {
            queryClient.invalidateQueries({ queryKey: ['nexus', 'event', eventKey] });
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'match', filter: `event_key=eq.${eventKey}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['matches', eventKey] });
        },
      )
      .subscribe();
    return () => {
      if (typeof supabase.removeChannel === 'function') supabase.removeChannel(channel);
    };
  }, [eventKey, queryClient]);

  // Results reconcile safety net (webhook is the primary path).
  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled) void syncEventResults(eventKey);
    };
    run();
    const id = setInterval(run, RESULTS_RECONCILE_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [eventKey]);
}

/** Parsed TBA event header info: display name + first usable webcast. */
export interface EventInfo {
  name: string | null;
  webcast: EventWebcast | null;
}

/** Pull the first webcast (youtube/twitch first) off a TBA event object. */
function firstWebcast(data: unknown): EventWebcast | null {
  if (typeof data !== 'object' || data === null) return null;
  const raw = (data as { webcasts?: unknown }).webcasts;
  if (!Array.isArray(raw)) return null;
  const parsed: EventWebcast[] = [];
  for (const w of raw) {
    if (typeof w !== 'object' || w === null) continue;
    const type = (w as { type?: unknown }).type;
    if (typeof type !== 'string' || !type) continue;
    const channel = (w as { channel?: unknown }).channel;
    const file = (w as { file?: unknown }).file;
    parsed.push({
      type,
      channel: typeof channel === 'string' ? channel : null,
      file: typeof file === 'string' ? file : null,
    });
  }
  if (parsed.length === 0) return null;
  // Prefer an embeddable youtube/twitch stream over other types.
  return (
    parsed.find((w) => w.type === 'youtube' || w.type === 'twitch') ?? parsed[0]
  );
}

/**
 * TBA event header (name + livestream webcast) for the broadcast dashboard.
 * Degrades to `{ name: null, webcast: null }` if TBA is unreachable.
 */
export function useEventInfo(eventKey: string | null): UseQueryResult<EventInfo> {
  return useQuery({
    queryKey: ['tba', 'event-info', eventKey],
    enabled: !!eventKey,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<EventInfo> => {
      try {
        const data = await tbaGet<{ name?: string }>(`/event/${eventKey}`);
        const name = typeof data?.name === 'string' ? data.name : null;
        return { name, webcast: firstWebcast(data) };
      } catch {
        return { name: null, webcast: null };
      }
    },
  });
}

/** Season-level stats for OUR team: Statbotics world rank/EPA with in-house fallback. */
export interface TeamSeasonStats {
  worldRank: number | null;
  totalEpa: number | null;
  epaSource: EpaSource;
  seasonRecord: string | null;
}

/**
 * Season EPA + world rank + W-L-T record for a single team. EPA comes from the
 * shared {@link seasonEpaForTeam} (Statbotics `team_year`, else the season-wide
 * recency-weighted in-house model) — the SAME source the match prediction uses,
 * so the Total-EPA tile and the prediction always agree. `epaSource` is
 * 'statbotics' | 'inhouse' | 'none'; the record falls back to a TBA-derived W-L-T.
 */
export function useTeamSeasonStats(
  team: number,
  eventKey: string | null,
  _matches: MatchRow[] = [],
): UseQueryResult<TeamSeasonStats> {
  const year = eventKey ? eventKey.slice(0, 4) : '';
  return useQuery({
    queryKey: ['statbotics', 'team-year', team, year],
    enabled: !!eventKey && team > 0,
    staleTime: EPA_STALE_TIME,
    queryFn: async (): Promise<TeamSeasonStats> => {
      // Same single source of truth as the match prediction -> identical EPA.
      const r = await seasonEpaForTeam(team, eventKey as string, year);

      // Season record: prefer the one Statbotics returned; else derive a W-L-T
      // from the team's FULL-season TBA matches. tbaGet throws on non-2xx, so
      // guard it — a TBA outage just leaves the record null.
      let seasonRecord = r.record;
      if (seasonRecord == null) {
        try {
          const tbaSeason = await tbaGet<unknown>(`/team/frc${team}/matches/${year}`);
          seasonRecord = seasonRecordFromTbaMatches(tbaSeason, team);
        } catch {
          /* TBA unavailable — leave the record null */
        }
      }

      const epaSource: EpaSource = r.source;
      return { worldRank: r.worldRank, totalEpa: r.epa, epaSource, seasonRecord };
    },
  });
}
