// src/dash/MatchView.tsx
// MATCHVIEW — staff-facing match drill-down / cross-check. List the event's
// matches (friendly labels + per-match report count); tap one to see EVERY
// report on that match across stations / teams / scouters. Tap a report row to
// open the FULL per-report detail in a Sheet. Field-Control Console styling.

import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Grid3x3,
  Flame,
  Shield,
  ChevronRight,
  AlertTriangle,
  Activity,
  Crosshair,
  CheckCircle2,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/utils';
import { TeamLink } from '@/components/ui/TeamLink';
import { formatMatchKeyRaw, compareMatchKeys } from '@/lib/formatMatch';
import { tbaGetOptional, isUnavailable, type ProxyUnavailable } from '@/dash/proxies';
import {
  useEventMatches,
  useEventReports,
  useEventScouts,
  type MatchRow,
} from '@/dash/useEventData';
import { useMatchStream } from '@/dash/matchStream';
import { useEventScoutCoverage } from '@/dash/useMatchScoutCoverage';
import { COVERAGE_STATION_CAP } from '@/dash/aggregate';
import { relativeTime } from '@/dash/relativeTime';
import { msrReportIdentity, type MatchScoutCoverage } from '@/dash/types';
import ReportDetail from '@/dash/ReportDetail';
import TeamTimeline, { TimelineAxis, TimelineLegend } from '@/dash/TeamTimeline';
import MatchVideo, { type MatchVideoStreamProps } from '@/dash/MatchVideo';
import { winnerText } from '@/dash/MatchScorePanel';
import { MATCH_MS } from '@/dash/matchTimeline';
import ConflictMarker from '@/components/ConflictMarker';
import { useMultiScoutConflicts } from '@/dash/useMultiScoutConflicts';
import {
  validateMatchVsTba,
  validationLabel,
  type AllianceScoreCheck,
  type TbaValidationSeverity,
} from '@/dash/validateVsTba';
import type { MsrRow, MultiScoutGroup } from '@/dash/types';
import { QUALITATIVE_RATING_MAX } from '@/ratings';

export interface MatchViewProps {
  eventKey: string;
  /**
   * Match to preselect — e.g. when deep-linked from a team's last-match card.
   * Syncs the selection when it changes; manual list clicks still drive after.
   */
  initialMatchKey?: string | null;
  /**
   * Notifies the parent (DashboardScreen) of a manual match selection so it
   * survives a tab switch — the parent holds the key and feeds it back via
   * `initialMatchKey` when this view remounts.
   */
  onSelectMatch?: (matchKey: string) => void;
}

const CONTROL_MIN_HEIGHT = 56; // px — touch target floor

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/**
 * Result sync stamps played matches after writing both official scores. Keep
 * the complete-score fallback because cached/demo rows can legitimately carry
 * scores without the sync timestamp.
 */
function hasPlayedResult(match: MatchRow): boolean {
  const hasCompleteScore =
    match.actual_red_score != null && match.actual_blue_score != null;
  return hasCompleteScore || match.result_synced_at != null;
}

/** Friendly station label, e.g. "Red 1". */
function stationLabel(r: MsrRow): string {
  const color = r.alliance_color.charAt(0).toUpperCase() + r.alliance_color.slice(1);
  return `${color} ${r.station}`;
}

function MatchTimelines(props: {
  reports: MsrRow[];
  currentTimeMs?: number | null;
}): JSX.Element {
  const { reports, currentTimeMs } = props;
  const ordered = reports
    .slice()
    .sort((a, b) => a.alliance_color.localeCompare(b.alliance_color) || a.station - b.station);
  // One card under the video: a label column + compact track per robot, with a
  // single shared second-tick axis and legend instead of one per row.
  return (
    <Card data-testid="match-timelines-section" className="border-border bg-card">
      <CardHeader className="flex flex-row flex-wrap items-center gap-x-4 gap-y-2 space-y-0 p-3 pb-2 sm:px-4">
        <CardTitle className="flex items-center gap-2 text-base text-foreground">
          <Activity className="size-4 text-brand" />
          Activity
        </CardTitle>
        <TimelineLegend className="ml-auto text-xs" />
      </CardHeader>
      <CardContent className="p-3 pt-0 sm:px-4">
        <ul data-testid="match-timelines" className="flex flex-col gap-1.5">
          {ordered.map((r, i) => (
            <li
              key={`${r.target_team_number}-${r.station}-${i}`}
              data-testid={`match-timeline-${r.target_team_number}-${r.station}`}
              className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2"
            >
              <span className="flex flex-col text-sm font-semibold leading-tight tabular-nums">
                <TeamLink
                  team={r.target_team_number}
                  className={r.alliance_color === 'red' ? 'text-red-400' : 'text-blue-400'}
                />
                <span className="text-[11px] font-normal text-muted-foreground">
                  {stationLabel(r)}
                </span>
              </span>
              <TeamTimeline report={r} currentTimeMs={currentTimeMs} compact />
            </li>
          ))}
        </ul>
        <div className="mt-1 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
          <span />
          <TimelineAxis className="text-xs" />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Video card with the synced-playback controls. The raw video position (seconds)
 * and the alignment offset (seconds) live in MatchView; here we only render the
 * embed + a "sync to match start" control and a live readout so a lead can line
 * the playhead up with auto. matchMs = (videoSeconds - offset) * 1000 is computed
 * by the parent and fed to every timeline.
 */
function MatchVideoCard(props: {
  matchKey: string;
  videoSeconds: number | null;
  offsetSeconds: number;
  onTimeMs: (ms: number) => void;
  onSyncNow: () => void;
  onResetSync: () => void;
  /** Livestream fallback (see matchStream.ts) when TBA has no match video. */
  stream?: MatchVideoStreamProps | null;
  onStreamActive?: (active: boolean) => void;
}): JSX.Element {
  const {
    matchKey,
    videoSeconds,
    offsetSeconds,
    onTimeMs,
    onSyncNow,
    onResetSync,
    stream,
    onStreamActive,
  } = props;
  const hasTime = videoSeconds != null && Number.isFinite(videoSeconds);
  const matchSecs = hasTime ? Math.max(0, (videoSeconds as number) - offsetSeconds) : null;
  return (
    <Card className="border-border bg-card">
      <CardContent className="flex flex-col gap-2 p-2 sm:p-3">
        {/* As big as the column allows, but never taller than the viewport. */}
        <div
          className="mx-auto w-full"
          style={{ maxWidth: 'min(100%, calc((100vh - 8rem) * 16 / 9))' }}
        >
          <MatchVideo
            matchKey={matchKey}
            onTimeMs={onTimeMs}
            stream={stream}
            onStreamActive={onStreamActive}
          />
        </div>
        <div
          data-testid="match-video-sync"
          className="flex flex-wrap items-center justify-between gap-2 px-1 text-sm"
        >
          <span className="inline-flex items-center gap-2 tabular-nums text-muted-foreground">
            <Crosshair className="size-4 text-brand" />
            {hasTime ? (
              <>
                <span>video {(videoSeconds as number).toFixed(1)}s</span>
                <span className="text-foreground">· match {(matchSecs as number).toFixed(1)}s</span>
                {offsetSeconds !== 0 ? <span>· offset {offsetSeconds.toFixed(1)}s</span> : null}
              </>
            ) : (
              <span>Play the video, then sync to match start.</span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              data-testid="match-sync-now"
              disabled={!hasTime}
              onClick={onSyncNow}
              className="rounded-md border border-border bg-muted/40 px-3 py-1.5 font-medium text-foreground hover:bg-muted/70 disabled:opacity-50"
            >
              Sync to match start
            </button>
            {offsetSeconds !== 0 ? (
              <button
                type="button"
                data-testid="match-sync-reset"
                onClick={onResetSync}
                className="rounded-md border border-border bg-muted/30 px-3 py-1.5 text-muted-foreground hover:bg-muted/60"
              >
                Reset
              </button>
            ) : null}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/** robotKey, kept local so the tile loop can look conflict groups up O(1). */
function robotKeyOf(r: MsrRow): string {
  return `${r.match_key}|${r.target_team_number}|${r.alliance_color}|${r.station}`;
}

/** Left-border + tint classes for a conflicted member tile. */
function conflictTileClass(group: MultiScoutGroup | undefined): string {
  if (!group || !group.isConflicted) return '';
  return group.severity === 'severe'
    ? 'border-l-4 border-l-destructive bg-destructive/5'
    : 'border-l-4 border-l-warning bg-warning/5';
}

function MatchDetail(props: {
  reports: MsrRow[];
  coverage: MatchScoutCoverage;
  scoutName: (id: string | null | undefined) => string;
  onOpenReport: (r: MsrRow) => void;
  byRobotKey: Map<string, MultiScoutGroup>;
  nowMs: number;
}): JSX.Element {
  const { reports, coverage, scoutName, onOpenReport, byRobotKey, nowMs } = props;
  // Track which robotKeys have already emitted their group header (header-once).
  const seenHeaders = new Set<string>();

  return (
    <Card data-testid="match-scout-status" className="border-border bg-card">
      <CardHeader className="flex flex-row flex-wrap items-center gap-x-4 gap-y-2 space-y-0 p-3 pb-2 sm:px-4">
        <CardTitle className="text-base text-foreground">Reports ({reports.length})</CardTitle>
        {/* Scouting-status heartbeat on the title line: stations + synced + last report. */}
        <ScoutingStatusSummary reports={reports} coverage={coverage} nowMs={nowMs} />
      </CardHeader>
      <CardContent>
        {reports.length === 0 ? (
          <div data-testid="match-empty" className="text-sm text-muted-foreground">
            No reports submitted for this match yet.
          </div>
        ) : (
          // Red and blue side by side on wide screens. Test-id indices stay the
          // global station-sorted position so they don't depend on the split.
          <div
            data-testid="match-detail"
            className="grid grid-cols-1 gap-x-4 gap-y-1.5 lg:grid-cols-2"
          >
            {(['red', 'blue'] as const).map((color) => {
              const rows = reports
                .slice()
                .sort((a, b) => a.station - b.station)
                .map((r, i) => ({ r, i }))
                .filter(({ r }) => r.alliance_color === color);
              if (rows.length === 0) return null;
              return (
                <ul key={color} className="flex flex-col gap-1.5">
                  {rows.map(({ r, i }) => {
                    const flags = [
                      r.no_show ? 'no-show' : null,
                      r.died ? 'died' : null,
                      r.tipped ? 'tipped' : null,
                    ].filter(Boolean);
                    // Multi-scout group for this robot (2+ scouts on it). Emit the
                    // group header chip immediately before the FIRST member tile.
                    const rKey = robotKeyOf(r);
                    const group = byRobotKey.get(rKey);
                    let header: JSX.Element | null = null;
                    if (group && !seenHeaders.has(rKey)) {
                      seenHeaders.add(rKey);
                      header = (
                        <li
                          key={`conflict-${rKey}`}
                          data-testid={`match-conflict-${r.target_team_number}-${r.station}`}
                        >
                          <ConflictMarker variant="chip" group={group} showDetail />
                        </li>
                      );
                    }
                    return (
                      <React.Fragment key={`${r.target_team_number}-${r.station}-${i}`}>
                        {header}
                        <li>
                          {/* A div with button semantics (not <button>) so the team
                              number inside can be its own link without nesting
                              interactive elements. */}
                          <div
                            role="button"
                            tabIndex={0}
                            data-testid={`match-report-${r.target_team_number}-${r.station}-${i}`}
                            onClick={() => onOpenReport(r)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                onOpenReport(r);
                              }
                            }}
                            style={{ minHeight: CONTROL_MIN_HEIGHT }}
                            className={cn(
                              'grid w-full cursor-pointer grid-cols-[4.5rem_minmax(0,1fr)_auto_auto] items-center gap-x-3 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                              conflictTileClass(group),
                            )}
                          >
                            <span className="flex flex-col font-semibold leading-tight tabular-nums">
                              <TeamLink
                                team={r.target_team_number}
                                className={color === 'red' ? 'text-red-400' : 'text-blue-400'}
                              />
                              <span className="text-[11px] font-normal text-muted-foreground">
                                {color} {r.station}
                              </span>
                            </span>
                            <span className="flex min-w-0 flex-col leading-tight">
                              {/* Who + when it reached the server; an unattributed
                                  report is flagged so it isn't read as roster coverage. */}
                              <span
                                className={cn(
                                  'truncate',
                                  r.scout_id ? 'text-muted-foreground' : 'text-warning',
                                )}
                              >
                                by {scoutName(r.scout_id)}
                                {r.server_received_at ? (
                                  <time
                                    dateTime={r.server_received_at}
                                    className="text-xs text-muted-foreground"
                                  >
                                    {' '}
                                    · {relativeTime(r.server_received_at, nowMs)}
                                  </time>
                                ) : null}
                              </span>
                              {flags.length ? (
                                <span className="inline-flex items-center gap-1 text-xs text-warning">
                                  <AlertTriangle className="size-3.5" /> {flags.join(' · ')}
                                </span>
                              ) : null}
                            </span>
                            <span className="flex items-center gap-3 tabular-nums text-muted-foreground">
                              <span className="inline-flex items-center gap-1" title="Fuel points">
                                <Flame className="size-4 text-energy" /> {fmt(r.fuel_points)}
                              </span>
                              <span
                                className="inline-flex items-center gap-1"
                                title="Defense rating"
                              >
                                <Shield className="size-4 text-brand" />{' '}
                                {r.defense_rating > 0
                                  ? `${r.defense_rating}/${QUALITATIVE_RATING_MAX}`
                                  : '—'}
                              </span>
                            </span>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                          </div>
                        </li>
                      </React.Fragment>
                    );
                  })}
                </ul>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** TBA `/match/{key}` is only consulted for the (optional) per-alliance RP. */
interface TbaScoreBreakdownSide {
  rp?: unknown;
}
interface TbaMatchResult {
  score_breakdown?: {
    red?: TbaScoreBreakdownSide | null;
    blue?: TbaScoreBreakdownSide | null;
  } | null;
}

/** Finite `rp` for one alliance from a TBA score_breakdown, else null. */
function rpFromBreakdown(
  data: TbaMatchResult | ProxyUnavailable | undefined,
  side: 'red' | 'blue',
): number | null {
  if (!data || isUnavailable(data)) return null;
  const bd = data.score_breakdown?.[side];
  const rp = bd?.rp;
  return typeof rp === 'number' && Number.isFinite(rp) ? rp : null;
}

/** Text tone for one alliance's scouted-vs-official line, by severity. */
function validationText(s: TbaValidationSeverity): string {
  switch (s) {
    case 'severe':
      return 'text-destructive';
    case 'minor':
      return 'text-warning';
    case 'match':
      return 'text-success';
    default:
      return 'text-muted-foreground';
  }
}

/** One side of the result header: score + RP/win chips, teams, scouted check. */
function AllianceResult(props: {
  side: 'red' | 'blue';
  teams: (number | null)[];
  score: number | null;
  rp: number | null;
  won: boolean;
  check: AllianceScoreCheck | null;
}): JSX.Element {
  const { side, teams, score, rp, won, check } = props;
  const right = side === 'blue';
  const color = side === 'red' ? 'text-red-400' : 'text-blue-400';
  const chips = (
    <>
      {won ? (
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
            side === 'red' ? 'bg-red-500/20 text-red-300' : 'bg-blue-500/20 text-blue-300',
          )}
        >
          Win
        </span>
      ) : null}
      {rp != null ? (
        <span
          data-testid={`match-results-rp-${side}`}
          className={cn(
            'text-xs tabular-nums',
            side === 'red' ? 'text-red-400/90' : 'text-blue-400/90',
          )}
        >
          {side === 'red' ? 'Red' : 'Blue'} {rp} RP
        </span>
      ) : null}
    </>
  );
  const deltaText =
    check?.delta == null ? null : `${check.delta > 0 ? '+' : ''}${Math.round(check.delta)}`;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', right && 'items-end text-right')}>
      <div className={cn('flex items-baseline gap-2', right && 'flex-row-reverse')}>
        <span className={cn('font-mono text-3xl font-black leading-none tabular-nums', color)}>
          {score ?? '—'}
        </span>
        {chips}
      </div>
      <div className={cn('flex flex-wrap gap-x-2 font-mono text-sm', right && 'justify-end')}>
        {teams.map((t, i) =>
          t != null ? (
            <TeamLink key={i} team={t} className={cn(color, 'hover:opacity-80')} />
          ) : (
            <span key={i} className="text-muted-foreground">
              —
            </span>
          ),
        )}
      </div>
      {check && check.scoutedRobots > 0 ? (
        <span
          data-testid={`match-validation-${side}`}
          title={validationLabel(check.severity)}
          className="text-xs tabular-nums text-muted-foreground"
        >
          Scouted <span className="text-foreground">{Math.round(check.scoutedOffensePoints)}</span>{' '}
          {deltaText != null ? (
            <span
              data-testid={`match-validation-${side}-delta`}
              className={validationText(check.severity)}
            >
              ({deltaText})
            </span>
          ) : null}
          {check.scoutedRobots < 3 ? <span> · {check.scoutedRobots}/3 bots</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One-line match result header: both alliances' final score, RP, winner and
 * the scouted-vs-official check (validate-scout-data-vs-TBA) folded under each
 * score. Score/winner come straight off the MatchRow; RP reuses MatchVideo's
 * `['tba','match',key]` query (deduped) and is omitted when TBA has none. The
 * scouted sum runs a bit under official by design (we don't scout fouls etc.),
 * so only large gaps are tinted. Unplayed → teams plus "Not played yet".
 */
function MatchResultsCard(props: { match: MatchRow; reports: MsrRow[] }): JSX.Element {
  const { match, reports } = props;
  const redScore = match.actual_red_score;
  const blueScore = match.actual_blue_score;
  const played = redScore != null && blueScore != null;

  const tbaQuery = useQuery({
    queryKey: ['tba', 'match', match.match_key],
    enabled: played,
    staleTime: 5 * 60_000,
    queryFn: (): Promise<TbaMatchResult | ProxyUnavailable> =>
      tbaGetOptional<TbaMatchResult>(`/match/${match.match_key}`),
  });
  const validation = useMemo(
    () => validateMatchVsTba(match.match_key, reports, redScore, blueScore),
    [match.match_key, redScore, blueScore, reports],
  );
  const winner = match.winner;
  const text = winnerText(winner);
  const redTeams = [match.red1, match.red2, match.red3];
  const blueTeams = [match.blue1, match.blue2, match.blue3];

  return (
    <Card data-testid="match-results" className="border-border bg-card">
      <CardContent className="p-3 sm:px-5">
        <div
          data-testid={played ? 'match-results-score' : 'match-results-unplayed'}
          className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3"
        >
          <AllianceResult
            side="red"
            teams={redTeams}
            score={played ? redScore : null}
            rp={played ? rpFromBreakdown(tbaQuery.data, 'red') : null}
            won={winner === 'red'}
            check={played ? validation.red : null}
          />
          <div className="flex flex-col items-center gap-0.5 text-center">
            <span className="font-semibold text-foreground">
              {formatMatchKeyRaw(match.match_key)}
            </span>
            <span data-testid="match-results-winner" className="text-xs text-muted-foreground">
              {played ? (text ?? 'Final') : 'Not played yet'}
            </span>
          </div>
          <AllianceResult
            side="blue"
            teams={blueTeams}
            score={played ? blueScore : null}
            rp={played ? rpFromBreakdown(tbaQuery.data, 'blue') : null}
            won={winner === 'blue'}
            check={played ? validation.blue : null}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** Tone for the compact scouting-status pill, by coverage fullness. */
function statusTone(covered: number, total: number): string {
  if (total > 0 && covered >= total) return 'border-success/40 bg-success/10 text-success';
  if (covered > 0) return 'border-warning/40 bg-warning/10 text-warning';
  return 'border-border bg-muted/40 text-muted-foreground';
}

/**
 * Scouting-status SUMMARY (dashboard-heartbeat, one line): station coverage pill
 * and per-alliance / synced / last-report counts. Who reported (and when) lives on
 * each report row below. Pure / prop-driven; `nowMs` ticks via the parent so
 * relative stamps stay fresh.
 */
function ScoutingStatusSummary(props: {
  reports: MsrRow[];
  coverage: MatchScoutCoverage;
  nowMs: number;
}): JSX.Element {
  const { reports, coverage, nowMs } = props;
  const rel = relativeTime(coverage.lastReportAt, nowMs);
  const coveredByAlliance = {
    red: new Set(
      reports
        .filter((report) => report.alliance_color === 'red')
        .map((report) => report.station),
    ).size,
    blue: new Set(
      reports
        .filter((report) => report.alliance_color === 'blue')
        .map((report) => report.station),
    ).size,
  };
  // Coverage fullness is measured in STATIONS (6 per match), the same metric the
  // pill and the heartbeat tile show — never scout-count (a 5-scout roster still
  // covers 6 stations). BUG-9: the pill read "0/6 stations" but the tone keyed
  // off scoutsCovered/scoutsTotal, conflating the two.
  const stations = Math.min(coverage.stationsCovered, COVERAGE_STATION_CAP);
  const full = stations >= COVERAGE_STATION_CAP;
  const tone = statusTone(stations, COVERAGE_STATION_CAP);

  const countColor = full
    ? 'text-success'
    : stations > 0
      ? 'text-warning'
      : 'text-muted-foreground';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs font-medium tabular-nums',
          tone,
        )}
      >
        {full ? <CheckCircle2 className="size-3.5" /> : <Activity className="size-3.5" />}
        <span className={countColor}>
          {stations}/{COVERAGE_STATION_CAP}
        </span>{' '}
        stations
      </span>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        Red {coveredByAlliance.red}/3 · Blue {coveredByAlliance.blue}/3 · {coverage.scoutsCovered}{' '}
        synced · {rel}
      </span>
    </div>
  );
}

/** A clock that re-renders every `intervalMs` so the heartbeat stamps stay fresh. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function MatchView(props: MatchViewProps): JSX.Element {
  const { eventKey, initialMatchKey, onSelectMatch } = props;
  const [selected, setSelected] = useState<string | null>(initialMatchKey ?? null);
  const [openReportId, setOpenReportId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true); // collapsible match list
  const selectedEventRef = useRef(eventKey);

  // Synced-video state. `videoSeconds` is the raw YT playback position; `offset`
  // is the video time we treat as match t=0 (pre-roll alignment). Both reset
  // whenever the selected match changes (handled in selectMatch).
  const [videoSeconds, setVideoSeconds] = useState<number | null>(null);
  const [offsetSeconds, setOffsetSeconds] = useState(0);

  // Detail pane ref so selecting a match on mobile (where the list stacks ABOVE
  // the detail) scrolls the video/reports into view instead of leaving them
  // below a long match list. On desktop the detail is a side pane, so no scroll.
  const detailRef = useRef<HTMLDivElement>(null);

  const selectMatch = (matchKey: string): void => {
    setSelected(matchKey);
    setOpenReportId(null);
    onSelectMatch?.(matchKey); // persist across tab switches (parent holds it)
    setVideoSeconds(null);
    setOffsetSeconds(0);
    const isNarrow = window.matchMedia?.('(max-width: 1023px)')?.matches;
    if (isNarrow) {
      requestAnimationFrame(() =>
        detailRef.current?.scrollIntoView?.({
          behavior: 'smooth',
          block: 'start',
        }),
      );
    }
  };

  useEffect(() => {
    if (selectedEventRef.current === eventKey) return;
    selectedEventRef.current = eventKey;
    // Match keys, detail state, and video alignment are event-scoped. Clear the
    // previous event synchronously on a scope change so the new event can choose
    // its own latest-played default.
    setSelected(null);
    setOpenReportId(null);
    setSearch('');
    setVideoSeconds(null);
    setOffsetSeconds(0);
  }, [eventKey]);

  // Sync from the incoming deep-link prop (e.g. a click on a team's last-match
  // card) without clobbering manual list clicks: only when the prop names a
  // real, different match. Resets the synced-video state for the new match.
  useEffect(() => {
    if (
      initialMatchKey != null &&
      initialMatchKey.startsWith(`${eventKey}_`) &&
      initialMatchKey !== selected
    ) {
      setSelected(initialMatchKey);
      setOpenReportId(null);
      setVideoSeconds(null);
      setOffsetSeconds(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventKey, initialMatchKey]);

  // matchMs = (videoSeconds - offset) * 1000, clamped to [0, MATCH_MS]. Null when
  // we have no live video time → timelines render with no playhead.
  const currentTimeMs = useMemo(() => {
    if (videoSeconds == null || !Number.isFinite(videoSeconds)) return null;
    const ms = (videoSeconds - offsetSeconds) * 1000;
    return Math.max(0, Math.min(MATCH_MS, ms));
  }, [videoSeconds, offsetSeconds]);

  const matchesQuery = useEventMatches(eventKey);
  const reportsQuery = useEventReports(eventKey);
  const scoutsQuery = useEventScouts(eventKey);
  // Scout-coverage (dashboard-heartbeat): per-match scout coverage map for the
  // left-list markers + the ScoutingStatusCard. Reuses the cached queries.
  const scoutCoverage = useEventScoutCoverage(eventKey);
  const now = useNow();

  const loading = matchesQuery.isLoading || reportsQuery.isLoading;
  const matches = matchesQuery.data ?? [];
  const reports = reportsQuery.data ?? [];
  const openReport = openReportId
    ? (reports.find((report) => msrReportIdentity(report) === openReportId) ?? null)
    : null;
  const scouts = scoutsQuery.data ?? [];

  const latestPlayedMatchKey = useMemo(() => {
    const played = matches
      .filter(hasPlayedResult)
      .sort((a, b) => compareMatchKeys(a.match_key, b.match_key));
    return played[played.length - 1]?.match_key ?? null;
  }, [matches]);

  // Supply a useful initial selection once result data arrives. The null guard
  // makes this a one-time default in practice: a manual selection, an incoming
  // deep link, or the first auto-default all prevent later result refreshes
  // from moving the user to a different match.
  useEffect(() => {
    if (
      selected == null &&
      (initialMatchKey == null || !initialMatchKey.startsWith(`${eventKey}_`)) &&
      latestPlayedMatchKey != null
    ) {
      setSelected(latestPlayedMatchKey);
    }
  }, [eventKey, initialMatchKey, latestPlayedMatchKey, selected]);

  const countByMatch = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of reports) m.set(r.match_key, (m.get(r.match_key) ?? 0) + 1);
    return m;
  }, [reports]);

  // Order quals → playoffs in play order (so EVERY playoff match sits below the
  // quals), then filter by the search box. The single search matches a team
  // number (any of the 6 alliance slots) OR the match label/number — e.g. "254",
  // "Qual 12", "Semi 3" — with no mode toggle.
  const visibleMatches = useMemo(() => {
    const sorted = matches.slice().sort((a, b) => compareMatchKeys(a.match_key, b.match_key));
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((m) => {
      if (formatMatchKeyRaw(m.match_key).toLowerCase().includes(q)) return true;
      const teams = [m.red1, m.red2, m.red3, m.blue1, m.blue2, m.blue3];
      return teams.some((t) => t != null && String(t).includes(q));
    });
  }, [matches, search]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scouts) m.set(s.id, s.display_name ?? '(unnamed)');
    return m;
  }, [scouts]);
  const scoutName = (id: string | null | undefined): string =>
    id ? (nameById.get(id) ?? '(unknown)') : 'unassigned';

  const selectedReports = useMemo(
    () =>
      selected != null
        ? reports
            .filter((r) => r.match_key === selected)
            .sort(
              (a, b) =>
                a.alliance_color.localeCompare(b.alliance_color) ||
                a.station - b.station ||
                msrReportIdentity(a).localeCompare(msrReportIdentity(b)),
            )
        : [],
    [reports, selected],
  );

  const selectedMatch = useMemo(
    () => (selected != null ? (matches.find((m) => m.match_key === selected) ?? null) : null),
    [matches, selected],
  );

  // Livestream fallback for the video card (matchStream.ts): the day's YouTube
  // stream seeked to this match when TBA has no match video.
  const matchStream = useMatchStream(eventKey, selectedMatch, setOffsetSeconds);

  // Coverage for the selected match: from the event map (or a zeroed default
  // carrying the real roster size when the match has no reports yet).
  const selectedCoverage: MatchScoutCoverage | null = useMemo(() => {
    if (selected == null) return null;
    const found = scoutCoverage.coverageByMatch.get(selected);
    if (found) return found;
    return {
      matchKey: selected,
      scoutsCovered: 0,
      scoutsTotal: scoutCoverage.scoutsTotal,
      lastReportAt: null,
      reportedScoutIds: [],
      missingScouts: scouts.map((s) => ({
        id: s.id,
        display_name: s.display_name ?? null,
      })),
      unattributed: 0,
      stationsCovered: 0,
    };
  }, [selected, scoutCoverage, scouts]);

  // Multi-scout conflicts, scoped to the SELECTED match's reports only — a
  // whole-event byRobotKey would span unrelated matches. The hook memoizes the
  // detection so it recomputes only when selectedReports identity changes.
  const { byRobotKey } = useMultiScoutConflicts(selectedReports);
  const openConflictGroup =
    openReport != null
      ? byRobotKey.get(
          `${openReport.match_key}|${openReport.target_team_number}|${openReport.alliance_color}|${openReport.station}`,
        )
      : undefined;

  return (
    <div data-testid="dash-match" className="flex flex-col gap-4 text-foreground">
      {loading ? (
        <div data-testid="match-loading" className="text-sm text-muted-foreground">
          Loading event data…
        </div>
      ) : (
        <div
          className={cn(
            'grid grid-cols-1 items-start gap-4',
            sidebarOpen
              ? 'lg:grid-cols-[15rem_minmax(0,1fr)]'
              : 'lg:grid-cols-[2.75rem_minmax(0,1fr)]',
          )}
        >
          {!sidebarOpen ? (
            // Collapsed: a thin sticky rail on desktop (the match gets the
            // width); a plain button row on phones.
            <button
              type="button"
              data-testid="match-sidebar-expand"
              onClick={() => setSidebarOpen(true)}
              aria-label="Show match list"
              title="Show match list"
              className="flex items-center gap-2 self-start rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60 lg:sticky lg:top-4 lg:flex-col lg:px-0 lg:py-3"
            >
              <PanelLeft className="size-4 text-brand" />
              <span className="lg:hidden">Matches ({matches.length})</span>
              {selected != null ? (
                <span className="hidden font-mono text-xs text-brand [writing-mode:vertical-rl] lg:inline">
                  {formatMatchKeyRaw(selected)}
                </span>
              ) : null}
            </button>
          ) : (
            <Card className="border-border bg-card lg:sticky lg:top-4">
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <div className="flex items-center gap-2">
                  <Grid3x3 className="size-5 text-brand" />
                  <CardTitle className="text-foreground">Matches ({matches.length})</CardTitle>
                </div>
                <button
                  type="button"
                  data-testid="match-sidebar-collapse"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Collapse match list"
                  title="Collapse match list"
                  className="flex size-8 items-center justify-center rounded-lg border border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                >
                  <PanelLeftClose className="size-4" />
                </button>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {matches.length === 0 ? (
                  <div data-testid="match-none" className="text-sm text-muted-foreground">
                    No matches scheduled for this event yet.
                  </div>
                ) : (
                  <>
                    <input
                      type="search"
                      inputMode="search"
                      data-testid="match-search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Team # or match…"
                      aria-label="Search matches by team or match number"
                      className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    {visibleMatches.length === 0 ? (
                      <div
                        data-testid="match-search-empty"
                        className="text-sm text-muted-foreground"
                      >
                        No matches match your search.
                      </div>
                    ) : (
                      <ul
                        data-testid="match-list"
                        className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto pr-1 lg:max-h-[75vh]"
                      >
                        {visibleMatches.map((m) => {
                          const count = countByMatch.get(m.match_key) ?? 0;
                          const isSel = selected === m.match_key;
                          const label = formatMatchKeyRaw(m.match_key);
                          // Coverage marker: ✓ once the match reaches full station
                          // coverage, a partial dot otherwise. expected = min(cap, cap)
                          // so a full 6-station match shows the ✓.
                          const cov = scoutCoverage.coverageByMatch.get(m.match_key);
                          const stationsCovered = cov?.stationsCovered ?? 0;
                          const fullyCovered = stationsCovered >= COVERAGE_STATION_CAP;
                          return (
                            <li key={m.match_key}>
                              <button
                                type="button"
                                data-testid={`match-item-${m.match_key}`}
                                onClick={() => selectMatch(m.match_key)}
                                style={{ minHeight: CONTROL_MIN_HEIGHT }}
                                className={cn(
                                  'flex w-full items-center justify-between rounded-lg border px-3 py-1.5 text-left text-sm',
                                  isSel
                                    ? 'border-brand/60 bg-brand/10 text-foreground'
                                    : 'border-border bg-muted/30 text-foreground hover:bg-muted/60',
                                )}
                              >
                                <span className="font-semibold">{label}</span>
                                <span className="flex items-center gap-1.5">
                                  <span
                                    data-testid={`match-coverage-${m.match_key}`}
                                    title={
                                      fullyCovered
                                        ? `Full station coverage (${stationsCovered}/${COVERAGE_STATION_CAP})`
                                        : `Partial coverage (${stationsCovered}/${COVERAGE_STATION_CAP} stations)`
                                    }
                                    className={cn(
                                      'text-xs',
                                      fullyCovered ? 'text-success/60' : 'text-warning/70',
                                    )}
                                  >
                                    {fullyCovered ? '✓' : '•'}
                                  </span>
                                  <span
                                    title={`${count} report${count === 1 ? '' : 's'}`}
                                    className={cn(
                                      'text-xs tabular-nums',
                                      count === 0 ? 'text-warning' : 'text-success',
                                    )}
                                  >
                                    {count}
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          <div ref={detailRef} className="flex scroll-mt-4 flex-col gap-4">
            {selected != null ? (
              <>
                {/* Video on top, activity timelines next (so they can be read
                    alongside the video), reports below — stacked. Sits in the
                    main pane so it's visible the moment a match is picked, no
                    scrolling past the match list. */}
                <div data-testid="match-detail-grid" className="flex flex-col gap-4">
                  {/* REAL match results (known-true score/winner) lead the pane,
                      full-width on top — the alliance/score block from the Team
                      tab's last-match card. */}
                  {selectedMatch ? (
                    <MatchResultsCard match={selectedMatch} reports={selectedReports} />
                  ) : null}
                  {/* Big video, then activity timelines, then reports. */}
                  <MatchVideoCard
                    matchKey={selected}
                    videoSeconds={videoSeconds}
                    offsetSeconds={offsetSeconds}
                    onTimeMs={(ms) => setVideoSeconds(ms / 1000)}
                    stream={matchStream.streamProps}
                    onStreamActive={matchStream.onStreamActive}
                    onSyncNow={() => {
                      if (videoSeconds == null) return;
                      setOffsetSeconds(videoSeconds);
                      matchStream.syncNow(videoSeconds);
                    }}
                    onResetSync={() => setOffsetSeconds(0)}
                  />
                  {selectedReports.length > 0 ? (
                    <MatchTimelines reports={selectedReports} currentTimeMs={currentTimeMs} />
                  ) : null}
                  {selectedCoverage ? (
                    <MatchDetail
                      reports={selectedReports}
                      coverage={selectedCoverage}
                      scoutName={scoutName}
                      onOpenReport={(report) => setOpenReportId(msrReportIdentity(report))}
                      byRobotKey={byRobotKey}
                      nowMs={now}
                    />
                  ) : null}
                </div>
              </>
            ) : (
              <div data-testid="match-prompt" className="text-sm text-muted-foreground">
                Pick a match to compare every report on it.
              </div>
            )}
          </div>
        </div>
      )}

      <Sheet
        open={openReport != null}
        onClose={() => setOpenReportId(null)}
        side="right"
        title={
          openReport ? (
            <>
              {formatMatchKeyRaw(openReport.match_key)} · Team{' '}
              <TeamLink
                team={openReport.target_team_number}
                onClick={() => setOpenReportId(null)}
              />
            </>
          ) : (
            ''
          )
        }
        data-testid="match-report-sheet"
      >
        {openReport ? (
          <ReportDetail
            report={openReport}
            scoutName={scoutName(openReport.scout_id)}
            conflictGroup={openConflictGroup}
            siblingName={scoutName}
            onOpenSibling={(report) => setOpenReportId(msrReportIdentity(report))}
          />
        ) : null}
      </Sheet>
    </div>
  );
}
