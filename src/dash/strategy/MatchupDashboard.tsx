// src/dash/strategy/MatchupDashboard.tsx
// Strategy-tab analytics below the win-probability strip: each opponent's share
// of their alliance's predicted points, a "tale of the tape" (mirrored red↔blue
// alliance bars per metric), and ONE six-team table — predicted points and
// their auto/teleop/defense split, scouted metrics with inline data bars, the
// prediction source, and each team's red flags. It replaces the old per-alliance
// prediction cards, the radar, and the contribution chart, which all repeated
// the same numbers.
//
// Pure presentation over data the tab already computes (predictMatch output,
// aggregateEvent map, raw reports, async EPA-drop flags) — no new queries,
// dependency-free CSS bars.

import { useMemo } from 'react';
import { AlertTriangle, Crosshair, Scale, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { TeamLink } from '@/components/ui/TeamLink';
import type { TeamAgg } from '@/dash/aggregate';
import type { MatchPrediction, TeamPrediction } from '@/dash/predict';
import type { TeamRow } from '@/dash/useEventData';
import type { MsrRow } from '@/dash/types';
import { defenseTimeShare, teamRedFlags, type RedFlag } from '@/dash/strategy/redFlags';
import { SOURCE_CLASS, SOURCE_LABEL } from '@/dash/strategy/PredictionPanel';

export interface MatchupDashboardProps {
  redTeams: number[];
  blueTeams: number[];
  pred: MatchPrediction;
  agg: Map<number, TeamAgg>;
  reportsByTeam?: Map<number, MsrRow[]>;
  allTeams: TeamRow[];
  baseTeam: number;
  ourSide: 'red' | 'blue' | null;
  /** Per-team async flags (season EPA drop), merged into each team's flags. */
  flagsByTeam?: Map<number, RedFlag>;
}

const EM_DASH = '—';

/** Numeric mean of a 1–10 super-scout rating (0/null excluded); null when unrated. */
function ratedMeanNum(
  reports: MsrRow[] | undefined,
  sel: (m: MsrRow) => number | null | undefined,
): number | null {
  if (!reports) return null;
  const vals = reports.map(sel).filter((v): v is number => typeof v === 'number' && v > 0);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function sumComponent(teams: TeamPrediction[], key: 'auto' | 'fuel' | 'defense'): number | null {
  const values = teams
    .map((prediction) => prediction.components?.[key])
    .filter((value): value is number => value != null && Number.isFinite(value));
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
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
    // Narrower center label + tighter gaps on phones so the bars stay visible.
    <div
      data-testid={`tape-row-${row.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      className="grid grid-cols-[2.5rem_1fr_5.5rem_1fr_2.5rem] items-center gap-1.5 sm:grid-cols-[3rem_1fr_8.5rem_1fr_3rem] sm:gap-2"
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
      <span className="text-center text-[10px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground sm:text-[11px]">
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
// Team table — one row per team, inline data bars per metric.
// ---------------------------------------------------------------------------

interface TeamMetrics {
  team: number;
  nickname: string | null;
  side: 'red' | 'blue';
  scouted: number;
  source: TeamPrediction['source'];
  expected: number | null;
  /** Predicted point split (predictMatch components); null when unknown. */
  auto: number | null;
  teleop: number | null;
  defPts: number | null;
  /** Mean teleop INACTIVE-period fuel — the feeding workload signal. */
  feed: number | null;
  defense: number | null;
  /** Fraction of teleop spent playing defense (timed intervals); null untimed. */
  defTime: number | null;
  driver: number | null;
  agility: number | null;
  reliability: number | null;
  flags: RedFlag[];
}

type MetricKey =
  | 'expected'
  | 'auto'
  | 'teleop'
  | 'defPts'
  | 'feed'
  | 'defense'
  | 'defTime'
  | 'driver'
  | 'agility'
  | 'reliability';

interface MetricCol {
  key: MetricKey;
  label: string;
  /** Fixed scale max (ratings/rates); undefined = normalize to the matchup max. */
  max?: number;
  fmt: (v: number) => string;
}

const int = (v: number): string => String(Math.round(v));
const COL = {
  expected: { key: 'expected', label: 'Exp pts', fmt: int },
  auto: { key: 'auto', label: 'Auto', fmt: int },
  teleop: { key: 'teleop', label: 'Teleop', fmt: int },
  defPts: { key: 'defPts', label: 'Def pts', fmt: int },
  feed: { key: 'feed', label: 'Feed', fmt: int },
  defense: { key: 'defense', label: 'Def', max: 10, fmt: (v) => v.toFixed(1) },
  defTime: {
    key: 'defTime',
    label: 'Def time',
    max: 1,
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  driver: { key: 'driver', label: 'Driver', max: 10, fmt: (v) => v.toFixed(1) },
  agility: {
    key: 'agility',
    label: 'Agility',
    max: 10,
    fmt: (v) => v.toFixed(1),
  },
  reliability: {
    key: 'reliability',
    label: 'Reliab',
    max: 1,
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
} satisfies Record<MetricKey, MetricCol>;
/** The predicted split, kept together so its numbers read as one breakdown. */
const SPLIT_COLS: MetricCol[] = [COL.auto, COL.teleop, COL.defPts];
const SCOUTED_COLS: MetricCol[] = [
  COL.feed,
  COL.defense,
  COL.defTime,
  COL.driver,
  COL.agility,
  COL.reliability,
];
const ALL_COLS: MetricCol[] = [COL.expected, ...SPLIT_COLS, ...SCOUTED_COLS];

function MetricCell({
  value,
  max,
  col,
  side,
  isBase,
  valueTestId,
}: {
  value: number | null;
  max: number;
  col: MetricCol;
  side: 'red' | 'blue';
  isBase: boolean;
  valueTestId?: string;
}): JSX.Element {
  const pct = value == null || max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {/* Shown inside the cell on phones (the shared header row is md+ only). */}
      <span className="truncate text-[9px] font-bold uppercase tracking-wider text-muted-foreground md:hidden">
        {col.label}
      </span>
      <span
        data-testid={valueTestId}
        className={cn(
          'font-mono text-xs font-semibold tabular-nums',
          value == null ? 'text-muted-foreground/60' : 'text-foreground',
        )}
      >
        {value == null ? EM_DASH : col.fmt(value)}
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

// One-row-per-team dense grid on md+; phones get a per-team card with the
// metrics in a labeled 3-column grid. Shared by the header and team rows so the
// md track templates can never drift apart.
const GRID_MD =
  'md:grid-cols-[minmax(7.5rem,1.6fr)_repeat(10,minmax(0,1fr))] md:items-end md:gap-x-3 md:gap-y-0';

function TeamMetricRow({
  m,
  maxima,
  isBase,
}: {
  m: TeamMetrics;
  maxima: Record<string, number>;
  isBase: boolean;
}): JSX.Element {
  const cell = (col: MetricCol, valueTestId?: string) => (
    <MetricCell
      key={col.key}
      value={m[col.key]}
      max={col.max ?? maxima[col.key]}
      col={col}
      side={m.side}
      isBase={isBase}
      valueTestId={valueTestId}
    />
  );
  return (
    <div
      data-testid={`dash-next-team-${m.team}`}
      className={cn(
        'grid grid-cols-3 gap-x-3 gap-y-1.5 rounded-md border border-border/50 bg-card/40 px-2 py-2 md:border-transparent md:bg-transparent md:py-1.5',
        GRID_MD,
        isBase && 'border-amber-400/40 bg-amber-400/10 md:border-amber-400/40 md:bg-amber-400/10',
      )}
    >
      <div
        data-testid={`matchup-dash-team-${m.team}`}
        className="col-span-3 flex min-w-0 flex-col md:col-span-1"
      >
        <span className="flex items-center gap-1.5">
          <TeamLink
            team={m.team}
            className={cn(
              'font-mono text-sm font-bold',
              m.side === 'red' ? 'text-red-400' : 'text-blue-400',
            )}
          />
          {isBase ? (
            <span
              data-testid="dash-next-us-chip"
              className="rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none text-neutral-900"
            >
              us
            </span>
          ) : null}
          <span
            data-testid="dash-next-source-badge"
            className={cn(
              'rounded-full border px-1.5 py-px text-[10px] font-medium leading-none',
              SOURCE_CLASS[m.source],
            )}
          >
            {SOURCE_LABEL[m.source]}
          </span>
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {m.nickname ?? ''}
          {m.scouted === 0 ? ' · unscouted' : ` · ${m.scouted} scouted`}
        </span>
      </div>
      {cell(COL.expected, 'dash-next-team-expected')}
      {/* display:contents keeps the split cells on the grid while grouping them. */}
      <div data-testid={`dash-next-components-${m.team}`} className="contents">
        {SPLIT_COLS.map((col) => cell(col))}
      </div>
      {SCOUTED_COLS.map((col) => cell(col))}
      {m.flags.length > 0 ? (
        <ul
          data-testid={`dash-next-flags-${m.team}`}
          className="col-span-full flex flex-wrap gap-1.5 md:pt-1"
        >
          {m.flags.map((f) => (
            <li
              key={f.kind}
              data-severity={f.severity}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]',
                f.severity === 'high'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-warning/40 bg-warning/10 text-warning',
              )}
            >
              <AlertTriangle className="size-3 shrink-0" />
              {f.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Each robot's share of its alliance's predicted points, biggest first. */
function PointsByRobot({
  sides,
  pred,
  ourSide,
}: {
  sides: ('red' | 'blue')[];
  pred: MatchPrediction;
  ourSide: 'red' | 'blue' | null;
}): JSX.Element {
  return (
    <Card data-testid="matchup-points-by-robot" className="border-0 bg-transparent shadow-none sm:border sm:border-border sm:bg-card">
      <CardHeader className="px-0 pb-2 pt-0 sm:p-4 sm:pb-2">
        <CardTitle className="flex items-center gap-2 text-base text-foreground">
          <Crosshair className="size-4 text-brand" />
          {ourSide ? 'Their points by robot' : 'Points by robot'}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-0 pt-1 sm:p-4 sm:pt-1">
        {sides.map((side) => {
          const teams = pred[side].teams
            .filter((t) => t.source !== 'none' && Number.isFinite(t.expected) && t.expected > 0)
            .sort((a, b) => b.expected - a.expected);
          const total = teams.reduce((sum, t) => sum + t.expected, 0);
          const top = teams[0]?.expected ?? 0;
          return (
            <ul key={side} className="flex flex-col gap-1.5" data-testid={`matchup-points-${side}`}>
              {teams.length === 0 ? (
                <li className="text-sm text-muted-foreground">{EM_DASH}</li>
              ) : (
                teams.map((t) => (
                  <li
                    key={t.teamNumber}
                    className="grid grid-cols-[3.5rem_minmax(0,1fr)_2.75rem] items-center gap-2"
                  >
                    <TeamLink
                      team={t.teamNumber}
                      className={cn(
                        'font-mono text-sm font-bold',
                        side === 'red' ? 'text-red-400' : 'text-blue-400',
                      )}
                    />
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted-foreground/20">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          side === 'red' ? 'bg-red-500' : 'bg-blue-500',
                        )}
                        style={{ width: `${(t.expected / top) * 100}%` }}
                      />
                    </div>
                    <span className="text-right font-mono text-sm tabular-nums text-foreground">
                      {Math.round((t.expected / total) * 100)}%
                    </span>
                  </li>
                ))
              )}
            </ul>
          );
        })}
      </CardContent>
    </Card>
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
  flagsByTeam,
}: MatchupDashboardProps): JSX.Element {
  // ---- Tale of the tape (alliance level; projected score lives in the strip) --
  const tape = useMemo<TapeRow[]>(() => {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    return [
      {
        label: 'Auto pts',
        red: sumComponent(pred.red.teams, 'auto'),
        blue: sumComponent(pred.blue.teams, 'auto'),
      },
      // The `fuel` component is TELEOP fuel points — labeled teleop everywhere.
      {
        label: 'Teleop pts',
        red: sumComponent(pred.red.teams, 'fuel'),
        blue: sumComponent(pred.blue.teams, 'fuel'),
      },
      {
        label: 'Defense impact',
        red: sumComponent(pred.red.teams, 'defense'),
        blue: sumComponent(pred.blue.teams, 'defense'),
      },
      {
        label: 'Reliability',
        red: scoutedMean(redTeams, agg, (a) => a.reliability),
        blue: scoutedMean(blueTeams, agg, (a) => a.reliability),
        fmt: pct,
      },
    ];
  }, [pred, agg, redTeams, blueTeams]);

  // ---- Per-team rows ---------------------------------------------------------
  const teamRows = useMemo<TeamMetrics[]>(() => {
    const predByTeam = new Map<number, TeamPrediction>();
    for (const p of [...pred.red.teams, ...pred.blue.teams]) predByTeam.set(p.teamNumber, p);
    const build = (team: number, side: 'red' | 'blue'): TeamMetrics => {
      const a = agg.get(team);
      const scouted = a?.matchesScouted ?? 0;
      const reports = reportsByTeam?.get(team);
      const p = predByTeam.get(team);
      const source = p?.source ?? 'none';
      const known = source !== 'none';
      const comp = (v: number | null | undefined) =>
        known && v != null && Number.isFinite(v) ? v : null;
      // Pre-match "must know" flags from the reports + agg, merged with the async
      // season EPA-drop signal; high severity first.
      const extra = flagsByTeam?.get(team);
      const flags = [...teamRedFlags(reports ?? [], a), ...(extra ? [extra] : [])].sort(
        (x, y) => Number(y.severity === 'high') - Number(x.severity === 'high'),
      );
      return {
        team,
        side,
        nickname: allTeams.find((t) => t.team_number === team)?.nickname ?? null,
        scouted,
        source,
        expected: known && p && Number.isFinite(p.expected) ? p.expected : null,
        auto: comp(p?.components?.auto),
        teleop: comp(p?.components?.fuel),
        defPts: comp(p?.components?.defense),
        feed: scouted > 0 && a ? a.meanTeleopFuelInactive : null,
        defense: scouted > 0 && a ? a.avgDefenseRating : null,
        defTime: defenseTimeShare(reports ?? []),
        driver: ratedMeanNum(reports, (m) => m.driver_skill),
        agility: ratedMeanNum(reports, (m) => m.agility),
        reliability: scouted > 0 && a ? a.reliability : null,
        flags,
      };
    };
    return [...redTeams.map((t) => build(t, 'red')), ...blueTeams.map((t) => build(t, 'blue'))];
  }, [redTeams, blueTeams, pred, agg, reportsByTeam, allTeams, flagsByTeam]);

  // Matchup-relative maxima for the unbounded (points) metrics.
  const maxima = useMemo(() => {
    const out: Record<string, number> = {};
    for (const col of ALL_COLS) {
      if (col.max == null) out[col.key] = Math.max(1e-9, ...teamRows.map((m) => m[col.key] ?? 0));
    }
    return out;
  }, [teamRows]);

  const sideTag = (side: 'red' | 'blue'): string =>
    ourSide === side ? ' (us)' : ourSide != null ? ' (opponents)' : '';
  const threatSides: ('red' | 'blue')[] =
    ourSide === 'red' ? ['blue'] : ourSide === 'blue' ? ['red'] : ['red', 'blue'];

  return (
    <div data-testid="matchup-dashboard" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <PointsByRobot sides={threatSides} pred={pred} ourSide={ourSide} />
        <Card className="border-0 bg-transparent shadow-none sm:border sm:border-border sm:bg-card">
          <CardHeader className="px-0 pb-2 pt-0 sm:p-4 sm:pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-foreground">
              <Scale className="size-4 text-brand" />
              Tale of the tape
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 px-0 pt-1 sm:p-4 sm:pt-1">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[11px] font-bold uppercase tracking-wider">
              <span className="text-right text-red-400">Red{sideTag('red')}</span>
              <span />
              <span className="text-blue-400">Blue{sideTag('blue')}</span>
            </div>
            <div data-testid="matchup-dash-tape" className="flex flex-col gap-1.5">
              {tape.map((row) => (
                <TapeBarRow key={row.label} row={row} />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-0 bg-transparent shadow-none sm:border sm:border-border sm:bg-card">
        <CardHeader className="px-0 pb-2 pt-0 sm:p-4 sm:pb-2">
          <CardTitle className="flex items-center gap-2 text-base text-foreground">
            <Users className="size-4 text-brand" />
            Teams
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 px-0 pt-1 sm:p-4 sm:pt-1">
          <div
            className={cn(
              'hidden md:grid',
              GRID_MD,
              // border-transparent matches the team rows' border box so the
              // header columns align exactly.
              'border border-transparent px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground',
            )}
          >
            <span>Team</span>
            {ALL_COLS.map((c) => (
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
        </CardContent>
      </Card>
    </div>
  );
}
