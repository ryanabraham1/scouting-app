// src/dash/strategy/MatchupDashboard.tsx
// Broadcast-style matchup analytics for the Strategy tab: a "tale of the tape"
// (mirrored red↔blue alliance bars per metric) and a per-team comparison table
// with inline data bars — the glanceable graphics layer on top of the existing
// prediction cards (which keep the exact numbers and badges).
//
// Pure presentation over data the tab already computes (predictMatch output,
// aggregateEvent map, raw reports for the super-scout rating means) — no new
// queries, dependency-free CSS/flex bars (matches the charts/ philosophy).

import { lazy, Suspense, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { TeamAgg } from '@/dash/aggregate';
import type { MatchPrediction, TeamPrediction } from '@/dash/predict';
import type { TeamRow } from '@/dash/useEventData';
import type { MsrRow } from '@/dash/types';
import type { RadarDatum, ContribDatum } from '@/dash/strategy/MatchupCharts';

// recharts rides in its own lazy chunk (~145 KB gzip) — precached by the SW at
// install, so it still works offline, but the whiteboard never loads it.
const MatchupCharts = lazy(() => import('@/dash/strategy/MatchupCharts'));

export interface MatchupDashboardProps {
  redTeams: number[];
  blueTeams: number[];
  pred: MatchPrediction;
  agg: Map<number, TeamAgg>;
  reportsByTeam?: Map<number, MsrRow[]>;
  allTeams: TeamRow[];
  baseTeam: number;
  ourSide: 'red' | 'blue' | null;
}

const EM_DASH = '—';

/** Numeric mean of a 0–3 super-scout rating (0/null excluded); null when unrated. */
function ratedMeanNum(
  reports: MsrRow[] | undefined,
  sel: (m: MsrRow) => number | null | undefined,
): number | null {
  if (!reports) return null;
  const vals = reports.map(sel).filter((v): v is number => typeof v === 'number' && v > 0);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function sumComponent(
  teams: TeamPrediction[],
  key: 'auto' | 'fuel' | 'climb' | 'defense',
): number {
  return teams.reduce((s, p) => s + (p.components?.[key] ?? 0), 0);
}

/** Mean over the alliance's SCOUTED teams; null when none is scouted. */
function scoutedMean(
  teams: number[],
  agg: Map<number, TeamAgg>,
  sel: (a: TeamAgg) => number,
): number | null {
  const vals = teams
    .map((t) => agg.get(t))
    .filter((a): a is TeamAgg => !!a && a.matchesScouted > 0)
    .map(sel);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ---------------------------------------------------------------------------
// Tale of the tape — mirrored alliance bars around a centered metric label.
// ---------------------------------------------------------------------------

interface TapeRow {
  label: string;
  red: number | null;
  blue: number | null;
  /** Value formatter (default = rounded int). */
  fmt?: (v: number) => string;
}

function TapeBarRow({ row }: { row: TapeRow }): JSX.Element {
  const fmt = row.fmt ?? ((v: number) => String(Math.round(v)));
  const red = row.red ?? 0;
  const blue = row.blue ?? 0;
  const max = Math.max(red, blue, 1e-9);
  const redPct = Math.max(0, (red / max) * 100);
  const bluePct = Math.max(0, (blue / max) * 100);
  const redLeads = red > blue;
  const blueLeads = blue > red;
  return (
    <div
      data-testid={`tape-row-${row.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      className="grid grid-cols-[3rem_1fr_8.5rem_1fr_3rem] items-center gap-2"
    >
      <span
        className={cn(
          'text-right font-mono text-sm font-bold tabular-nums',
          redLeads ? 'text-red-400' : 'text-red-400/60',
        )}
      >
        {row.red == null ? EM_DASH : fmt(red)}
      </span>
      <div className="flex h-2.5 justify-end overflow-hidden rounded-full bg-muted-foreground/25">
        <div
          className={cn('h-full rounded-full bg-red-500', !redLeads && 'opacity-60')}
          style={{ width: `${redPct}%` }}
        />
      </div>
      <span className="text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {row.label}
      </span>
      <div className="flex h-2.5 justify-start overflow-hidden rounded-full bg-muted-foreground/25">
        <div
          className={cn('h-full rounded-full bg-blue-500', !blueLeads && 'opacity-60')}
          style={{ width: `${bluePct}%` }}
        />
      </div>
      <span
        className={cn(
          'font-mono text-sm font-bold tabular-nums',
          blueLeads ? 'text-blue-400' : 'text-blue-400/60',
        )}
      >
        {row.blue == null ? EM_DASH : fmt(blue)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team comparison — one row per team, inline data bars per metric.
// ---------------------------------------------------------------------------

interface TeamMetrics {
  team: number;
  nickname: string | null;
  side: 'red' | 'blue';
  scouted: number;
  expected: number;
  fuel: number | null;
  /** Mean teleop INACTIVE-period fuel — the feeding workload signal that used
   *  to live only in the removed Alliance Matchup prose ("feeds heavily"). */
  feed: number | null;
  climbRate: number | null;
  defense: number | null;
  driver: number | null;
  agility: number | null;
  reliability: number | null;
}

interface MetricCol {
  key: keyof Pick<
    TeamMetrics,
    | 'expected'
    | 'fuel'
    | 'feed'
    | 'climbRate'
    | 'defense'
    | 'driver'
    | 'agility'
    | 'reliability'
  >;
  label: string;
  /** Fixed scale max (ratings/rates); undefined = normalize to the matchup max. */
  max?: number;
  fmt: (v: number) => string;
}

const METRIC_COLS: MetricCol[] = [
  { key: 'expected', label: 'Exp pts', fmt: (v) => String(Math.round(v)) },
  { key: 'fuel', label: 'Teleop', fmt: (v) => v.toFixed(0) },
  { key: 'feed', label: 'Feed', fmt: (v) => v.toFixed(0) },
  { key: 'climbRate', label: 'Climb', max: 1, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'defense', label: 'Def', max: 3, fmt: (v) => v.toFixed(1) },
  { key: 'driver', label: 'Driver', max: 3, fmt: (v) => v.toFixed(1) },
  { key: 'agility', label: 'Agility', max: 3, fmt: (v) => v.toFixed(1) },
  { key: 'reliability', label: 'Reliab', max: 1, fmt: (v) => `${Math.round(v * 100)}%` },
];

function MetricCell({
  value,
  max,
  fmt,
  side,
  isBase,
}: {
  value: number | null;
  max: number;
  fmt: (v: number) => string;
  side: 'red' | 'blue';
  isBase: boolean;
}): JSX.Element {
  const pct = value == null || max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span
        className={cn(
          'font-mono text-xs font-semibold tabular-nums',
          value == null ? 'text-muted-foreground/60' : 'text-foreground',
        )}
      >
        {value == null ? EM_DASH : fmt(value)}
      </span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted-foreground/25">
        <div
          className={cn(
            'h-full rounded-full',
            isBase ? 'bg-amber-400' : side === 'red' ? 'bg-red-500' : 'bg-blue-500',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

const GRID = 'grid grid-cols-[minmax(5.5rem,1.4fr)_repeat(8,minmax(0,1fr))] items-end gap-x-3';

function TeamMetricRow({
  m,
  maxima,
  isBase,
}: {
  m: TeamMetrics;
  maxima: Record<string, number>;
  isBase: boolean;
}): JSX.Element {
  return (
    <div
      data-testid={`matchup-dash-team-${m.team}`}
      className={cn(
        'rounded-md px-2 py-1.5',
        GRID,
        isBase && 'bg-amber-400/10 ring-1 ring-amber-400/40',
      )}
    >
      <div className="flex min-w-0 flex-col">
        <span
          className={cn(
            'font-mono text-sm font-bold tabular-nums',
            m.side === 'red' ? 'text-red-400' : 'text-blue-400',
          )}
        >
          {m.team}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {m.nickname ?? ''}
          {m.scouted === 0 ? ' · unscouted' : ` · ${m.scouted} scouted`}
        </span>
      </div>
      {METRIC_COLS.map((col) => (
        <MetricCell
          key={col.key}
          value={m[col.key]}
          max={col.max ?? maxima[col.key]}
          fmt={col.fmt}
          side={m.side}
          isBase={isBase}
        />
      ))}
    </div>
  );
}

export default function MatchupDashboard({
  redTeams,
  blueTeams,
  pred,
  agg,
  reportsByTeam,
  allTeams,
  baseTeam,
  ourSide,
}: MatchupDashboardProps): JSX.Element {
  // ---- Tale of the tape (alliance level) ----------------------------------
  const tape = useMemo<TapeRow[]>(() => {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const anyClimb = (teams: TeamPrediction[]) =>
      teams.some((p) => p.components?.climb != null);
    return [
      { label: 'Projected score', red: pred.red.score, blue: pred.blue.score },
      { label: 'Auto pts', red: sumComponent(pred.red.teams, 'auto'), blue: sumComponent(pred.blue.teams, 'auto') },
      // The `fuel` component is TELEOP fuel points — labeled teleop everywhere.
      { label: 'Teleop pts', red: sumComponent(pred.red.teams, 'fuel'), blue: sumComponent(pred.blue.teams, 'fuel') },
      {
        label: 'Climb pts',
        red: anyClimb(pred.red.teams) ? sumComponent(pred.red.teams, 'climb') : null,
        blue: anyClimb(pred.blue.teams) ? sumComponent(pred.blue.teams, 'climb') : null,
      },
      {
        label: 'Defense impact',
        red: sumComponent(pred.red.teams, 'defense'),
        blue: sumComponent(pred.blue.teams, 'defense'),
      },
      {
        label: 'Climb success',
        red: scoutedMean(redTeams, agg, (a) => a.climbSuccessRate),
        blue: scoutedMean(blueTeams, agg, (a) => a.climbSuccessRate),
        fmt: pct,
      },
      {
        label: 'Reliability',
        red: scoutedMean(redTeams, agg, (a) => a.reliability),
        blue: scoutedMean(blueTeams, agg, (a) => a.reliability),
        fmt: pct,
      },
    ];
  }, [pred, agg, redTeams, blueTeams]);

  // ---- Per-team comparison rows -------------------------------------------
  const teamRows = useMemo<TeamMetrics[]>(() => {
    const predByTeam = new Map<number, TeamPrediction>();
    for (const p of [...pred.red.teams, ...pred.blue.teams]) predByTeam.set(p.teamNumber, p);
    const build = (team: number, side: 'red' | 'blue'): TeamMetrics => {
      const a = agg.get(team);
      const scouted = a?.matchesScouted ?? 0;
      const reports = reportsByTeam?.get(team);
      return {
        team,
        side,
        nickname: allTeams.find((t) => t.team_number === team)?.nickname ?? null,
        scouted,
        expected: predByTeam.get(team)?.expected ?? 0,
        fuel: scouted > 0 && a ? a.meanFuelPoints : null,
        feed: scouted > 0 && a ? a.meanTeleopFuelInactive : null,
        climbRate: scouted > 0 && a ? a.climbSuccessRate : null,
        defense: scouted > 0 && a ? a.avgDefenseRating : null,
        driver: ratedMeanNum(reports, (m) => m.driver_skill),
        agility: ratedMeanNum(reports, (m) => m.agility),
        reliability: scouted > 0 && a ? a.reliability : null,
      };
    };
    return [
      ...redTeams.map((t) => build(t, 'red')),
      ...blueTeams.map((t) => build(t, 'blue')),
    ];
  }, [redTeams, blueTeams, pred, agg, reportsByTeam, allTeams]);

  // Matchup-relative maxima for the unbounded metrics (points).
  const maxima = useMemo(() => {
    const maxOf = (sel: (m: TeamMetrics) => number | null) =>
      Math.max(1e-9, ...teamRows.map((m) => sel(m) ?? 0));
    return {
      expected: maxOf((m) => m.expected),
      fuel: maxOf((m) => m.fuel),
      feed: maxOf((m) => m.feed),
    } as Record<string, number>;
  }, [teamRows]);

  // ---- Chart inputs (lazy recharts section) --------------------------------
  const radar = useMemo<RadarDatum[]>(() => {
    // Each axis normalized so the LEADING alliance = 100 (shape comparison).
    const axis = (label: string, r: number | null, b: number | null): RadarDatum => {
      const max = Math.max(r ?? 0, b ?? 0, 1e-9);
      return {
        metric: label,
        red: Math.round(((r ?? 0) / max) * 100),
        blue: Math.round(((b ?? 0) / max) * 100),
      };
    };
    return [
      axis('Auto', sumComponent(pred.red.teams, 'auto'), sumComponent(pred.blue.teams, 'auto')),
      axis('Teleop', sumComponent(pred.red.teams, 'fuel'), sumComponent(pred.blue.teams, 'fuel')),
      axis('Climb', sumComponent(pred.red.teams, 'climb'), sumComponent(pred.blue.teams, 'climb')),
      axis('Defense', sumComponent(pred.red.teams, 'defense'), sumComponent(pred.blue.teams, 'defense')),
      axis(
        'Reliability',
        scoutedMean(redTeams, agg, (a) => a.reliability),
        scoutedMean(blueTeams, agg, (a) => a.reliability),
      ),
    ];
  }, [pred, agg, redTeams, blueTeams]);

  const contrib = useMemo<ContribDatum[]>(() => {
    const build = (p: TeamPrediction, side: 'red' | 'blue'): ContribDatum => ({
      team: String(p.teamNumber),
      side,
      isBase: p.teamNumber === baseTeam,
      auto: p.components?.auto ?? 0,
      teleop: p.components?.fuel ?? 0,
      climb: p.components?.climb ?? 0,
    });
    return [
      ...pred.red.teams.map((p) => build(p, 'red')),
      ...pred.blue.teams.map((p) => build(p, 'blue')),
    ];
  }, [pred, baseTeam]);

  const sideTag = (side: 'red' | 'blue'): string =>
    ourSide === side ? ' (us)' : ourSide != null ? ' (opponents)' : '';

  return (
    <Card data-testid="matchup-dashboard" className="border-border">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-foreground">Matchup dashboard</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 p-4 pt-1">
        {/* Tale of the tape. */}
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[11px] font-bold uppercase tracking-wider">
            <span className="text-right text-red-400">Red{sideTag('red')}</span>
            <span className="text-muted-foreground">Alliance comparison</span>
            <span className="text-blue-400">Blue{sideTag('blue')}</span>
          </div>
          <div data-testid="matchup-dash-tape" className="flex flex-col gap-1.5">
            {tape.map((row) => (
              <TapeBarRow key={row.label} row={row} />
            ))}
          </div>
        </div>

        {/* Radar + stacked contribution (recharts, lazy chunk). */}
        <Suspense
          fallback={
            <div className="flex min-h-[240px] items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
              Loading charts…
            </div>
          }
        >
          <MatchupCharts radar={radar} contrib={contrib} />
        </Suspense>

        {/* Team comparison table with inline data bars. */}
        <div className="flex flex-col gap-1">
          <div className={cn(GRID, 'px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground')}>
            <span>Team</span>
            {METRIC_COLS.map((c) => (
              <span key={c.key}>{c.label}</span>
            ))}
          </div>
          <div data-testid="matchup-dash-teams" className="flex flex-col gap-1">
            {teamRows.map((m) => (
              <TeamMetricRow
                key={`${m.side}-${m.team}`}
                m={m}
                maxima={maxima}
                isBase={m.team === baseTeam}
              />
            ))}
          </div>
          <p className="px-2 pt-1 text-[10px] text-muted-foreground/70">
            Bars for Exp/Teleop/Feed scale to this matchup's best; Climb/Reliab are 0–100%; Def/Driver/Agility are 0–3.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
