// src/dash/board/widgets/data.tsx
// One shared data layer for every widget on the board: the queries run ONCE
// here (not per widget), so 40 team cards cost the same as one. Everything
// reuses the dashboard's existing hooks and the persisted TanStack cache, so
// widgets stay live (realtime invalidation) and work offline (last good data).
// Plan: docs/plans/ryans-board/README.md §10.2.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useEventComponentEpas,
  useMatchupNotes,
  useEventScouts,
  useEventAssignments,
  type ScoutRow,
  type AssignmentRow,
  useEventEpa,
  useEventMatches,
  useEventReports,
  useEventTeams,
  useNexusEventStatus,
  useTbaRankings,
  type EventEpa,
  type MatchRow,
  type NexusStatusResult,
  type TeamRow,
} from '@/dash/useEventData';
import type { MsrRow } from '@/dash/types';
import { useEventPits, type TeamPit } from '@/dash/useTeamPit';
import { aggregateEvent, type TeamAgg } from '@/dash/aggregate';
import { predictMatch, type MatchPrediction } from '@/dash/predict';
import { getCachedPicklist, getPicklist, type PicklistEntry } from '@/dash/picklistClient';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';
import { blueTeamsOf, redTeamsOf } from '@/dash/matchOrder';
import { nextMatchForTeam } from '@/dash/nextMatch';

export type MetricKey =
  | 'bsr'
  | 'auto'
  | 'teleop'
  | 'endgame'
  | 'scouted'
  | 'defense'
  | 'reliability'
  | 'rank'
  | 'winrate';

export interface MetricDef {
  key: MetricKey;
  label: string;
  /** Lower is better (rank). */
  lowerBetter?: boolean;
  format: (v: number) => string;
}

const one = (v: number): string => v.toFixed(1);
const pct = (v: number): string => `${Math.round(v * 100)}%`;

export const METRICS: Record<MetricKey, MetricDef> = {
  bsr: { key: 'bsr', label: 'BSR', format: one },
  auto: { key: 'auto', label: 'Auto', format: one },
  teleop: { key: 'teleop', label: 'Teleop', format: one },
  endgame: { key: 'endgame', label: 'Endgame', format: one },
  scouted: { key: 'scouted', label: 'Scouted pts', format: one },
  defense: { key: 'defense', label: 'Defense', format: one },
  reliability: { key: 'reliability', label: 'Reliability', format: pct },
  rank: { key: 'rank', label: 'Rank', lowerBetter: true, format: (v) => String(Math.round(v)) },
  winrate: { key: 'winrate', label: 'Win rate', format: pct },
};

export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

export interface TeamStanding {
  rank: number;
  wins: number;
  losses: number;
  ties: number;
}

export interface BoardData {
  eventKey: string;
  teams: TeamRow[];
  teamNumbers: number[];
  nickname: (team: number) => string | null;
  matches: MatchRow[];
  epa: EventEpa;
  agg: Map<number, TeamAgg>;
  reports: MsrRow[];
  pits: Map<number, TeamPit>;
  strategyNotes: Map<string, string>;
  scouts: ScoutRow[];
  assignments: AssignmentRow[];
  standings: Map<number, TeamStanding>;
  nexus: NexusStatusResult | undefined;
  picklist: PicklistEntry[] | undefined;
  baseTeam: number;
  loading: boolean;
  predict: (red: number[], blue: number[]) => MatchPrediction | null;
  metric: (team: number, key: MetricKey) => number | null;
}

const EMPTY_EPA: EventEpa = { epaByTeam: new Map(), available: false, source: 'none' };

export function isPlayed(m: MatchRow): boolean {
  return m.actual_red_score != null && m.actual_blue_score != null;
}

export function teamsOf(m: MatchRow): number[] {
  return [...redTeamsOf(m), ...blueTeamsOf(m)];
}

const LEVEL_RANK: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };

/** Play order: level, then the numeric parts of the match key. */
export function byPlayOrder(a: MatchRow, b: MatchRow): number {
  const lr = (LEVEL_RANK[a.comp_level] ?? 9) - (LEVEL_RANK[b.comp_level] ?? 9);
  if (lr) return lr;
  const na = a.match_key.match(/\d+/g)?.map(Number) ?? [];
  const nb = b.match_key.match(/\d+/g)?.map(Number) ?? [];
  // Skip the year in the event key.
  for (let i = 1; i < Math.max(na.length, nb.length); i += 1) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return d;
  }
  return a.match_key < b.match_key ? -1 : 1;
}

export function teamMatches(matches: readonly MatchRow[], team: number): MatchRow[] {
  return matches.filter((m) => teamsOf(m).includes(team)).sort(byPlayOrder);
}

/** The team's most recent PLAYED match (lastMatchForTeam returns the last scheduled one). */
export function lastPlayedMatch(matches: readonly MatchRow[], team: number): MatchRow | null {
  const played = teamMatches(matches, team).filter(isPlayed);
  return played.length ? played[played.length - 1] : null;
}

export function nextMatchOf(matches: readonly MatchRow[], team: number): MatchRow | null {
  return nextMatchForTeam([...matches], team);
}

export function allianceOf(m: MatchRow, team: number): 'red' | 'blue' | null {
  if (redTeamsOf(m).includes(team)) return 'red';
  if (blueTeamsOf(m).includes(team)) return 'blue';
  return null;
}

/** W/L/T from the team's perspective for a played match. */
export function resultFor(m: MatchRow, team: number): 'W' | 'L' | 'T' | null {
  if (!isPlayed(m)) return null;
  const side = allianceOf(m, team);
  if (!side) return null;
  const ours = side === 'red' ? m.actual_red_score! : m.actual_blue_score!;
  const theirs = side === 'red' ? m.actual_blue_score! : m.actual_red_score!;
  return ours > theirs ? 'W' : ours < theirs ? 'L' : 'T';
}

/** Resolve a widget's team binding ('base' = our team). */
export function resolveTeam(v: unknown, data: Pick<BoardData, 'baseTeam'>): number | null {
  if (v === 'base') return data.baseTeam;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Resolve a match binding: a match key, a short label like 'qm32', or 'our-next'. */
export function resolveMatch(v: unknown, data: Pick<BoardData, 'matches' | 'baseTeam' | 'eventKey'>): MatchRow | null {
  if (v === 'our-next') {
    return nextMatchOf(data.matches, data.baseTeam) ?? lastPlayedMatch(data.matches, data.baseTeam);
  }
  if (typeof v !== 'string' || !v) return null;
  const key = v.includes('_') ? v : `${data.eventKey}_${v}`;
  return data.matches.find((m) => m.match_key === key) ?? null;
}

function parseStandings(raw: unknown): Map<number, TeamStanding> {
  const out = new Map<number, TeamStanding>();
  const rows = (raw as { rankings?: unknown[] } | null)?.rankings;
  if (!Array.isArray(rows)) return out;
  for (const r of rows as {
    rank?: number;
    team_key?: string;
    record?: { wins?: number; losses?: number; ties?: number };
  }[]) {
    if (!r || typeof r.team_key !== 'string' || typeof r.rank !== 'number') continue;
    const m = /^frc(\d+)$/.exec(r.team_key);
    if (!m) continue;
    out.set(Number(m[1]), {
      rank: r.rank,
      wins: r.record?.wins ?? 0,
      losses: r.record?.losses ?? 0,
      ties: r.record?.ties ?? 0,
    });
  }
  return out;
}

const BoardDataContext = createContext<BoardData | null>(null);

export function useBoardData(): BoardData {
  const v = useContext(BoardDataContext);
  if (!v) throw new Error('useBoardData must be used inside BoardDataProvider');
  return v;
}

export function BoardDataProvider({ eventKey, children }: { eventKey: string; children: ReactNode }): JSX.Element {
  const teamsQ = useEventTeams(eventKey);
  const matchesQ = useEventMatches(eventKey);
  const reportsQ = useEventReports(eventKey);
  const pitsQ = useEventPits(eventKey);
  const notesQ = useMatchupNotes(eventKey);
  const scoutsQ = useEventScouts(eventKey);
  const assignmentsQ = useEventAssignments(eventKey);
  const teams = useMemo(() => teamsQ.data ?? [], [teamsQ.data]);
  const matches = useMemo(() => matchesQ.data ?? [], [matchesQ.data]);
  const teamNumbers = useMemo(() => {
    const set = new Set<number>(teams.map((t) => t.team_number));
    for (const m of matches) for (const t of teamsOf(m)) set.add(t);
    return [...set].sort((a, b) => a - b);
  }, [teams, matches]);
  const epaQ = useEventEpa(teamNumbers, eventKey, matches);
  const componentQ = useEventComponentEpas(teamNumbers, eventKey);
  const rankingsQ = useTbaRankings(eventKey);
  const nexusQ = useNexusEventStatus(eventKey);
  const picklistQ = useQuery({
    queryKey: ['picklist', eventKey],
    queryFn: () => getPicklist(eventKey),
    staleTime: 30_000,
    initialData: () => getCachedPicklist(eventKey) ?? undefined,
  });

  const agg = useMemo(() => aggregateEvent(reportsQ.data ?? []), [reportsQ.data]);
  const epa = epaQ.data ?? EMPTY_EPA;
  const standings = useMemo(() => parseStandings(rankingsQ.data), [rankingsQ.data]);
  const fraction = componentQ.data?.fraction;
  const baseTeam = getStoredBaseTeam();

  const value = useMemo<BoardData>(() => {
    const nick = new Map(teams.map((t) => [t.team_number, t.nickname] as const));
    const played = matches.filter(isPlayed);
    const winrate = new Map<number, number>();
    const tally = new Map<number, { w: number; n: number }>();
    for (const m of played) {
      for (const t of teamsOf(m)) {
        const r = resultFor(m, t);
        const e = tally.get(t) ?? { w: 0, n: 0 };
        e.n += 1;
        if (r === 'W') e.w += 1;
        else if (r === 'T') e.w += 0.5;
        tally.set(t, e);
      }
    }
    for (const [t, e] of tally) winrate.set(t, e.w / e.n);
    const predictCache = new Map<string, MatchPrediction | null>();
    return {
      eventKey,
      teams,
      teamNumbers,
      nickname: (t) => nick.get(t) ?? null,
      matches,
      epa,
      agg,
      reports: reportsQ.data ?? [],
      pits: pitsQ.data ?? new Map(),
      strategyNotes: notesQ.data ?? new Map(),
      scouts: scoutsQ.data ?? [],
      assignments: assignmentsQ.data ?? [],
      standings,
      nexus: nexusQ.data,
      picklist: picklistQ.data,
      baseTeam,
      loading: teamsQ.isLoading || matchesQ.isLoading,
      predict: (red, blue) => {
        if (!red.length || !blue.length) return null;
        const key = `${red.join(',')}|${blue.join(',')}`;
        if (!predictCache.has(key)) {
          try {
            predictCache.set(
              key,
              predictMatch({
                redTeams: red,
                blueTeams: blue,
                agg,
                epaByTeam: epa.epaByTeam,
                componentEpaByTeam: epa.componentsByTeam,
                epaAvailable: epa.available,
                fraction,
                playedMatches: played.length,
                bayes: epa,
              }),
            );
          } catch {
            predictCache.set(key, null);
          }
        }
        return predictCache.get(key) ?? null;
      },
      metric: (team, key) => {
        const finite = (v: number | null | undefined): number | null =>
          v != null && Number.isFinite(v) ? v : null;
        switch (key) {
          case 'bsr':
            return epa.available ? finite(epa.epaByTeam.get(team)) : null;
          case 'auto':
            return finite(epa.componentsByTeam?.get(team)?.auto);
          case 'teleop':
            return finite(epa.componentsByTeam?.get(team)?.teleop);
          case 'endgame':
            return finite(epa.componentsByTeam?.get(team)?.endgame);
          case 'scouted': {
            const a = agg.get(team);
            return a && a.matchesScouted > 0 ? finite(a.scoutingExpectedPoints) : null;
          }
          case 'defense': {
            const a = agg.get(team);
            return a && a.matchesScouted > 0 ? finite(a.avgDefenseRating) : null;
          }
          case 'reliability': {
            const a = agg.get(team);
            return a && a.matchesScouted > 0 ? finite(a.reliability) : null;
          }
          case 'rank':
            return standings.get(team)?.rank ?? null;
          case 'winrate':
            return winrate.get(team) ?? null;
        }
      },
    };
  }, [eventKey, teams, teamNumbers, matches, epa, agg, standings, nexusQ.data, picklistQ.data, baseTeam, fraction, reportsQ.data, pitsQ.data, notesQ.data, scoutsQ.data, assignmentsQ.data, teamsQ.isLoading, matchesQ.isLoading]);

  return <BoardDataContext.Provider value={value}>{children}</BoardDataContext.Provider>;
}
