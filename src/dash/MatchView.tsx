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
  Mountain,
  Shield,
  ChevronRight,
  AlertTriangle,
  Activity,
  Video,
  Crosshair,
  Trophy,
  CheckCircle2,
  ChevronDown,
  PanelLeftClose,
  PanelLeft,
  Scale,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/utils';
import { formatMatchKeyRaw, compareMatchKeys } from '@/lib/formatMatch';
import { tbaGetOptional, isUnavailable, type ProxyUnavailable } from '@/dash/proxies';
import {
  useEventMatches,
  useEventReports,
  useEventScouts,
  type MatchRow,
} from '@/dash/useEventData';
import { useEventScoutCoverage } from '@/dash/useMatchScoutCoverage';
import { COVERAGE_STATION_CAP } from '@/dash/aggregate';
import { relativeTime } from '@/dash/relativeTime';
import { msrReportIdentity, type MatchScoutCoverage } from '@/dash/types';
import ReportDetail from '@/dash/ReportDetail';
import TeamTimeline from '@/dash/TeamTimeline';
import MatchVideo from '@/dash/MatchVideo';
import { MatchScorePanel } from '@/dash/MatchScorePanel';
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
  // Bare (no Card) so it can be embedded BELOW the video inside the shared
  // "Match video & activity" block. Separated from the video by a top border.
  return (
    <div
      data-testid="match-timelines-section"
      className="flex flex-col gap-3 border-t border-border pt-4"
    >
      <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Activity className="size-4 text-brand" />
        Activity timelines
      </div>
      <ul data-testid="match-timelines" className="flex flex-col gap-4">
        {ordered.map((r, i) => (
          <li
            key={`${r.target_team_number}-${r.station}-${i}`}
            data-testid={`match-timeline-${r.target_team_number}-${r.station}`}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-center gap-2 text-sm font-semibold tabular-nums text-foreground">
              <span>Team {r.target_team_number}</span>
              <span className="text-muted-foreground">· {stationLabel(r)}</span>
            </div>
            <TeamTimeline report={r} currentTimeMs={currentTimeMs} />
          </li>
        ))}
      </ul>
    </div>
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
  /** Activity timelines, embedded under the video so they read as one block. */
  children?: React.ReactNode;
}): JSX.Element {
  const { matchKey, videoSeconds, offsetSeconds, onTimeMs, onSyncNow, onResetSync } = props;
  const hasTime = videoSeconds != null && Number.isFinite(videoSeconds);
  const matchSecs = hasTime ? Math.max(0, (videoSeconds as number) - offsetSeconds) : null;
  return (
    <Card className="border-border bg-card">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Video className="size-5 text-brand" />
        <CardTitle className="text-foreground">Match video &amp; activity</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Cap the video width so it never dominates the viewport / pushes the
            report list below the fold; 16:9 box keeps height bounded. */}
        <div className="mx-auto w-full max-w-xl">
          <MatchVideo matchKey={matchKey} onTimeMs={onTimeMs} />
        </div>
        <div
          data-testid="match-video-sync"
          className="flex flex-wrap items-center justify-between gap-2 text-sm"
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
        {props.children}
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
      <CardHeader className="space-y-2">
        <CardTitle className="text-foreground">Reports on this match ({reports.length})</CardTitle>
        {/* Scouting-status heartbeat, folded in atop the report tiles: the slim
            summary pill (stations + synced + last-report), the dense reported
            row, and the collapsed "N not reported" roster toggle. */}
        <ScoutingStatusSummary
          reports={reports}
          coverage={coverage}
          scoutName={scoutName}
          nowMs={nowMs}
        />
      </CardHeader>
      <CardContent>
        {reports.length === 0 ? (
          <div data-testid="match-empty" className="text-sm text-muted-foreground">
            No reports submitted for this match yet.
          </div>
        ) : (
          <ul data-testid="match-detail" className="flex flex-col gap-2">
            {reports
              .slice()
              .sort((a, b) => a.station - b.station)
              .map((r, i) => {
                const climb = r.climb_success ? `L${r.climb_level}` : 'no climb';
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
                    <button
                      type="button"
                      data-testid={`match-report-${r.target_team_number}-${r.station}-${i}`}
                      onClick={() => onOpenReport(r)}
                      style={{ minHeight: CONTROL_MIN_HEIGHT }}
                      className={cn(
                        'flex w-full flex-col gap-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-left text-sm text-foreground hover:bg-muted/60',
                        conflictTileClass(group),
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 font-semibold tabular-nums">
                          Team {r.target_team_number} ·{' '}
                          <span
                            className={
                              r.alliance_color === 'red' ? 'text-red-400' : 'text-blue-400'
                            }
                          >
                            {r.alliance_color} {r.station}
                          </span>
                        </span>
                        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                          <span className="truncate">by {scoutName(r.scout_id)}</span>
                          <ChevronRight className="size-4 shrink-0" />
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                        <span className="inline-flex flex-wrap items-center gap-3">
                          <span className="inline-flex items-center gap-1">
                            <Flame className="size-4 text-energy" /> {fmt(r.fuel_points)}
                          </span>
                          <span
                            className={cn(
                              'inline-flex items-center gap-1',
                              r.climb_success && 'text-success',
                            )}
                          >
                            <Mountain className="size-4" /> {climb}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Shield className="size-4 text-brand" />{' '}
                            {r.defense_rating > 0
                              ? `${r.defense_rating}/${QUALITATIVE_RATING_MAX}`
                              : '—'}
                          </span>
                        </span>
                        {flags.length ? (
                          <span className="inline-flex items-center gap-1 text-warning">
                            <AlertTriangle className="size-4" /> {flags.join(' · ')}
                          </span>
                        ) : null}
                      </div>
                    </button>
                    </li>
                  </React.Fragment>
                );
              })}
          </ul>
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

/**
 * Real Match-results card — shown only for PLAYED matches. Final score + winner
 * are KNOWN-true (straight off the MatchRow that `useEventMatches` already
 * fetched, no extra request). Ranking Points are OPTIONAL: we read them off the
 * SAME `['tba','match',key]` query MatchVideo uses (deduped by TanStack), and
 * render them only when TBA gives a finite per-alliance `rp` — otherwise omit
 * (never fabricate). Unplayed → a small "Not played yet" note. Degrades offline:
 * a failed/unavailable TBA fetch simply drops the RP line.
 */
function MatchResultsCard(props: { match: MatchRow }): JSX.Element {
  const { match } = props;
  const redScore = match.actual_red_score;
  const blueScore = match.actual_blue_score;
  const played = redScore != null && blueScore != null;

  // REUSE MatchVideo's query key so the TBA match object is fetched once.
  const tbaQuery = useQuery({
    queryKey: ['tba', 'match', match.match_key],
    enabled: played,
    staleTime: 5 * 60_000,
    queryFn: (): Promise<TbaMatchResult | ProxyUnavailable> =>
      tbaGetOptional<TbaMatchResult>(`/match/${match.match_key}`),
  });
  const redRp = rpFromBreakdown(tbaQuery.data, 'red');
  const blueRp = rpFromBreakdown(tbaQuery.data, 'blue');

  const winner = match.winner; // 'red' | 'blue' | 'tie' | null

  return (
    <Card data-testid="match-results" className="border-border bg-card">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Trophy className="size-5 text-energy" />
        <CardTitle className="text-foreground">Match results</CardTitle>
      </CardHeader>
      <CardContent>
        {!played ? (
          <div data-testid="match-results-unplayed" className="text-sm text-muted-foreground">
            Not played yet.
          </div>
        ) : (
          <MatchScorePanel
            redTeams={[match.red1, match.red2, match.red3]}
            blueTeams={[match.blue1, match.blue2, match.blue3]}
            redScore={redScore}
            blueScore={blueScore}
            winner={winner}
            testidPrefix="match-results"
            bordered={false}
            footer={
              redRp != null || blueRp != null ? (
                <div className="flex items-center justify-center gap-4 text-xs tabular-nums text-muted-foreground">
                  {redRp != null ? (
                    <span data-testid="match-results-rp-red" className="text-red-400/90">
                      Red {redRp} RP
                    </span>
                  ) : null}
                  {blueRp != null ? (
                    <span data-testid="match-results-rp-blue" className="text-blue-400/90">
                      Blue {blueRp} RP
                    </span>
                  ) : null}
                </div>
              ) : null
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

/** Tint classes for one alliance's TBA-validation row, by severity. */
function validationTone(s: TbaValidationSeverity): string {
  switch (s) {
    case 'severe':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    case 'minor':
      return 'border-warning/40 bg-warning/10 text-warning';
    case 'match':
      return 'border-success/40 bg-success/10 text-success';
    default:
      // incomplete / unscouted / unscored — neutral, informational.
      return 'border-border bg-muted/40 text-muted-foreground';
  }
}

/** One alliance's scouted-vs-official line. */
function ValidationRow(props: { check: AllianceScoreCheck }): JSX.Element {
  const { check } = props;
  const colorLabel = check.allianceColor === 'red' ? 'Red' : 'Blue';
  const deltaText =
    check.delta == null ? null : `${check.delta > 0 ? '+' : ''}${Math.round(check.delta)}`;
  const Icon = check.severity === 'match' ? CheckCircle2 : AlertTriangle;
  const showIcon = check.severity === 'match' || check.severity === 'minor' || check.severity === 'severe';
  return (
    <div
      data-testid={`match-validation-${check.allianceColor}`}
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm',
        validationTone(check.severity),
      )}
    >
      <span className="inline-flex items-center gap-1.5 font-semibold">
        {showIcon ? <Icon className="size-4" /> : null}
        <span className={check.allianceColor === 'red' ? 'text-red-400' : 'text-blue-400'}>
          {colorLabel}
        </span>
        <span className="text-foreground">{validationLabel(check.severity)}</span>
      </span>
      <span className="inline-flex items-center gap-2 tabular-nums text-muted-foreground">
        <span>
          scouted <span className="text-foreground">{Math.round(check.scoutedOffensePoints)}</span>
        </span>
        <span>·</span>
        <span>
          official <span className="text-foreground">{check.officialScore ?? '—'}</span>
        </span>
        {deltaText != null ? (
          <span data-testid={`match-validation-${check.allianceColor}-delta`}>({deltaText})</span>
        ) : null}
        {check.scoutedRobots < 3 ? <span>· {check.scoutedRobots}/3 bots</span> : null}
      </span>
    </div>
  );
}

/**
 * Scout-vs-official cross-check (validate-scout-data-vs-TBA). Shown only for a
 * PLAYED match that has at least one scout report: sums each alliance's scouted
 * offensive points (fuel + climb) and compares to the official TBA score,
 * flagging gaps. Honest framing — official totals include points we never scout
 * (mobility, fouls awarded), so the scouted sum runs a bit under by design; this
 * catches gross errors (a missed/duplicated robot, a fat-fingered count), not
 * exact reconciliation. Degrades to nothing when unplayed / unscouted.
 */
function ScoreValidationCard(props: { match: MatchRow; reports: MsrRow[] }): JSX.Element | null {
  const { match, reports } = props;
  const played = match.actual_red_score != null && match.actual_blue_score != null;
  const validation = useMemo(
    () => validateMatchVsTba(match.match_key, reports, match.actual_red_score, match.actual_blue_score),
    [match.match_key, match.actual_red_score, match.actual_blue_score, reports],
  );
  // Nothing to say until the match is played AND someone scouted it.
  if (!played) return null;
  if (validation.red.scoutedRobots === 0 && validation.blue.scoutedRobots === 0) return null;

  return (
    <Card data-testid="match-validation" className="border-border bg-card">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Scale className="size-5 text-brand" />
        <CardTitle className="text-foreground">Scout data vs official</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ValidationRow check={validation.red} />
        <ValidationRow check={validation.blue} />
        <p className="text-xs text-muted-foreground">
          Scouted = our captured fuel + climb points. Official totals also include mobility and
          fouls we don&apos;t scout, so a small gap is normal — large gaps flag a missed robot or a
          mis-captured count.
        </p>
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
 * Scouting-status SUMMARY (dashboard-heartbeat, compact): a coverage rail plus
 * a responsive status roster. Server rows are definitively "synced"; roster
 * members without one remain "not reported" because another device's pending /
 * failed outbox state is not observable here. Pure / prop-driven; `nowMs` ticks
 * via the parent so relative stamps stay fresh.
 */
function ScoutingStatusSummary(props: {
  reports: MsrRow[];
  coverage: MatchScoutCoverage;
  scoutName: (id: string | null | undefined) => string;
  nowMs: number;
}): JSX.Element {
  const { reports, coverage, scoutName, nowMs } = props;
  const [showMissing, setShowMissing] = useState(false);
  const rel = relativeTime(coverage.lastReportAt, nowMs);
  const reported = reports.slice().sort(
    (a, b) =>
      a.alliance_color.localeCompare(b.alliance_color) ||
      a.station - b.station ||
      a.target_team_number - b.target_team_number ||
      msrReportIdentity(a).localeCompare(msrReportIdentity(b)),
  );
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
  const missing = coverage.missingScouts;
  const statusGridClass = 'grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-2';

  // Coverage bar fill + tone: success when every station is covered, warning
  // while partial, muted when nothing's in yet.
  const pctCovered = COVERAGE_STATION_CAP > 0 ? (stations / COVERAGE_STATION_CAP) * 100 : 0;
  const barColor = full ? 'bg-success' : stations > 0 ? 'bg-warning' : 'bg-muted-foreground/40';
  const countColor = full ? 'text-success' : stations > 0 ? 'text-warning' : 'text-muted-foreground';

  return (
    <div className="flex flex-col gap-4">
      {/* Lead: clear coverage indicator + slim coverage bar. */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-1.5">
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
          </span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            Red {coveredByAlliance.red}/3 · Blue {coveredByAlliance.blue}/3 ·{' '}
            {coverage.scoutsCovered} synced · {rel}
          </span>
        </div>
        {/* Slim coverage bar. */}
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted/50"
          role="progressbar"
          aria-label="Match station coverage"
          aria-valuemin={0}
          aria-valuemax={COVERAGE_STATION_CAP}
          aria-valuenow={stations}
        >
          <div
            className={cn('h-full rounded-full motion-safe:transition-all', barColor)}
            style={{ width: `${pctCovered}%` }}
          />
        </div>
      </div>

      {/* Synced server reports use the same scan pattern as missing scouts. */}
      {reported.length > 0 ? (
        <section aria-labelledby="match-scout-synced-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h4 id="match-scout-synced-heading" className="eyebrow text-success">
              Synced reports
            </h4>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {reported.length} received
            </span>
          </div>
          <ul className={statusGridClass}>
            {reported.map((r, i) => (
              <li
                key={`${r.scout_id ?? 'na'}-${r.station}-${i}`}
                data-testid={`match-scout-reported-${r.scout_id ?? 'unassigned'}`}
                className={cn(
                  'grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2',
                  r.scout_id
                    ? 'border-success/25 bg-success/5'
                    : 'border-warning/30 bg-warning/5',
                )}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className="truncate text-sm font-semibold text-foreground"
                    title={scoutName(r.scout_id)}
                  >
                    {scoutName(r.scout_id)}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 text-[11px] font-medium',
                      r.scout_id ? 'text-success' : 'text-warning',
                    )}
                  >
                    {r.scout_id ? (
                      <CheckCircle2 aria-hidden className="size-3" />
                    ) : (
                      <AlertTriangle aria-hidden className="size-3" />
                    )}
                    {r.scout_id ? 'Synced' : 'Synced, unassigned'}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-0.5">
                  <span className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {stationLabel(r)}
                  </span>
                  <time
                    dateTime={r.server_received_at}
                    className="font-mono text-[10px] tabular-nums text-muted-foreground"
                  >
                    {relativeTime(r.server_received_at ?? null, nowMs)}
                  </time>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Missing roster stays collapsible, but expands into a width-filling grid. */}
      {missing.length > 0 ? (
        <section className="flex flex-col gap-2">
          <button
            type="button"
            data-testid="match-scout-missing-toggle"
            aria-expanded={showMissing}
            aria-controls="match-scout-missing-panel"
            onClick={() => setShowMissing((v) => !v)}
            className="flex w-full items-center justify-between gap-3 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-left text-muted-foreground hover:bg-warning/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <span aria-hidden className="size-2 rounded-full bg-warning" />
              <span className="eyebrow text-warning">
                {missing.length} not reported
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium">
              {showMissing ? 'Hide' : 'Show'}
              <ChevronDown
                aria-hidden
                className={cn(
                  'size-3.5 motion-safe:transition-transform',
                  showMissing && 'rotate-180',
                )}
              />
            </span>
          </button>
          {showMissing ? (
            <div id="match-scout-missing-panel" className="flex flex-col gap-2">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                No synced report has reached the dashboard. Uploads still pending or failed on a
                scout device remain here until sync succeeds.
              </p>
              <ul data-testid="match-scout-missing-list" className={statusGridClass}>
                {missing.map((s) => {
                  const name = s.display_name ?? '(unnamed)';
                  return (
                    <li
                      key={s.id}
                      data-testid={`match-scout-missing-${s.id}`}
                      aria-label={`${name}: no synced report received`}
                      className="flex min-h-12 min-w-0 items-center gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-2"
                    >
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full border border-warning/70"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium text-foreground" title={name}>
                          {name}
                        </span>
                        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          No synced report
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
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
        detailRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }),
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
    ? reports.find((report) => msrReportIdentity(report) === openReportId) ?? null
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
    id ? nameById.get(id) ?? '(unknown)' : 'unassigned';

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
    () => (selected != null ? matches.find((m) => m.match_key === selected) ?? null : null),
    [matches, selected],
  );

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
      missingScouts: scouts.map((s) => ({ id: s.id, display_name: s.display_name ?? null })),
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
            sidebarOpen && 'lg:grid-cols-[20rem_1fr]',
          )}
        >
          {!sidebarOpen ? (
            <button
              type="button"
              data-testid="match-sidebar-expand"
              onClick={() => setSidebarOpen(true)}
              className="flex items-center gap-2 self-start rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60"
            >
              <PanelLeft className="size-4 text-brand" /> Matches ({matches.length})
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
                    placeholder="Search team # or match (254, Qual 12, Semi 3)…"
                    aria-label="Search matches by team or match number"
                    className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  {visibleMatches.length === 0 ? (
                    <div data-testid="match-search-empty" className="text-sm text-muted-foreground">
                      No matches match your search.
                    </div>
                  ) : (
                  <ul
                    data-testid="match-list"
                    className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto pr-1 lg:max-h-[70vh]"
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
                            'flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-base',
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
                              className={cn(
                                'tabular-nums',
                                count === 0 ? 'text-warning' : 'text-success',
                              )}
                            >
                              {count} report{count === 1 ? '' : 's'}
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
                  {selectedMatch ? <MatchResultsCard match={selectedMatch} /> : null}
                  {/* Scout-vs-official cross-check, directly under the real
                      result so a lead reads "official 300 / we scouted 90 → off"
                      in one glance. */}
                  {selectedMatch ? (
                    <ScoreValidationCard match={selectedMatch} reports={selectedReports} />
                  ) : null}
                  {/* Video + activity timelines combined into one block. */}
                  <MatchVideoCard
                    matchKey={selected}
                    videoSeconds={videoSeconds}
                    offsetSeconds={offsetSeconds}
                    onTimeMs={(ms) => setVideoSeconds(ms / 1000)}
                    onSyncNow={() => {
                      if (videoSeconds != null) setOffsetSeconds(videoSeconds);
                    }}
                    onResetSync={() => setOffsetSeconds(0)}
                  >
                    {selectedReports.length > 0 ? (
                      <MatchTimelines reports={selectedReports} currentTimeMs={currentTimeMs} />
                    ) : null}
                  </MatchVideoCard>
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
          openReport
            ? `${formatMatchKeyRaw(openReport.match_key)} · Team ${openReport.target_team_number}`
            : ''
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
