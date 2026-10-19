// src/dash/board/widgets/registry.tsx
// Every live data widget kind for Ryan's Board (mockup 03): its label, icon,
// sizes, default config, eyebrow title and body. Bodies read the shared
// BoardData context, so they update whenever the dashboard's queries do.
// Plan: docs/plans/ryans-board/README.md §10.
import { useEffect, useMemo, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  Bot,
  CalendarRange,
  ClipboardList,
  Columns3,
  ListOrdered,
  Radio,
  Sigma,
  Star,
  Swords,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  METRICS,
  allianceOf,
  isPlayed,
  lastPlayedMatch,
  nextMatchOf,
  resolveMatch,
  resolveTeam,
  resultFor,
  teamMatches,
  useBoardData,
  type BoardData,
  type MetricKey,
} from '@/dash/board/widgets/data';
import { evalStat } from '@/dash/board/widgets/statExpr';
import { countdown, matchLabel, matchTimeMs, useNow } from '@/dash/board/BoardTopBar';
import { blueTeamsOf, redTeamsOf } from '@/dash/matchOrder';
import { teamEpaHistoryForTeam } from '@/dash/useTeamEpaHistory';
import { SEASON_EPA_CLOSURE_VERSION, EPA_STALE_TIME } from '@/dash/seasonEpa';
import { EPA_RECENCY_BOOST } from '@/dash/constants';
import { entryList } from '@/dash/picklistClient';
import type { MatchRow } from '@/dash/useEventData';

export type WidgetKind =
  | 'team'
  | 'match'
  | 'schedule'
  | 'watchlist'
  | 'rankings'
  | 'compare'
  | 'epaHistory'
  | 'onField'
  | 'stat'
  | 'picklist';

export type WidgetConfig = Record<string, unknown>;

export interface WidgetDef {
  kind: WidgetKind;
  label: string;
  icon: LucideIcon;
  defaultConfig: () => WidgetConfig;
  size: (config: WidgetConfig) => { w: number; h: number };
  minSize: { w: number; h: number };
  title: (config: WidgetConfig, data: BoardData) => string;
  /** Eyebrow right side (status chip). */
  aside?: (config: WidgetConfig, data: BoardData, now: number) => ReactNode;
  Body: (props: { config: WidgetConfig }) => JSX.Element;
}

const RED = '#f87171';
const BLUE = '#60a5fa';
const GOOD = 'text-success';

function Chip({ className, children, style }: { className?: string; children: ReactNode; style?: React.CSSProperties }): JSX.Element {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-px text-[11px]', className)} style={style}>
      {children}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">{children}</div>;
}

function fmt(key: MetricKey, v: number | null): string {
  return v == null ? '—' : METRICS[key].format(v);
}

function teamList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function metricList(v: unknown, fallback: MetricKey[]): MetricKey[] {
  if (!Array.isArray(v)) return fallback;
  const keys = v.filter((k): k is MetricKey => typeof k === 'string' && k in METRICS);
  return keys.length ? keys : fallback;
}

// --------------------------------------------------------------------- team
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="min-w-0 rounded-lg bg-muted px-2 py-1.5">
      <div className="truncate text-[10.5px] text-muted-foreground">{label}</div>
      <div className="tnum truncate text-base font-semibold leading-tight">{value}</div>
      {sub && <div className="tnum truncate text-[10.5px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function useTeamsEpaHistory(teams: number[], eventKey: string) {
  const year = eventKey.slice(0, 4);
  // Same query key as useTeamEpaHistory, so the cache is shared with the Team view.
  return useQueries({
    queries: teams.map((team) => ({
      queryKey: ['epa', 'history', SEASON_EPA_CLOSURE_VERSION, eventKey, team, year, EPA_RECENCY_BOOST],
      staleTime: EPA_STALE_TIME,
      retry: false,
      queryFn: () => teamEpaHistoryForTeam(team, eventKey, year),
    })),
  });
}

function Sparkline({ values, color, height = 30, dashed }: { values: number[]; color: string; height?: number; dashed?: boolean }): JSX.Element | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 100;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${height - 2 - ((v - min) / span) * (height - 4)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray={dashed ? '4 4' : undefined} />
    </svg>
  );
}

function TeamBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const now = useNow();
  const team = resolveTeam(config.team, data);
  const compact = config.variant === 'compact';
  const history = useTeamsEpaHistory(team && !compact ? [team] : [], data.eventKey);
  if (team == null) return <Empty>Pick a team in the widget settings.</Empty>;
  const bsr = data.metric(team, 'bsr');
  const variance = data.epa.varianceByTeam?.get(team);
  const st = data.standings.get(team);
  const nick = data.nickname(team);
  if (compact) {
    return (
      <div className="flex h-full items-center gap-2 px-3">
        <span className="tnum font-bold">{team}</span>
        <span className="min-w-0 truncate text-muted-foreground">{nick}</span>
        <span className="tnum ml-auto">{fmt('bsr', bsr)}</span>
        {st && <Chip className="tnum bg-muted text-muted-foreground">#{st.rank}</Chip>}
      </div>
    );
  }
  const next = nextMatchOf(data.matches, team);
  const t = next ? matchTimeMs(next) : null;
  const points = history[0]?.data?.map((p) => p.value) ?? [];
  const agg = data.agg.get(team);
  return (
    <div className="flex h-full flex-col gap-2 px-3 pb-2.5 pt-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="tnum text-xl font-bold">{team}</span>
        <span className="min-w-0 truncate text-muted-foreground">{nick}</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="BSR" value={fmt('bsr', bsr)} sub={variance != null ? `±${Math.sqrt(variance).toFixed(1)}` : undefined} />
        <Stat label="Rank" value={st ? String(st.rank) : '—'} sub={st ? `${st.wins}-${st.losses}-${st.ties}` : undefined} />
        <Stat label="Scouted" value={fmt('scouted', data.metric(team, 'scouted'))} sub={agg?.matchesScouted ? `${agg.matchesScouted} reports` : undefined} />
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Auto" value={fmt('auto', data.metric(team, 'auto'))} />
        <Stat label="Teleop" value={fmt('teleop', data.metric(team, 'teleop'))} />
        <Stat label="Endgame" value={fmt('endgame', data.metric(team, 'endgame'))} />
      </div>
      <div className="min-h-0 flex-1">
        <Sparkline values={points} color="hsl(199 89% 48%)" />
      </div>
      {next && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Next</span>
          <b className="tnum text-foreground">{matchLabel(next.match_key)}</b>
          <AllianceChip side={allianceOf(next, team)} />
          {t != null && <span className="ml-auto">{countdown(t, now)}</span>}
        </div>
      )}
    </div>
  );
}

function AllianceChip({ side }: { side: 'red' | 'blue' | null }): JSX.Element | null {
  if (!side) return null;
  return (
    <Chip style={{ color: side === 'red' ? RED : BLUE, background: side === 'red' ? 'rgba(248,113,113,.13)' : 'rgba(96,165,250,.13)' }}>
      {side}
    </Chip>
  );
}

// -------------------------------------------------------------------- match
function MatchCard({ m, focus }: { m: MatchRow; focus?: number | null }): JSX.Element {
  const data = useBoardData();
  const red = redTeamsOf(m);
  const blue = blueTeamsOf(m);
  const played = isPlayed(m);
  const pred = data.predict(red, blue);
  const redScore = played ? m.actual_red_score! : pred ? Math.round(pred.red.score) : null;
  const blueScore = played ? m.actual_blue_score! : pred ? Math.round(pred.blue.score) : null;
  const redWon = played && m.actual_red_score! > m.actual_blue_score!;
  const blueWon = played && m.actual_blue_score! > m.actual_red_score!;
  const teamsLine = (ts: number[]): ReactNode =>
    ts.map((t, i) => (
      <span key={t}>
        {i > 0 && ' · '}
        <span className={cn(t === focus && 'underline decoration-2 underline-offset-2', t === data.baseTeam && 'font-bold')}>{t}</span>
      </span>
    ));
  return (
    <div className="flex h-full flex-col justify-center gap-1 px-3 pb-2.5 pt-1.5">
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
        <div className="tnum truncate" style={{ color: RED }}>{teamsLine(red)}</div>
        <div className={cn('tnum text-xl font-bold', played && !redWon && 'opacity-55')} style={{ color: RED }}>{redScore ?? '—'}</div>
        <div className="tnum truncate" style={{ color: BLUE }}>{teamsLine(blue)}</div>
        <div className={cn('tnum text-xl font-bold', played && !blueWon && 'opacity-55')} style={{ color: BLUE }}>{blueScore ?? '—'}</div>
      </div>
      {pred && !played && (
        <>
          <div className="mt-1 flex h-1.5 overflow-hidden rounded-full">
            <div style={{ width: `${pred.redWinProb * 100}%`, background: RED }} />
            <div className="flex-1" style={{ background: BLUE }} />
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Red {Math.round(pred.redWinProb * 100)}%</span>
            <span>predicted</span>
            <span>Blue {Math.round((1 - pred.redWinProb) * 100)}%</span>
          </div>
        </>
      )}
      {pred && played && (
        <div className="text-[11px] text-muted-foreground">
          Predicted {Math.round(pred.red.score)}–{Math.round(pred.blue.score)} · {pred.redWinProb >= 0.5 ? `Red ${Math.round(pred.redWinProb * 100)}%` : `Blue ${Math.round((1 - pred.redWinProb) * 100)}%`}
        </div>
      )}
    </div>
  );
}

function MatchBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const m = resolveMatch(config.match, data);
  if (!m) return <Empty>{data.loading ? 'Loading matches…' : 'Match not in this event yet.'}</Empty>;
  return <MatchCard m={m} focus={resolveTeam(config.focus, data)} />;
}

function matchAside(m: MatchRow | null, now: number): ReactNode {
  if (!m) return null;
  if (isPlayed(m)) return <Chip className="bg-muted text-muted-foreground">final</Chip>;
  const t = matchTimeMs(m);
  return t != null ? <Chip className="bg-warning/10 text-warning">{countdown(t, now)}</Chip> : null;
}

// ----------------------------------------------------------------- schedule
function ScheduleBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const now = useNow();
  const team = resolveTeam(config.team, data);
  if (team == null) return <Empty>Pick a team in the widget settings.</Empty>;
  const ms = teamMatches(data.matches, team);
  if (!ms.length) return <Empty>No matches scheduled for {team} yet.</Empty>;
  return (
    <div data-board-scroll className="tnum grid h-full auto-rows-min grid-cols-[auto_auto_1fr] items-center gap-x-2.5 gap-y-1.5 overflow-hidden px-3 py-2 text-xs">
      {ms.map((m) => {
        const r = resultFor(m, team);
        const side = allianceOf(m, team);
        const ours = side === 'red' ? m.actual_red_score : m.actual_blue_score;
        const theirs = side === 'red' ? m.actual_blue_score : m.actual_red_score;
        const t = matchTimeMs(m);
        const pred = !isPlayed(m) ? data.predict(redTeamsOf(m), blueTeamsOf(m)) : null;
        const win = pred ? (side === 'red' ? pred.redWinProb : 1 - pred.redWinProb) : null;
        return (
          <div key={m.match_key} className="contents">
            <span className={cn(!isPlayed(m) && 'text-foreground')}>{matchLabel(m.match_key)}</span>
            <AllianceChip side={side} />
            <span className={cn('text-right', r === 'W' ? GOOD : r === 'L' ? 'text-destructive' : 'text-muted-foreground')}>
              {r ? `${r} ${ours}–${theirs}` : `${t != null ? countdown(t, now) : 'upcoming'}${win != null ? ` · ${Math.round(win * 100)}%` : ''}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- watchlist
type Seen = Record<string, { bsr: number | null; reports: number; last: string | null }>;

function seenKey(eventKey: string): string {
  return `ryans-board-seen:${eventKey}`;
}

function readSeen(eventKey: string): Seen {
  try {
    return JSON.parse(localStorage.getItem(seenKey(eventKey)) ?? '{}') as Seen;
  } catch {
    return {};
  }
}

function WatchlistBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const teams = teamList(config.teams);
  const seen = useMemo(() => readSeen(data.eventKey), [data.eventKey]);
  // Remember what was on screen, so the next visit shows what changed since.
  useEffect(() => {
    const save = (): void => {
      const snap: Seen = { ...readSeen(data.eventKey) };
      for (const t of teams) {
        snap[t] = {
          bsr: data.metric(t, 'bsr'),
          reports: data.agg.get(t)?.matchesScouted ?? 0,
          last: lastPlayedMatch(data.matches, t)?.match_key ?? null,
        };
      }
      try {
        localStorage.setItem(seenKey(data.eventKey), JSON.stringify(snap));
      } catch {
        // per-device convenience only
      }
    };
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      save();
    };
  });
  if (!teams.length) return <Empty>Star teams from the widget settings or search to watch them here.</Empty>;
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      {teams.map((t) => {
        const bsr = data.metric(t, 'bsr');
        const s = seen[t];
        const delta = s?.bsr != null && bsr != null ? bsr - s.bsr : null;
        const reports = data.agg.get(t)?.matchesScouted ?? 0;
        const last = lastPlayedMatch(data.matches, t);
        let badge: ReactNode = null;
        if (s && reports > s.reports) badge = <Chip className="bg-warning/10 text-warning">new report</Chip>;
        else if (s && last && last.match_key !== s.last) badge = <Chip className="bg-muted text-muted-foreground">played {matchLabel(last.match_key)}</Chip>;
        else if (delta != null && Math.abs(delta) >= 0.5)
          badge = (
            <Chip className={delta > 0 ? 'bg-success/10 text-success' : 'bg-destructive/15 text-destructive'}>
              {delta > 0 ? '+' : '−'}
              {Math.abs(delta).toFixed(1)}
            </Chip>
          );
        return (
          <div key={t} className="flex min-w-0 items-center gap-2">
            <span className="tnum w-11 shrink-0 font-semibold">{t}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{data.nickname(t)}</span>
            <span className="tnum">{fmt('bsr', bsr)}</span>
            {badge}
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------- rankings
function RankingsBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const metric = (config.metric as MetricKey) in METRICS ? (config.metric as MetricKey) : 'bsr';
  const count = Math.max(3, Math.min(30, Number(config.count) || 5));
  const asc = config.dir === 'asc' ? true : config.dir === 'desc' ? false : !!METRICS[metric].lowerBetter;
  const rows = useMemo(() => {
    return data.teamNumbers
      .map((t) => ({ t, v: data.metric(t, metric) }))
      .filter((r): r is { t: number; v: number } => r.v != null)
      .sort((a, b) => (asc ? a.v - b.v : b.v - a.v) || a.t - b.t)
      .slice(0, count);
  }, [data, metric, count, asc]);
  if (!rows.length) return <Empty>No {METRICS[metric].label} data yet.</Empty>;
  return (
    <div className="tnum grid auto-rows-min grid-cols-[20px_1fr_auto] gap-x-2 gap-y-1 px-3 py-2">
      {rows.map((r, i) => (
        <div key={r.t} className="contents">
          <span className="text-muted-foreground">{i + 1}</span>
          <span className={cn('truncate', r.t === data.baseTeam && 'text-brand')}>
            {r.t} <span className="font-sans text-xs text-muted-foreground">{data.nickname(r.t)}</span>
          </span>
          <span>{fmt(metric, r.v)}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ compare
const COMPARE_DEFAULT: MetricKey[] = ['bsr', 'auto', 'teleop', 'endgame', 'scouted', 'reliability'];

function CompareBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const teams = teamList(config.teams);
  const metrics = metricList(config.metrics, COMPARE_DEFAULT);
  if (teams.length === 0) return <Empty>Add teams in the widget settings.</Empty>;
  return (
    <div className="tnum grid auto-rows-min gap-x-3 gap-y-1 px-3 py-2 text-xs" style={{ gridTemplateColumns: `minmax(70px,auto) repeat(${teams.length}, minmax(0,1fr))` }}>
      <span />
      {teams.map((t) => (
        <b key={t} className={cn(t === data.baseTeam && 'text-brand')}>{t}</b>
      ))}
      {metrics.map((k) => {
        const vals = teams.map((t) => data.metric(t, k));
        const present = vals.filter((v): v is number => v != null);
        const best = present.length > 1 ? (METRICS[k].lowerBetter ? Math.min(...present) : Math.max(...present)) : null;
        return (
          <div key={k} className="contents">
            <span className="font-sans text-muted-foreground">{METRICS[k].label}</span>
            {vals.map((v, i) => (
              <span key={teams[i]} className={cn(v != null && v === best && GOOD)}>{fmt(k, v)}</span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------- epa history
const SERIES = ['hsl(199 89% 48%)', '#a1a1a1', '#c084fc', '#fb923c'];

function EpaHistoryBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const teams = teamList(config.teams).slice(0, 4);
  const qs = useTeamsEpaHistory(teams, data.eventKey);
  const series = qs.map((q) => q.data?.map((p) => p.value) ?? []);
  if (!teams.length) return <Empty>Add teams in the widget settings.</Empty>;
  const all = series.flat();
  if (all.length < 2) return <Empty>{qs.some((q) => q.isLoading) ? 'Loading history…' : 'No match history yet.'}</Empty>;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const W = 300;
  const H = 100;
  return (
    <div className="flex h-full flex-col px-3 pb-2 pt-1">
      <div className="flex gap-3 text-[11px]">
        {teams.map((t, i) => (
          <span key={t} style={{ color: SERIES[i] }}>— {t}</span>
        ))}
        <span className="tnum ml-auto text-muted-foreground">{min.toFixed(0)}–{max.toFixed(0)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="min-h-0 w-full flex-1" aria-hidden>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="hsl(0 0% 16%)" vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((vals, i) =>
          vals.length > 1 ? (
            <polyline
              key={teams[i]}
              fill="none"
              stroke={SERIES[i]}
              strokeWidth={2.2}
              vectorEffect="non-scaling-stroke"
              strokeDasharray={i === 0 ? undefined : '5 4'}
              points={vals.map((v, j) => `${(j / (vals.length - 1)) * W},${H - 4 - ((v - min) / span) * (H - 8)}`).join(' ')}
            />
          ) : null,
        )}
      </svg>
    </div>
  );
}

// ----------------------------------------------------------------- on field
function OnFieldBody(): JSX.Element {
  const data = useBoardData();
  const st = data.nexus?.status;
  const live = data.nexus?.available && !data.nexus?.stale && st?.onField;
  if (!live || !st?.onField) {
    return <Empty>{data.nexus?.available === false ? 'Live field status is unavailable.' : 'Nothing on the field right now.'}</Empty>;
  }
  return (
    <div className="flex h-full flex-col justify-center gap-0.5 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-success" />
        <span className="eyebrow">{st.onField.label}</span>
      </div>
      <div className="tnum" style={{ color: RED }}>{st.onField.redTeams.join(' · ')}</div>
      <div className="tnum" style={{ color: BLUE }}>{st.onField.blueTeams.join(' · ')}</div>
      {st.queuing && <div className="mt-0.5 text-[11px] text-muted-foreground">Queuing: {st.queuing.label}</div>}
    </div>
  );
}

// --------------------------------------------------------------------- stat
function StatBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const expr = typeof config.expr === 'string' ? config.expr : '';
  const v = evalStat(expr, (team, metric) => data.metric(team === 'our' ? data.baseTeam : team, metric));
  return (
    <div className="flex h-full flex-col justify-center px-3 py-2">
      <div className="tnum truncate text-xs text-muted-foreground">{(config.label as string) || expr || 'Set an expression'}</div>
      <div className="tnum text-3xl font-bold leading-tight">{v == null ? '—' : `${v > 0 && /-/.test(expr) ? '+' : ''}${v.toFixed(1)}`}</div>
      <div className="text-[11px] text-muted-foreground">updates live</div>
    </div>
  );
}

// ----------------------------------------------------------------- picklist
function PicklistBody(): JSX.Element {
  const data = useBoardData();
  const entries = data.picklist ?? [];
  if (!entries.length) return <Empty>The picklist is empty. Build it in the Picklist tab.</Empty>;
  const col = (list: 'first' | 'second', title: string): JSX.Element => {
    const rows = entries.filter((e) => entryList(e) === list && !e.dnp).slice(0, 8);
    return (
      <div className="min-w-0">
        <div className="eyebrow mb-1">{title}</div>
        {rows.map((e, i) => (
          <div key={e.teamNumber} className="tnum flex items-center gap-2 border-b border-border py-1 last:border-0">
            <span className="text-muted-foreground">{i + 1}</span>
            <b>{e.teamNumber}</b>
            <span className="ml-auto text-muted-foreground">{fmt('bsr', data.metric(e.teamNumber, 'bsr'))}</span>
          </div>
        ))}
      </div>
    );
  };
  return (
    <div className="grid h-full grid-cols-2 gap-3 px-3 py-2 text-xs">
      {col('first', '1st pick')}
      {col('second', '2nd pick')}
    </div>
  );
}

// ----------------------------------------------------------------- registry
const teamTitle = (c: WidgetConfig, d: BoardData): string => {
  const t = resolveTeam(c.team, d);
  return c.team === 'base' ? `Team · ${t ?? ''} (us)` : `Team · ${t ?? '—'}`;
};

export const WIDGETS: Record<WidgetKind, WidgetDef> = {
  team: {
    kind: 'team',
    label: 'Team',
    icon: Bot,
    defaultConfig: () => ({ team: 'base', variant: 'detailed' }),
    size: (c) => (c.variant === 'compact' ? { w: 300, h: 46 } : { w: 320, h: 290 }),
    minSize: { w: 200, h: 40 },
    title: teamTitle,
    Body: TeamBody,
  },
  match: {
    kind: 'match',
    label: 'Match',
    icon: Swords,
    defaultConfig: () => ({ match: 'our-next' }),
    size: () => ({ w: 340, h: 156 }),
    minSize: { w: 240, h: 110 },
    title: (c, d) => {
      const m = resolveMatch(c.match, d);
      // 'our-next' falls back to our last match once we have none left.
      const label = c.match === 'our-next' ? (m && isPlayed(m) ? 'Our last' : 'Our next') : 'Match';
      return `${label} · ${m ? matchLabel(m.match_key) : '—'}`;
    },
    aside: (c, d, now) => matchAside(resolveMatch(c.match, d), now),
    Body: MatchBody,
  },
  schedule: {
    kind: 'schedule',
    label: 'Schedule',
    icon: CalendarRange,
    defaultConfig: () => ({ team: 'base' }),
    size: () => ({ w: 320, h: 250 }),
    minSize: { w: 220, h: 100 },
    title: (c, d) => `${resolveTeam(c.team, d) ?? '—'} schedule`,
    Body: ScheduleBody,
  },
  watchlist: {
    kind: 'watchlist',
    label: 'Watchlist',
    icon: Star,
    defaultConfig: () => ({ teams: [] }),
    size: (c) => ({ w: 320, h: 64 + 28 * Math.max(1, teamList(c.teams).length) }),
    minSize: { w: 220, h: 80 },
    title: () => 'Watchlist',
    aside: (c) => <span className="tnum text-[11px] text-muted-foreground">{teamList(c.teams).length} teams</span>,
    Body: WatchlistBody,
  },
  rankings: {
    kind: 'rankings',
    label: 'Rankings',
    icon: ListOrdered,
    defaultConfig: () => ({ metric: 'bsr', count: 5 }),
    size: (c) => ({ w: 270, h: 60 + 24 * Math.max(3, Math.min(30, Number(c.count) || 5)) }),
    minSize: { w: 200, h: 120 },
    title: (c) => `Top ${Math.max(3, Math.min(30, Number(c.count) || 5))} · ${METRICS[(c.metric as MetricKey) in METRICS ? (c.metric as MetricKey) : 'bsr'].label}`,
    Body: RankingsBody,
  },
  compare: {
    kind: 'compare',
    label: 'Compare',
    icon: Columns3,
    defaultConfig: () => ({ teams: [], metrics: COMPARE_DEFAULT }),
    size: (c) => ({ w: Math.max(320, 140 + 70 * teamList(c.teams).length), h: 60 + 22 * metricList(c.metrics, COMPARE_DEFAULT).length }),
    minSize: { w: 240, h: 100 },
    title: () => 'Compare',
    Body: CompareBody,
  },
  epaHistory: {
    kind: 'epaHistory',
    label: 'BSR history',
    icon: TrendingUp,
    defaultConfig: () => ({ teams: [] }),
    size: () => ({ w: 380, h: 200 }),
    minSize: { w: 240, h: 120 },
    title: (c) => `BSR history${teamList(c.teams).length ? ` · ${teamList(c.teams).join(' vs ')}` : ''}`,
    Body: EpaHistoryBody,
  },
  onField: {
    kind: 'onField',
    label: 'On field',
    icon: Radio,
    defaultConfig: () => ({}),
    size: () => ({ w: 300, h: 130 }),
    minSize: { w: 220, h: 100 },
    title: () => 'On field now',
    Body: OnFieldBody,
  },
  stat: {
    kind: 'stat',
    label: 'Stat tile',
    icon: Sigma,
    defaultConfig: () => ({ expr: 'our.bsr', label: '' }),
    size: () => ({ w: 220, h: 120 }),
    minSize: { w: 150, h: 90 },
    title: () => 'Stat',
    Body: StatBody,
  },
  picklist: {
    kind: 'picklist',
    label: 'Picklist',
    icon: ClipboardList,
    defaultConfig: () => ({}),
    size: () => ({ w: 420, h: 250 }),
    minSize: { w: 260, h: 140 },
    title: () => 'Picklist',
    aside: () => <span className="text-[11px] text-muted-foreground">synced with Picklist tab</span>,
    Body: PicklistBody,
  },
};

export const WIDGET_KINDS = Object.keys(WIDGETS) as WidgetKind[];

export function widgetDef(kind: string): WidgetDef | null {
  return (WIDGETS as Record<string, WidgetDef>)[kind] ?? null;
}

export function widgetMinSize(kind: string): { w: number; h: number } {
  return widgetDef(kind)?.minSize ?? { w: 120, h: 60 };
}
