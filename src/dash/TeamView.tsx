// src/dash/TeamView.tsx
// TEAMVIEW (contracts §2 TeamAgg, §5 hooks, §8 testids). A staff-facing team
// deep-dive: pick a team from the event roster, then render that team's TeamAgg
// (fuel breakdown with a rate-FUEL low-confidence chip, climb, defense,
// reliability, scoutingExpectedPoints), its Statbotics EPA (or an "unavailable"
// note when Statbotics is down — never hard-fail), and the team's scouted
// matches. Dark theme, shadcn primitives, 44px touch targets.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Wrench,
  Cog,
  Sparkles,
  Inbox,
  StickyNote,
  Trophy,
  MapPin,
  Video,
  Crosshair,
  ExternalLink,
  Flame,
  Mountain,
  Gauge,
  TrendingUp,
  ListChecks,
  Eye,
  BatteryCharging,
  Ruler,
  Swords,
  Route,
  Timer,
  ShieldAlert,
  MessageSquareText,
  Users,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
} from 'lucide-react';
import { FieldDiagram } from '@/components/FieldDiagram';
import { MatchScorePanel } from '@/dash/MatchScorePanel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/utils';
import { formatMatchKeyRaw, compareMatchKeys } from '@/lib/formatMatch';
import { foulReasonLabel } from '@/scoring/fouls';
import {
  aggregateEvent,
  TREND_WINDOW,
  LOW_CONFIDENCE_THRESHOLD,
  ratedMeanText,
  type TeamAgg,
} from '@/dash/aggregate';
import { computeTeamTempo } from '@/dash/tempo';
import {
  useEventTeams,
  useEventReports,
  useEventScouts,
  useEventEpa,
  useEventMatches,
  useTbaTeam,
  useTbaTeamEventStatus,
  useTeamSeasonStats,
  type MatchRow,
} from '@/dash/useEventData';
import { useTeamPit, useTeamPhoto, type TeamPit } from '@/dash/useTeamPit';
import ReportDetail from '@/dash/ReportDetail';
import AutoOptions from '@/dash/AutoOptions';
import MatchVideo from '@/dash/MatchVideo';
import TeamTimeline from '@/dash/TeamTimeline';
import { MATCH_MS } from '@/dash/matchTimeline';
import {
  pctSigned,
  DEF_EFF_MIN_SAMPLE,
  intervalAbsRange,
  suppressionFromBursts,
} from '@/dash/defenseAnalytics';
import { BarChart, LineChart, StackedBar } from '@/dash/charts';
import ConflictMarker from '@/components/ConflictMarker';
import { useMultiScoutConflicts } from '@/dash/useMultiScoutConflicts';
import { msrReportIdentity, type MsrRow, type MultiScoutGroup } from '@/dash/types';

export interface TeamViewProps {
  eventKey: string;
  /**
   * Team to preselect — e.g. when arriving from a click in Ranking. Syncs the
   * dropdown when it changes; the dropdown still drives manual selection after.
   */
  selectedTeam?: number | null;
  /**
   * Deep-link to the Match tab with a given match selected — wired from the
   * team's last-match card so a lead can jump straight to the full match view.
   */
  onOpenMatch?: (matchKey: string) => void;
  /**
   * Notifies the parent (DashboardScreen) of a manual team selection so it
   * survives a tab switch — the parent holds the selection and feeds it back via
   * `selectedTeam` when this view remounts.
   */
  onSelectTeam?: (team: number | null) => void;
}


const CONTROL_MIN_HEIGHT = 44; // px — touch target floor

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}
function pct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

// ratedMeanText (super-scout rating means) moved to aggregate.ts so the
// Strategy tab's team cards share the exact same computation.

/** "30.0 ± 8.2" (mean ± std-dev); em-dash when the mean is not finite. */
function fmtPM(mean: number, sd: number): string {
  if (!Number.isFinite(mean)) return '—';
  return `${mean.toFixed(1)} ± ${Number.isFinite(sd) ? sd.toFixed(1) : '0.0'}`;
}
function recentFormText(agg: TeamAgg): string {
  // Guard toFixed against a non-finite delta (latent seam: a malformed/legacy agg)
  // the same way the other formatters in this file do.
  const delta = Number.isFinite(agg.recentFuelDelta) ? agg.recentFuelDelta.toFixed(1) : '0.0';
  switch (agg.recentTrend) {
    case 'improving':
      return `Improving +${delta}`;
    case 'fading':
      return `Fading ${delta}`; // delta already negative
    case 'stable':
      return 'Stable';
    default:
      return '—';
  }
}
function recentFormTone(agg: TeamAgg): StatTone {
  if (agg.recentTrend === 'improving') return 'success';
  if (agg.recentTrend === 'fading') return 'warning';
  return 'default';
}

/** Semantic value tones — maps to the app-wide color language. */
type StatTone = 'default' | 'brand' | 'energy' | 'success' | 'warning' | 'destructive';

const STAT_TONE_TEXT: Record<StatTone, string> = {
  default: 'text-zinc-100',
  brand: 'text-brand',
  energy: 'text-energy',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

function Stat(props: {
  label: string;
  value: string;
  testid: string;
  hint?: string;
  tone?: StatTone;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
      <span className="text-xs uppercase tracking-wide text-zinc-400">{props.label}</span>
      <span
        className={cn('text-lg font-semibold', STAT_TONE_TEXT[props.tone ?? 'default'])}
        data-testid={props.testid}
      >
        {props.value}
      </span>
      {props.hint ? <span className="text-xs text-zinc-500">{props.hint}</span> : null}
    </div>
  );
}

/** A labelled row of pill chips (mechanisms / capabilities / intake sources). */
function ChipRow(props: {
  icon: JSX.Element;
  label: string;
  // Tolerates undefined: a TeamPit rehydrated from the persisted query cache
  // can predate newer array fields (e.g. matchStrategy) and omit them.
  items: string[] | undefined;
  testid: string;
}): JSX.Element {
  const items = props.items ?? [];
  return (
    <div className="flex flex-col gap-1.5" data-testid={props.testid}>
      <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-4">
        {props.icon}
        {props.label}
      </span>
      {items.length ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it) => (
            <span
              key={it}
              className="rounded-lg border border-border bg-muted/40 px-2.5 py-1 text-sm text-foreground"
            >
              {it}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      )}
    </div>
  );
}

/** A labelled inline value row (drivetrain / vision / dimensions). */
function DetailRow(props: {
  icon: JSX.Element;
  label: string;
  value: string;
  testid: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-4">
        {props.icon}
        {props.label}
      </span>
      <span className="text-base font-semibold text-foreground" data-testid={props.testid}>
        {props.value}
      </span>
    </div>
  );
}

/** Compact "L × W × H in" string, em-dash when no dimension is known. */
function dimensionsStr(l: number | null, w: number | null, h: number | null): string {
  if (l == null && w == null && h == null) return '—';
  const part = (n: number | null): string => (n == null ? '?' : String(n));
  return `${part(l)} × ${part(w)} × ${part(h)} in`;
}

/** Battery / charger inventory summary, em-dash when nothing is known. */
function batteryStr(
  count: number | null,
  chargers: number | null,
  brand: string | null,
  connector: string | null,
): string {
  const parts: string[] = [];
  if (count != null) parts.push(`${count} batt`);
  if (chargers != null) parts.push(`${chargers} charger${chargers === 1 ? '' : 's'}`);
  const extras = [brand, connector].filter((p): p is string => !!p);
  const main = parts.join(' · ');
  if (!main && extras.length === 0) return '—';
  return extras.length ? `${main || '—'} (${extras.join(', ')})` : main;
}

/** Format a W-L-T record, or em-dash when no parts are known. */
function recordStr(w: number | null, l: number | null, t: number | null): string {
  if (w == null && l == null && t == null) return '—';
  return `${w ?? 0}-${l ?? 0}-${t ?? 0}`;
}

/** Human location string from TBA city / state / country parts. */
function locationStr(city: string | null, state: string | null, country: string | null): string {
  const parts = [city, state, country].filter((p): p is string => !!p);
  return parts.length ? parts.join(', ') : '—';
}

/**
 * The Blue Alliance panel: live event rank + record, season world rank + EPA +
 * record (Statbotics with in-house fallback), team identity / location, and a
 * deep link to the team's TBA page. Every field degrades to "—" so a TBA outage
 * never blanks the team view.
 */
function TeamTbaPanel(props: {
  team: number;
  eventKey: string;
  matches: MatchRow[];
}): JSX.Element {
  const { team, eventKey, matches } = props;
  const info = useTbaTeam(team).data ?? null;
  const status = useTbaTeamEventStatus(team, eventKey).data ?? null;
  const season = useTeamSeasonStats(team, eventKey, matches).data ?? null;
  const year = eventKey.slice(0, 4);

  const eventRank =
    status?.rank != null
      ? `#${status.rank}${status.numTeams != null ? ` / ${status.numTeams}` : ''}`
      : '—';
  const worldRank = season?.worldRank != null ? `#${season.worldRank}` : '—';
  const seasonEpa = season?.totalEpa != null ? fmt(season.totalEpa) : '—';
  const epaHint =
    season?.totalEpa != null
      ? season.epaSource === 'statbotics'
        ? 'Statbotics season EPA'
        : 'in-house estimate (Statbotics offline)'
      : undefined;

  return (
    <Card className="border-zinc-800 bg-zinc-950" data-testid="team-tba">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-zinc-100">
          <Trophy className="size-5 text-brand" />
          The Blue Alliance
        </CardTitle>
        <a
          data-testid="team-tba-link"
          href={`https://www.thebluealliance.com/team/${team}/${year}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-200"
        >
          View on TBA <ExternalLink className="size-3.5" />
        </a>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {info?.nickname ? (
          <div data-testid="team-tba-name" className="flex flex-col gap-0.5">
            <span className="text-base font-semibold text-zinc-100">{info.nickname}</span>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Event rank" value={eventRank} testid="team-tba-event-rank" tone="brand" />
          <Stat
            label="Event record"
            value={recordStr(status?.wins ?? null, status?.losses ?? null, status?.ties ?? null)}
            testid="team-tba-event-record"
          />
          <Stat
            label="World rank"
            value={worldRank}
            testid="team-tba-world-rank"
            hint={`${year} season`}
            tone="brand"
          />
          <Stat
            label="Season EPA"
            value={seasonEpa}
            testid="team-tba-season-epa"
            hint={epaHint}
            tone={season?.totalEpa != null && season.epaSource !== 'statbotics' ? 'warning' : 'energy'}
          />
          <Stat
            label="Season record"
            value={season?.seasonRecord ?? '—'}
            testid="team-tba-season-record"
          />
        </div>
        <div
          data-testid="team-tba-location"
          className="flex items-center gap-1.5 text-sm text-zinc-400"
        >
          <MapPin className="size-4 text-zinc-500" />
          {locationStr(info?.city ?? null, info?.stateProv ?? null, info?.country ?? null)}
          {status?.allianceName ? (
            <span className="ml-2 rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
              {status.allianceName}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Last-match card: embeds the TBA video for the team's most-recent scouted match
 * BESIDE a compact match-details panel (both alliances with our team highlighted,
 * the final score + winner), overlays OUR activity timeline for that report with
 * an optional playhead synced to the video, and is itself clickable to deep-link
 * to the full Match tab for that match. The timeline degrades on its own for
 * legacy reports without timestamps; the video degrades to a "no video" note when
 * TBA has none yet; score/winner degrade to "—" when the match is unplayed.
 */
function LastMatchCard(props: {
  report: MsrRow;
  match: MatchRow | null;
  teamNumber: number;
  onOpenMatch?: (matchKey: string) => void;
}): JSX.Element {
  const { report, match, teamNumber, onOpenMatch } = props;
  const [videoSeconds, setVideoSeconds] = useState<number | null>(null);
  const [offsetSeconds, setOffsetSeconds] = useState(0);

  useEffect(() => {
    setVideoSeconds(null);
    setOffsetSeconds(0);
  }, [report.match_key, teamNumber]);

  const redTeams = [match?.red1 ?? null, match?.red2 ?? null, match?.red3 ?? null];
  const blueTeams = [match?.blue1 ?? null, match?.blue2 ?? null, match?.blue3 ?? null];
  const redScore = match?.actual_red_score ?? null;
  const blueScore = match?.actual_blue_score ?? null;
  const winner = match?.winner ?? null; // 'red' | 'blue' | 'tie' | null

  const currentTimeMs = useMemo(() => {
    if (videoSeconds == null || !Number.isFinite(videoSeconds)) return null;
    const ms = (videoSeconds - offsetSeconds) * 1000;
    return Math.max(0, Math.min(MATCH_MS, ms));
  }, [videoSeconds, offsetSeconds]);

  const hasTime = videoSeconds != null && Number.isFinite(videoSeconds);
  const matchSecs = hasTime ? Math.max(0, (videoSeconds as number) - offsetSeconds) : null;

  // Single-report defended-fuel suppression caption (null when no defended data).
  const lastMatchSuppression = useMemo(() => {
    const windows = (report.defended_intervals ?? []).map(intervalAbsRange);
    if (windows.length === 0) return null;
    return suppressionFromBursts(report.fuel_bursts, windows);
  }, [report.defended_intervals, report.fuel_bursts]);

  return (
    <Card className="border-zinc-800 bg-zinc-950" data-testid="team-last-match">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-zinc-100">
          <Video className="size-5 text-brand" />
          Last match — {formatMatchKeyRaw(report.match_key)}
        </CardTitle>
        {onOpenMatch ? (
          <button
            type="button"
            data-testid="team-last-match-open"
            onClick={() => onOpenMatch(report.match_key)}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800/60 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
          >
            Open in Match tab <ExternalLink className="size-3.5" />
          </button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Video beside a compact match-details panel (alliances + score). */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_minmax(0,16rem)]">
          <div className="w-full">
            <MatchVideo matchKey={report.match_key} onTimeMs={(ms) => setVideoSeconds(ms / 1000)} />
          </div>
          <MatchScorePanel
            redTeams={redTeams}
            blueTeams={blueTeams}
            redScore={redScore}
            blueScore={blueScore}
            winner={winner}
            ourTeam={teamNumber}
            testidPrefix="team-last-match"
          />
        </div>
        <div
          data-testid="team-last-match-sync"
          className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 text-sm"
        >
          <span className="inline-flex items-center gap-2 tabular-nums text-zinc-400">
            <Crosshair className="size-4 text-brand" />
            {hasTime ? (
              <>
                <span>video {(videoSeconds as number).toFixed(1)}s</span>
                <span className="text-zinc-200">· match {(matchSecs as number).toFixed(1)}s</span>
              </>
            ) : (
              <span>Play the video, then sync to match start.</span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              data-testid="team-last-match-sync-now"
              disabled={!hasTime}
              onClick={() => {
                if (videoSeconds != null) setOffsetSeconds(videoSeconds);
              }}
              style={{ minHeight: CONTROL_MIN_HEIGHT }}
              className="inline-flex items-center rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 font-medium text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
            >
              Sync to match start
            </button>
            {offsetSeconds !== 0 ? (
              <button
                type="button"
                data-testid="team-last-match-sync-reset"
                onClick={() => setOffsetSeconds(0)}
                style={{ minHeight: CONTROL_MIN_HEIGHT }}
                className="inline-flex items-center rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-1.5 text-zinc-400 hover:bg-zinc-800/70"
              >
                Reset
              </button>
            ) : null}
          </span>
        </div>
        <TeamTimeline report={report} currentTimeMs={currentTimeMs} />
        {lastMatchSuppression != null ? (
          <span
            data-testid="team-last-match-suppression"
            className="text-xs text-zinc-400"
          >
            Fuel ↓ {pctSigned(lastMatchSuppression)} while defended this match
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PitPanel(props: {
  pit: TeamPit | null;
  isLoading: boolean;
  scoutName: (id: string | null | undefined) => string;
}): JSX.Element {
  const { pit, isLoading, scoutName } = props;
  return (
    <Card className="border-border bg-card" data-testid="team-pit">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Wrench className="size-5 text-brand" />
        <CardTitle className="text-foreground">Pit Report</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div data-testid="team-pit-loading" className="text-sm text-muted-foreground">
            Loading pit report…
          </div>
        ) : !pit ? (
          <div data-testid="team-pit-empty" className="text-sm text-muted-foreground">
            No pit report yet for this team.
          </div>
        ) : (
          <div data-testid="team-pit-data" className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
              <div
                data-testid="team-pit-author"
                className="flex items-center gap-1.5 text-sm text-muted-foreground"
              >
                <Users className="size-4 text-brand" />
                Scouted by{' '}
                <span className="font-semibold text-foreground">
                  {scoutName(pit.authorScoutId)}
                </span>
              </div>
              <DetailRow
                icon={<Cog />}
                label="Drivetrain"
                value={pit.drivetrain ?? '—'}
                testid="team-pit-drivetrain"
              />
              <DetailRow
                icon={<Eye />}
                label="Vision"
                value={pit.visionSystem ?? '—'}
                testid="team-pit-vision"
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(340px,1.1fr)] lg:items-start">
              <div className="flex min-w-0 flex-col gap-5">
                <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
                  <ChipRow
                    icon={<Cog />}
                    label="Mechanisms"
                    items={pit.mechanisms}
                    testid="team-pit-mechanisms"
                  />
                  <ChipRow
                    icon={<Sparkles />}
                    label="Capabilities"
                    items={pit.capabilities}
                    testid="team-pit-capabilities"
                  />
                  <ChipRow
                    icon={<Inbox />}
                    label="Intake sources"
                    items={pit.intakeSources}
                    testid="team-pit-intake"
                  />
                  <ChipRow
                    icon={<Swords />}
                    label="Match strategy"
                    items={pit.matchStrategy}
                    testid="team-pit-strategy"
                  />
                </div>

                <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
                  <DetailRow
                    icon={<BatteryCharging />}
                    label="Batteries"
                    value={batteryStr(
                      pit.batteryCount,
                      pit.chargerCount,
                      pit.batteryBrand,
                      pit.batteryConnector,
                    )}
                    testid="team-pit-batteries"
                  />
                  <DetailRow
                    icon={<Ruler />}
                    label="Dimensions"
                    value={
                      dimensionsStr(pit.robotLengthIn, pit.robotWidthIn, pit.robotHeightIn) +
                      (pit.trenchCapable ? ' · trench ✓' : '')
                    }
                    testid="team-pit-dimensions"
                  />
                </div>
              </div>

              <div className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-col gap-2" data-testid="team-pit-auto">
                  <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-4">
                    <Route />
                    Preferred auto
                  </span>
                  {pit.preferredAutoStartPosition || pit.preferredAutoPath ? (
                    <div className="w-full max-w-[520px] overflow-hidden rounded-lg border border-border bg-muted/20 p-2">
                      <FieldDiagram
                        mode="view"
                        startPosition={pit.preferredAutoStartPosition}
                        path={pit.preferredAutoPath}
                        data-testid="team-pit-auto-field"
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground" data-testid="team-pit-auto-empty">
                      No preferred auto recorded.
                    </span>
                  )}
                </div>
                {pit.notes ? (
                  <div className="flex flex-col gap-1.5" data-testid="team-pit-notes">
                    <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-4">
                      <StickyNote />
                      Notes
                    </span>
                    <p className="rounded-lg border border-border bg-muted/20 p-3 text-sm leading-relaxed text-foreground">
                      {pit.notes}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Robot-photo panel for the team header. Shows the scouted pit photo when one
 * exists (resolved from its Storage path to a signed URL), otherwise a Blue
 * Alliance team-media image for the event's season. Sits beside the TBA card at
 * a fixed, standard 4:3 size (top-aligned, not stretched to the tall card).
 * Clicking it opens the full image in a lightbox. Renders nothing when no photo
 * is available — no placeholder, no dead space.
 */
function TeamPhotoThumb(props: {
  eventKey: string;
  teamNumber: number;
  pitPhotoPath: string | null;
  pitPhotoPaths?: string[];
}): JSX.Element | null {
  const { eventKey, teamNumber, pitPhotoPath, pitPhotoPaths } = props;
  const photoQuery = useTeamPhoto(eventKey, teamNumber, pitPhotoPath, pitPhotoPaths);
  const url = photoQuery.data?.url ?? null;
  const urls = photoQuery.data?.urls ?? (url ? [url] : []);
  const source = photoQuery.data?.source ?? null;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOpen(false);
    setActiveIndex(0);
  }, [eventKey, teamNumber]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open]);

  if (!url) return null;
  const activeUrl = urls[activeIndex] ?? url;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="team-photo-thumb"
        onClick={() => setOpen(true)}
        title={source === 'tba' ? 'Robot photo (TBA) — tap to enlarge' : 'Robot photo — tap to enlarge'}
        className="group relative block aspect-[4/3] w-full overflow-hidden rounded-xl border border-border bg-muted/40"
      >
        <img
          src={url}
          alt={`Robot for team ${teamNumber}`}
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
        <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-200 backdrop-blur-sm">
          {source === 'tba' ? 'TBA' : urls.length > 1 ? `${urls.length} pit photos` : 'Pit photo'}
        </span>
      </button>
      {open ? (
        <div
          ref={dialogRef}
          data-testid="team-photo-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`Robot photo for team ${teamNumber}`}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div
            className="relative flex max-h-[95vh] max-w-full flex-col items-center gap-3"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              ref={closeRef}
              type="button"
              variant="secondary"
              size="icon"
              aria-label="Close robot photo"
              onClick={() => setOpen(false)}
              className="absolute right-2 top-2 z-10"
            >
              <X className="size-5" />
            </Button>
            <img
              src={activeUrl}
              alt={`Robot for team ${teamNumber}, photo ${activeIndex + 1}`}
              className="max-h-[78vh] max-w-full rounded-xl border border-border object-contain"
            />
            {urls.length > 1 ? (
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Previous pit photo"
                  onClick={() => setActiveIndex((index) => (index - 1 + urls.length) % urls.length)}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="font-mono text-sm text-white">
                  {activeIndex + 1} / {urls.length}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Next pit photo"
                  onClick={() => setActiveIndex((index) => (index + 1) % urls.length)}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Trends: data-viz over the team's scouted matches (chronological by match_key).
 * Charts degrade to a "Not enough data to chart" state under 2 reports. Uses the
 * dependency-free SVG chart set with design tokens (brand/energy/success/warning).
 */
function TeamTrends(props: { matches: MsrRow[]; showClimb: boolean }): JSX.Element {
  const { matches, showClimb } = props;

  // Stable chronological order so x-axis labels read left→right by match. Sort by
  // (comp-level, match number) parsed from the key — a plain string localeCompare
  // orders "qm10" before "qm2" (lexicographic), scrambling the trend x-axis.
  const ordered = useMemo(
    () => matches.slice().sort((a, b) => compareMatchKeys(a.match_key, b.match_key)),
    [matches],
  );

  const labels = ordered.map((m) => formatMatchKeyRaw(m.match_key));

  const fuelData = ordered.map((m, i) => ({ label: labels[i], value: m.fuel_points }));
  const shiftData = ordered.map((m, i) => ({
    label: labels[i],
    values: Array.isArray(m.fuel_by_shift) ? m.fuel_by_shift : [],
  }));
  const shiftCount = Math.max(0, ...shiftData.map((d) => d.values.length));
  const shiftNames = Array.from({ length: shiftCount }, (_, i) => `Shift ${i + 1}`);
  const climbData = ordered.map((m, i) => ({
    label: labels[i],
    value: m.climb_success ? m.climb_level : 0,
  }));
  const defenseData = ordered.map((m, i) => ({ label: labels[i], value: m.defense_rating }));

  return (
    <Card className="border-zinc-800 bg-zinc-950" data-testid="team-trends">
      <CardHeader className="space-y-0">
        <CardTitle className="flex items-center gap-2 text-zinc-100">
          <TrendingUp className="size-5 text-brand" />
          Trends
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <BarChart
          data={fuelData}
          color="energy"
          title="Fuel points per match"
          testid="team-trend-fuel"
        />
        <StackedBar
          data={shiftData}
          seriesNames={shiftNames}
          title="Fuel by shift"
          testid="team-trend-shift"
        />
        {showClimb ? (
          <LineChart
            data={climbData}
            color="success"
            yMax={3}
            title="Climb level per match (success-gated)"
            testid="team-trend-climb"
          />
        ) : null}
        <LineChart
          data={defenseData}
          color="brand"
          yMax={3}
          title="Defense rating per match"
          testid="team-trend-defense"
        />
      </CardContent>
    </Card>
  );
}

/**
 * Reliability-by-match strip (robot-reliability-trend feature): one square per
 * scouted match in play order — green = clean, amber = tipped, red = died /
 * no-show — so a lead reads a robot's incident history at a glance (e.g. "fine
 * early, tipped twice late"). Pure over the team's already-fetched reports; the
 * `tipped`/`died`/`no_show` flags are existing raw columns (no migration).
 */
function ReliabilityStrip(props: { matches: MsrRow[] }): JSX.Element | null {
  const ordered = useMemo(
    () => props.matches.slice().sort((a, b) => compareMatchKeys(a.match_key, b.match_key)),
    [props.matches],
  );
  if (ordered.length === 0) return null;
  return (
    <div
      data-testid="team-reliability-strip"
      className="col-span-2 flex flex-col gap-1.5 sm:col-span-3"
    >
      <span className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-zinc-400">
        <ShieldAlert className="size-3.5" /> Reliability by match
      </span>
      <div className="flex flex-wrap gap-1">
        {ordered.map((m, i) => {
          const incident = m.no_show ? 'no-show' : m.died ? 'died' : m.tipped ? 'tipped' : null;
          const tone =
            m.no_show || m.died ? 'bg-destructive' : m.tipped ? 'bg-warning' : 'bg-success/60';
          return (
            <span
              key={`${m.match_key}-${i}`}
              data-testid={`team-reliability-cell-${i}`}
              title={`${formatMatchKeyRaw(m.match_key)} — ${incident ?? 'clean'}`}
              className={cn('size-4 rounded-sm', tone)}
            />
          );
        })}
      </div>
    </div>
  );
}

/** ms → "1.2s" (one decimal); em-dash when null/non-finite. */
function secs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Tempo card (cycle-time feature): shooting cadence derived from the team's
 * `fuel_bursts` timestamps — cycles per match, the reload/travel gap between
 * bursts (the robot's cycle time), continuous-burst length, and the share of the
 * match spent actively shooting. Renders nothing until at least one scouted match
 * carries timestamped bursts (legacy/pre-0010 reports lack them).
 */
function TempoCard(props: { matches: MsrRow[] }): JSX.Element | null {
  const tempo = useMemo(() => computeTeamTempo(props.matches), [props.matches]);
  if (tempo.reportsWithBursts === 0) return null;
  return (
    <Card className="border-zinc-800 bg-zinc-950" data-testid="team-tempo">
      <CardHeader className="space-y-0">
        <CardTitle className="flex items-center gap-2 text-zinc-100">
          <Timer className="size-5 text-brand" />
          Tempo
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Cycle time"
          value={secs(tempo.meanGapMs)}
          testid="team-tempo-cycle"
          hint="gap between shooting bursts"
          tone="brand"
        />
        <Stat
          label="Cycles / match"
          value={fmt(tempo.meanBurstsPerMatch)}
          testid="team-tempo-cycles"
        />
        <Stat
          label="Burst length"
          value={secs(tempo.meanBurstDurationMs)}
          testid="team-tempo-burst"
          hint="continuous shooting span"
        />
        <Stat
          label="Active"
          value={pct(tempo.activeFraction)}
          testid="team-tempo-active"
          hint={`of match · n=${tempo.reportsWithBursts}`}
          tone="energy"
        />
      </CardContent>
    </Card>
  );
}

/**
 * Scout notes for a team, aggregated into one block (instead of buried per-match
 * in the scouted-match rows). A compact scouting log: each note is anchored to
 * its match + scouter and the log expands to two columns when space permits.
 * Chronological by play order. Renders nothing when no match has a note.
 */
function TeamNotes(props: {
  matches: MsrRow[];
  scoutName: (id: string | null | undefined) => string;
}): JSX.Element | null {
  const noted = useMemo(
    () =>
      props.matches
        .filter((m) => (m.notes ?? '').trim().length > 0)
        .sort((a, b) => compareMatchKeys(a.match_key, b.match_key)),
    [props.matches],
  );
  if (noted.length === 0) return null;
  return (
    <Card className="border-zinc-800 bg-zinc-950" data-testid="team-notes">
      <CardHeader className="space-y-0">
        <CardTitle className="flex items-center gap-2 text-zinc-100">
          <MessageSquareText className="size-5 text-brand" />
          Scout notes ({noted.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {noted.map((m, i) => (
            <li
              key={`${m.match_key}-${i}`}
              data-testid={`team-note-${i}`}
              className="min-w-0 rounded-lg border border-zinc-800/80 border-l-2 border-l-brand/50 bg-zinc-900/40 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-zinc-400">
                <span className="font-semibold text-zinc-200">
                  {formatMatchKeyRaw(m.match_key)}
                </span>
                <span>{props.scoutName(m.scout_id)}</span>
              </div>
              <p className="mt-1 break-words text-sm leading-snug text-zinc-300">{m.notes}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function TeamDetail(props: {
  agg: TeamAgg;
  teamNumber: number;
  matches: MsrRow[];
  tbaNode: JSX.Element;
  /** Larger robot-photo panel rendered beside the TBA card; null when no image. */
  photoNode: JSX.Element | null;
  lastMatchNode: JSX.Element | null;
  epaNode: JSX.Element;
  pitNode: JSX.Element;
  scoutName: (id: string | null | undefined) => string;
  onOpenReport: (r: MsrRow) => void;
  /** robotKey → multi-scout group (event-wide, looked up per scouted-match row). */
  conflictByRobotKey: Map<string, MultiScoutGroup>;
  /** robotKey helper from the conflicts hook (O(1) per-row lookup). */
  robotKey: (r: MsrRow) => string;
  /** count of CONFLICTED (minor/severe) groups for this team. */
  conflictCount: number;
}): JSX.Element {
  const { agg, matches, scoutName, conflictByRobotKey, robotKey, conflictCount } = props;
  const lowConfidence = agg.meanFuelConfidence < LOW_CONFIDENCE_THRESHOLD;
  // A team that has never climbed (no successful climb at any level) — hide all
  // its climb stats/graphs and just say "no climb" instead of showing zeros.
  const neverClimbs = agg.climbSuccessRate <= 0 && agg.avgClimbLevel <= 0;
  // Index of the expanded scouted-match row (click to reveal that report's detail).
  const [openRow, setOpenRow] = useState<number | null>(null);
  // "Show conflicts only" filter. Flipping it RESETS openRow (the index-based
  // rows reindex when filtered) so an open row never jumps to a different match.
  const [conflictsOnly, setConflictsOnly] = useState(false);

  // Conflicted group (minor/severe) for one scouted-match row, looked up O(1).
  const conflictFor = (m: MsrRow): MultiScoutGroup | undefined => {
    const g = conflictByRobotKey.get(robotKey(m));
    return g && g.isConflicted ? g : undefined;
  };
  const visibleMatches = conflictsOnly ? matches.filter((m) => conflictFor(m)) : matches;

  return (
    <div data-testid="team-detail" className="flex flex-col gap-4">
      {/* The Blue Alliance card beside the robot photo, which fills the card's
          vertical space instead of leaving it blank. Photo collapses below the
          card on narrow screens; full-width TBA card when there's no photo. */}
      {props.photoNode ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
          {props.tbaNode}
          {props.photoNode}
        </div>
      ) : (
        props.tbaNode
      )}

      {/* Last-match video + our activity timeline. */}
      {props.lastMatchNode}

      {/* Fuel */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <Flame className="size-5 text-energy" />
            Fuel
          </CardTitle>
          <span className="flex flex-wrap items-center gap-2">
            {/* Recent-form trend (improving/fading/stable) — compact chip, no longer
                its own card; semantics preserved from agg.recentTrend. */}
            <span
              data-testid="team-recent-form"
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium',
                recentFormTone(agg) === 'success'
                  ? 'border-success/40 bg-success/10 text-success'
                  : recentFormTone(agg) === 'warning'
                    ? 'border-warning/40 bg-warning/10 text-warning'
                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-300',
              )}
              title={
                agg.recentTrend === 'insufficient'
                  ? 'need 3 matches'
                  : `last ${Math.min(3, agg.matchesScouted)} vs all`
              }
            >
              <TrendingUp className="size-3.5" />
              {recentFormText(agg)}
            </span>
            {lowConfidence ? (
              <span
                data-testid="team-fuel-lowconf-chip"
                className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-300"
                title="FUEL is rate-derived; treat its contribution as a low-confidence estimate (points are NOT down-weighted)."
              >
                rate-FUEL · low confidence ({pct(agg.meanFuelConfidence)})
              </span>
            ) : null}
          </span>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Auto fuel" value={fmt(agg.meanAutoFuel)} testid="team-mean-auto-fuel" />
          <Stat
            label="Teleop active"
            value={fmt(agg.meanTeleopFuelActive)}
            testid="team-mean-teleop-active"
          />
          <Stat
            label="Teleop inactive"
            value={fmt(agg.meanTeleopFuelInactive)}
            testid="team-mean-teleop-inactive"
          />
          <Stat label="Endgame fuel" value={fmt(agg.meanEndgameFuel)} testid="team-mean-endgame-fuel" />
          <Stat
            label="Total fuel"
            value={fmt(agg.meanTotalFuel)}
            testid="team-mean-total-fuel"
            tone="energy"
          />
          <Stat
            label="Mean fuel points"
            value={fmtPM(agg.meanFuelPoints, agg.stdDevFuelPoints)}
            testid="team-mean-fuel-points"
            hint={`range ${fmt(agg.minFuelPoints)} – ${fmt(agg.maxFuelPoints)} · n=${agg.matchesScouted}`}
            tone="energy"
          />
        </CardContent>
      </Card>

      {/* Climb / defense / reliability */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="space-y-0">
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <Mountain className="size-5 text-success" />
            {neverClimbs ? 'Defense · Reliability' : 'Climb · Defense · Reliability'}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {neverClimbs ? (
            <div
              data-testid="team-no-climb"
              className="col-span-2 flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-400 sm:col-span-3"
            >
              <Mountain className="size-4 text-zinc-500" />
              No climb — this team hasn’t climbed in any scouted match.
            </div>
          ) : (
            <>
              <Stat
                label="Climb success"
                value={pct(agg.climbSuccessRate)}
                testid="team-climb-success-rate"
                tone={
                  agg.climbSuccessRate >= 0.6
                    ? 'success'
                    : agg.climbSuccessRate >= 0.3
                      ? 'warning'
                      : 'default'
                }
              />
              <Stat label="Avg climb level" value={fmt(agg.avgClimbLevel)} testid="team-avg-climb-level" />
              <Stat
                label="Mean climb points"
                value={fmtPM(agg.meanClimbPoints, agg.stdDevClimbPoints)}
                testid="team-mean-climb-points"
                hint={`range ${fmt(agg.minClimbPoints)} – ${fmt(agg.maxClimbPoints)}`}
              />
            </>
          )}
          <Stat
            label="Avg defense"
            value={fmtPM(agg.avgDefenseRating, agg.stdDevDefenseRating)}
            testid="team-avg-defense-rating"
            hint={`1–10 · range ${fmt(agg.minDefenseRating)} – ${fmt(agg.maxDefenseRating)}`}
            tone="brand"
          />
          {/* Subjective super-scout ratings, averaged over RATED matches (0 = not
              rated, excluded). Computed inline from the team's reports — no new
              TeamAgg field. "—" until at least one match was rated. */}
          <Stat
            label="Driver skill"
            value={ratedMeanText(matches, (m) => m.driver_skill)}
            testid="team-driver-skill"
            hint="1–10 · rated matches"
          />
          <Stat
            label="Agility"
            value={ratedMeanText(matches, (m) => m.agility)}
            testid="team-agility"
            hint="1–10 · rated matches"
          />
          <Stat
            label="Defended fuel ↓"
            value={
              agg.fuelSuppressionWhileDefended == null
                ? '—'
                : pctSigned(agg.fuelSuppressionWhileDefended)
            }
            testid="team-defended-suppression"
            hint={
              agg.fuelSuppressionWhileDefended == null
                ? 'no defended intervals'
                : `from ${Math.round(agg.defendedSampleMs / 1000)}s defended`
            }
            tone={
              agg.fuelSuppressionWhileDefended != null && agg.fuelSuppressionWhileDefended > 0.15
                ? 'warning'
                : 'default'
            }
          />
          <Stat
            label="Defender effect"
            // Gated: a single-opponent observation is not shown as authoritative
            // (co-occurrence estimate confounded by simultaneous defenders).
            value={
              agg.defenderEffectiveness == null ||
              agg.defenseSampleCount < DEF_EFF_MIN_SAMPLE
                ? '—'
                : pctSigned(agg.defenderEffectiveness)
            }
            testid="team-defender-effectiveness"
            hint={
              agg.defenderEffectiveness == null
                ? 'never played defense'
                : `vs ${agg.defenseSampleCount} opp. · co-occurrence estimate`
            }
            tone={
              agg.defenderEffectiveness != null &&
              agg.defenseSampleCount >= DEF_EFF_MIN_SAMPLE &&
              agg.defenderEffectiveness > 0.15
                ? 'success'
                : 'default'
            }
          />
          <Stat
            label="Reliability"
            value={pct(agg.reliability)}
            testid="team-reliability"
            hint={`no-show ${pct(agg.noShowRate)} · died ${pct(agg.diedRate)} · tipped ${pct(agg.tippedRate)}`}
            tone={
              agg.reliability >= 0.85 ? 'success' : agg.reliability >= 0.6 ? 'warning' : 'destructive'
            }
          />
          <Stat
            label="Scouting expected pts"
            value={fmt(agg.scoutingExpectedPoints)}
            testid="team-scouting-expected"
          />
          {/* Per-match incident trend (green clean / amber tipped / red died). */}
          <ReliabilityStrip matches={matches} />
        </CardContent>
      </Card>

      {/* Shooting tempo / cycle-time — derived from fuel-burst timestamps. */}
      <TempoCard matches={matches} />

      {/* Trends — per-match data-viz over this team's scouted matches. Hidden
          entirely when there isn't enough data to draw a meaningful trend
          (fewer than the trend window of matches) — no empty placeholder. */}
      {agg.recentTrend !== 'insufficient' && agg.matchesScouted >= TREND_WINDOW ? (
        <TeamTrends matches={matches} showClimb={!neverClimbs} />
      ) : null}

      {/* Statbotics EPA */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="space-y-0">
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <Gauge className="size-5 text-energy" />
            EPA
          </CardTitle>
        </CardHeader>
        <CardContent>{props.epaNode}</CardContent>
      </Card>

      {/* Pit scouting report */}
      {props.pitNode}

      {/* Auto options — this team's distinct auto routines, grouped by path shape
          (the options they tend to run), with a step-through of every auto. */}
      <Card className="border-zinc-800 bg-zinc-950" data-testid="team-auto-options-card">
        <CardHeader className="space-y-0">
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <Route className="size-5 text-brand" />
            Auto options
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AutoOptions
            teamNumber={props.teamNumber}
            reports={props.matches}
            data-testid="team-auto-options"
          />
        </CardContent>
      </Card>

      {/* All scout notes for this team, aggregated into one block. */}
      <TeamNotes matches={matches} scoutName={scoutName} />

      {/* Scouted matches */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="space-y-0">
          <CardTitle className="flex flex-wrap items-center gap-2 text-zinc-100">
            <ListChecks className="size-5 text-brand" />
            Scouted matches ({matches.length})
            {conflictCount > 0 ? (
              <span
                data-testid="team-conflict-summary"
                className="rounded-full border border-warning/50 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning"
              >
                {conflictCount} multi-scout conflict{conflictCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </CardTitle>
          {conflictCount > 0 ? (
            <label className="flex items-center gap-2 pt-2 text-xs font-medium text-zinc-300">
              <input
                type="checkbox"
                data-testid="team-conflicts-only"
                checked={conflictsOnly}
                onChange={(e) => {
                  setConflictsOnly(e.target.checked);
                  setOpenRow(null); // rows reindex on filter — collapse any open row
                }}
                className="size-4 accent-warning"
              />
              Show conflicts only
            </label>
          ) : null}
        </CardHeader>
        <CardContent>
          {conflictsOnly && visibleMatches.length === 0 ? (
            <div data-testid="team-conflicts-empty" className="text-sm text-zinc-400">
              No multi-scout conflicts for this team.
            </div>
          ) : null}
          <ul data-testid="team-match-list" className="flex flex-col gap-2">
            {visibleMatches.map((m, i) => {
              const climb = m.climb_success ? `L${m.climb_level}` : 'no climb';
              const open = openRow === i;
              const conflict = conflictFor(m);
              // Split flags by severity: no-show/died are hard failures (destructive
              // red), tipped is a warning (amber) — mirrors ReportDetail's FlagPill.
              const failFlags = [m.no_show ? 'no-show' : null, m.died ? 'died' : null].filter(
                Boolean,
              );
              const warnFlags = [m.tipped ? 'tipped' : null].filter(Boolean);
              return (
                <li
                  key={`${m.match_key}-${i}`}
                  className="rounded-md border border-zinc-800 bg-zinc-900/60 text-sm text-zinc-200"
                >
                  <button
                    type="button"
                    data-testid={`team-match-row-${i}`}
                    onClick={() => setOpenRow(open ? null : i)}
                    style={{ minHeight: CONTROL_MIN_HEIGHT }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left"
                  >
                    <span className="flex min-w-0 items-center gap-2 font-semibold">
                      {conflict ? (
                        <span data-testid="team-conflict-marker" className="inline-flex">
                          <ConflictMarker variant="icon" size="sm" group={conflict} />
                        </span>
                      ) : null}
                      {formatMatchKeyRaw(m.match_key)}
                    </span>
                    <span className="text-zinc-400">
                      fuel {fmt(m.fuel_points)} ·{' '}
                      <span className={m.climb_success ? 'text-success' : undefined}>{climb}</span>
                    </span>
                  </button>
                  {open ? (
                    <div
                      data-testid="team-match-detail"
                      className="flex flex-col gap-2 border-t border-zinc-800 px-3 py-2 text-zinc-300"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <span className="min-w-0 break-words text-zinc-400">
                          {m.alliance_color} {m.station} · scouted by {scoutName(m.scout_id)}
                        </span>
                        {failFlags.length || warnFlags.length ? (
                          <span className="flex flex-wrap items-center gap-x-2">
                            {failFlags.length ? (
                              <span className="text-destructive">{failFlags.join(' · ')}</span>
                            ) : null}
                            {warnFlags.length ? (
                              <span className="text-warning">{warnFlags.join(' · ')}</span>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-zinc-400 sm:grid-cols-4">
                        <span>auto {fmt(m.auto_fuel)}</span>
                        <span>tele+ {fmt(m.teleop_fuel_active)}</span>
                        <span>tele− {fmt(m.teleop_fuel_inactive)}</span>
                        <span>end {fmt(m.endgame_fuel)}</span>
                        <span>defense {m.defense_rating}</span>
                        <span>pins {m.pins}</span>
                      </div>
                      {m.foul_reasons && m.foul_reasons.length > 0 ? (
                        <div
                          data-testid={`team-match-foul-reasons-${i}`}
                          className="flex flex-wrap gap-1.5"
                        >
                          {m.foul_reasons.map((key) => (
                            <span
                              key={key}
                              className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning"
                            >
                              {foulReasonLabel(key)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {m.notes ? (
                        <span className="text-zinc-500">“{m.notes}”</span>
                      ) : null}
                      <button
                        type="button"
                        data-testid={`team-match-fullreport-${i}`}
                        onClick={() => props.onOpenReport(m)}
                        className="self-start rounded-lg border border-foreground/40 bg-accent px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-muted"
                      >
                        View full report
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

export default function TeamView(props: TeamViewProps): JSX.Element {
  const { eventKey, selectedTeam } = props;
  const [selected, setSelected] = useState<number | null>(selectedTeam ?? null);
  const [teamSearch, setTeamSearch] = useState('');
  const [openReportId, setOpenReportId] = useState<string | null>(null);

  // Manual selection: update local state AND notify the parent so the choice
  // persists across tab switches (the parent feeds it back via `selectedTeam`).
  const chooseTeam = (team: number | null): void => {
    setSelected(team);
    props.onSelectTeam?.(team);
  };

  // Sync from the incoming prop (e.g. a click in Ranking) without clobbering
  // manual dropdown changes: only when the prop names a real, different team.
  useEffect(() => {
    setSelected(selectedTeam ?? null);
  }, [selectedTeam]);

  useEffect(() => {
    setOpenReportId(null);
    setTeamSearch('');
  }, [eventKey, selected]);

  const teamsQuery = useEventTeams(eventKey);
  const reportsQuery = useEventReports(eventKey);
  const scoutsQuery = useEventScouts(eventKey);
  const pitQuery = useTeamPit(eventKey, selected);

  // Resolve a scout_id → display name for per-report attribution.
  const scoutNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scoutsQuery.data ?? []) m.set(s.id, s.display_name ?? '(unnamed)');
    return m;
  }, [scoutsQuery.data]);
  const scoutName = (id: string | null | undefined): string =>
    id ? scoutNameById.get(id) ?? '(unknown)' : 'unassigned';

  // EPA only for the selected team (never hard-fail on Statbotics outage).
  // Pass the event matches so EPA can fall back to a local estimate (computed
  // from real results) when Statbotics is offline.
  const epaTeams = useMemo(() => (selected != null ? [selected] : []), [selected]);
  const matchesQuery = useEventMatches(eventKey);
  const epaQuery = useEventEpa(epaTeams, eventKey, matchesQuery.data ?? []);

  // Aggregate the whole event once; index the selected team's TeamAgg out of it.
  const reports = reportsQuery.data ?? [];
  const openReport = openReportId
    ? reports.find((report) => msrReportIdentity(report) === openReportId) ?? null
    : null;
  const aggByTeam = useMemo(() => aggregateEvent(reports), [reports]);

  // Multi-scout conflicts across the whole event once; the selected team's
  // groups derive from byTeam (no per-team detector run). byRobotKey backs the
  // O(1) per-scouted-match-row marker lookup in TeamDetail.
  const conflicts = useMultiScoutConflicts(reports);
  const teamGroups = selected != null ? conflicts.byTeam.get(selected) ?? [] : [];
  const teamConflictCount = teamGroups.filter((g) => g.isConflicted).length;

  const loading = teamsQuery.isLoading || reportsQuery.isLoading;
  const teams = teamsQuery.data ?? [];

  const agg = selected != null ? aggByTeam.get(selected) : undefined;
  const teamMatches = useMemo(
    () =>
      selected != null
        ? reports
            .filter((r) => r.target_team_number === selected && !r.deleted)
            .sort(
              (a, b) =>
                compareMatchKeys(a.match_key, b.match_key) ||
                msrReportIdentity(a).localeCompare(msrReportIdentity(b)),
            )
        : [],
    [reports, selected],
  );

  // The team's most-recent scouted match (latest by chronological match order)
  // anchors the last-match video + timeline. Null when nothing's been scouted.
  const lastReport = useMemo(() => {
    if (teamMatches.length === 0) return null;
    return teamMatches.reduce((latest, r) =>
      compareMatchKeys(r.match_key, latest.match_key) > 0 ? r : latest,
    );
  }, [teamMatches]);

  // EPA node: number when available, "unavailable" note when Statbotics is down.
  const epa = epaQuery.data;
  const externalEpa = selected != null ? epa?.epaByTeam.get(selected) ?? null : null;
  const epaValue =
    externalEpa ?? (agg && agg.matchesScouted > 0 ? agg.scoutingExpectedPoints : null);
  const epaAvailable = epaValue != null;
  const selectedEpaSource =
    selected != null
      ? epa?.sourceByTeam?.get(selected) ?? (externalEpa != null ? epa?.source : undefined)
      : undefined;
  const epaIsLocal = selectedEpaSource === 'local';
  const epaIsScouting = externalEpa == null && epaValue != null;
  const epaNode = (
    <div data-testid="team-epa">
      {epaAvailable ? (
        <div className="flex flex-col items-start gap-2">
          <span className="text-2xl font-semibold text-energy">{fmt(epaValue as number)}</span>
          {epaIsScouting ? (
            <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
              In-house estimate from scouting data.
            </span>
          ) : epaIsLocal ? (
            <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
              Local estimate — Statbotics offline (computed from match results).
            </span>
          ) : (
            <span className="rounded-full border border-energy/40 bg-energy/15 px-2 py-0.5 text-xs font-medium text-energy">
              Statbotics EPA (total points).
            </span>
          )}
        </div>
      ) : (
        <span className="text-sm text-zinc-400">
          EPA unavailable — Statbotics is offline or has no data for this team.
        </span>
      )}
    </div>
  );

  const pitNode = (
    <PitPanel
      pit={pitQuery.data ?? null}
      isLoading={pitQuery.isLoading}
      scoutName={scoutName}
    />
  );

  // Compact robot-photo thumbnail for the team header: scouted pit photo if
  // present, else a TBA fallback. Resolved HERE (same query key as the thumb →
  // shared cache, no double fetch) so photoNode is truly null when no image
  // exists — TeamDetail then gives the TBA card the full width instead of
  // reserving a dead 16rem grid column beside it.
  const pitPhotoPaths =
    pitQuery.data?.photos?.map((photo) => photo.path).filter((path): path is string => Boolean(path)) ?? [];
  const photoQuery = useTeamPhoto(
    eventKey,
    selected,
    pitQuery.data?.photoPath ?? null,
    pitPhotoPaths,
  );
  const photoThumb =
    selected != null && photoQuery.data?.url ? (
      <TeamPhotoThumb
        eventKey={eventKey}
        teamNumber={selected}
        pitPhotoPath={pitQuery.data?.photoPath ?? null}
        pitPhotoPaths={pitPhotoPaths}
      />
    ) : null;

  // TBA + last-match nodes only make sense once a team is chosen.
  const tbaNode =
    selected != null ? (
      <TeamTbaPanel team={selected} eventKey={eventKey} matches={matchesQuery.data ?? []} />
    ) : null;
  // The MatchRow backing the last scouted match — feeds the alliances/score
  // panel beside the video. Null when the schedule isn't loaded for that key.
  const lastMatchRow = useMemo(
    () =>
      lastReport != null
        ? matchesQuery.data?.find((m) => m.match_key === lastReport.match_key) ?? null
        : null,
    [lastReport, matchesQuery.data],
  );
  const lastMatchNode =
    lastReport && selected != null ? (
      <LastMatchCard
        report={lastReport}
        match={lastMatchRow}
        teamNumber={selected}
        onOpenMatch={props.onOpenMatch}
      />
    ) : null;

  // Live search results (number or nickname). Cheap over a ~50-team list, so no
  // memo; only non-empty while the user is typing.
  const teamSearchQ = teamSearch.trim().toLowerCase();
  const matchedTeams =
    teamSearchQ === ''
      ? []
      : teams
          .slice()
          .sort((a, b) => a.team_number - b.team_number)
          .filter(
            (t) =>
              String(t.team_number).includes(teamSearchQ) ||
              (t.nickname?.toLowerCase().includes(teamSearchQ) ?? false),
          );
  const selectedTeamRow =
    selected == null ? null : teams.find((team) => team.team_number === selected) ?? null;

  return (
    <div data-testid="dash-team" className="flex flex-col gap-4 text-zinc-100">
      <Card
        data-testid="team-picker"
        className="border-zinc-800 bg-zinc-950/80 shadow-sm"
      >
        <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(13rem,18rem)] lg:items-stretch">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div>
                <h2 className="font-display text-base font-semibold text-zinc-100">Find a team</h2>
                <p className="text-xs text-zinc-500">Search the event roster or browse every team.</p>
              </div>
              <span className="font-mono text-xs text-zinc-500">
                {teams.length} team{teams.length === 1 ? '' : 's'} at event
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(15rem,0.8fr)] md:items-start">
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="team-search" className="text-xs font-medium text-zinc-400">
                  Search roster
                </label>
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500"
                  />
                  <input
                    id="team-search"
                    type="search"
                    inputMode="search"
                    data-testid="team-search"
                    value={teamSearch}
                    onChange={(e) => setTeamSearch(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter jumps straight to the top match — fast keyboard select.
                      if (e.key === 'Enter' && matchedTeams.length > 0) {
                        e.preventDefault();
                        chooseTeam(matchedTeams[0].team_number);
                        setTeamSearch('');
                      }
                    }}
                    placeholder="Team number or nickname…"
                    aria-label="Search teams by number or name"
                    aria-controls={teamSearchQ !== '' ? 'team-search-results' : undefined}
                    aria-expanded={teamSearchQ !== ''}
                    style={{ minHeight: CONTROL_MIN_HEIGHT }}
                    className={cn(
                      'w-full rounded-md border border-zinc-700 bg-zinc-900 py-2 pl-10 pr-3 text-sm text-zinc-100 placeholder:text-zinc-500',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand',
                    )}
                  />
                </div>
                {/* Live results: typing shows clickable matches (a filtered <select> only
                    changes the collapsed dropdown, which reads as "nothing happened"). */}
                {teamSearchQ !== '' ? (
                  matchedTeams.length === 0 ? (
                    <div
                      id="team-search-results"
                      data-testid="team-search-empty"
                      role="status"
                      className="px-1 py-2 text-sm text-zinc-400"
                    >
                      No teams match your search.
                    </div>
                  ) : (
                    <ul
                      id="team-search-results"
                      data-testid="team-search-results"
                      aria-label="Matching teams"
                      className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900/80 p-1"
                    >
                      {matchedTeams.slice(0, 60).map((t) => (
                        <li key={t.team_number}>
                          <button
                            type="button"
                            data-testid={`team-search-result-${t.team_number}`}
                            onClick={() => {
                              chooseTeam(t.team_number);
                              setTeamSearch('');
                            }}
                            style={{ minHeight: CONTROL_MIN_HEIGHT }}
                            className={cn(
                              'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm',
                              selected === t.team_number
                                ? 'bg-brand/15 text-zinc-100'
                                : 'text-zinc-200 hover:bg-zinc-800',
                              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand',
                            )}
                          >
                            <span className="font-mono font-semibold tabular-nums text-brand">
                              {t.team_number}
                            </span>
                            {t.nickname ? (
                              <span className="truncate text-zinc-400">{t.nickname}</span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </div>

              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="team-select" className="text-xs font-medium text-zinc-400">
                  Browse roster
                </label>
                <select
                  id="team-select"
                  data-testid="team-select"
                  value={selected ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    chooseTeam(v === '' ? null : Number(v));
                  }}
                  style={{ minHeight: CONTROL_MIN_HEIGHT }}
                  className={cn(
                    'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand',
                  )}
                >
                  <option value="">Select a team…</option>
                  {teams
                    .slice()
                    .sort((a, b) => a.team_number - b.team_number)
                    .map((t) => (
                      <option key={t.team_number} value={t.team_number}>
                        {t.team_number}
                        {t.nickname ? ` — ${t.nickname}` : ''}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </div>

          <div
            data-testid="team-picker-context"
            className="flex min-h-20 items-center border-t border-zinc-800 pt-4 lg:min-h-0 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0"
            aria-live="polite"
          >
            {selected == null ? (
              <div className="flex items-center gap-3 text-zinc-400">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-zinc-800 bg-zinc-900">
                  <Users aria-hidden="true" className="size-5 text-zinc-500" />
                </span>
                <div>
                  <p className="text-sm font-medium text-zinc-300">No team selected</p>
                  <p className="text-xs text-zinc-500">Choose one to open its profile.</p>
                </div>
              </div>
            ) : (
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  Viewing team
                </p>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-bold tabular-nums text-brand">
                    {selected}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {teamMatches.length} scouted
                  </span>
                </div>
                {selectedTeamRow?.nickname ? (
                  <p className="mt-0.5 truncate text-sm text-zinc-300">
                    {selectedTeamRow.nickname}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </Card>

      {loading ? (
        <div
          data-testid="team-loading"
          role="status"
          className="flex flex-col gap-4"
        >
          <span className="sr-only">Loading event data…</span>
          {/* Skeleton approximating the team profile: a title bar, the TBA/photo
              row, and a couple of stat cards, pulsing while event data loads.
              role=status + sr-only text keep the loading state announced to
              screen readers; the decorative bars below stay unlabeled. */}
          <div className="flex items-center gap-3">
            <div className="h-6 w-32 rounded-lg bg-muted/40 motion-safe:animate-pulse" />
            <div className="h-4 w-24 rounded-lg bg-muted/40 motion-safe:animate-pulse" />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="h-40 rounded-xl bg-muted/40 motion-safe:animate-pulse" />
            <div className="h-40 rounded-xl bg-muted/40 motion-safe:animate-pulse" />
          </div>
          <div className="h-32 rounded-xl bg-muted/40 motion-safe:animate-pulse" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-16 rounded-lg bg-muted/40 motion-safe:animate-pulse"
              />
            ))}
          </div>
        </div>
      ) : selected == null ? (
        <div
          data-testid="team-prompt"
          className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card/40 px-4 py-10 text-center text-muted-foreground"
        >
          <Users className="size-8 text-muted-foreground/60" />
          <p className="text-sm">Pick a team above to see its scouting profile.</p>
        </div>
      ) : agg ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-zinc-100">Team {selected}</span>
            <span data-testid="team-matches-scouted" className="text-sm text-zinc-400">
              {agg.matchesScouted} match{agg.matchesScouted === 1 ? '' : 'es'} scouted
            </span>
          </div>
          <TeamDetail
            key={`${eventKey}:${selected}`}
            agg={agg}
            teamNumber={selected}
            matches={teamMatches}
            tbaNode={tbaNode ?? <></>}
            photoNode={photoThumb}
            lastMatchNode={lastMatchNode}
            epaNode={epaNode}
            pitNode={pitNode}
            scoutName={scoutName}
            onOpenReport={(report) => setOpenReportId(msrReportIdentity(report))}
            conflictByRobotKey={conflicts.byRobotKey}
            robotKey={conflicts.robotKey}
            conflictCount={teamConflictCount}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <span className="text-xl font-bold text-zinc-100">Team {selected}</span>
          {/* TBA stats beside the fixed-size robot photo — same 2-col layout as
              the scouted branch, so a pit-only team's photo stays a standard
              size instead of filling the header. Photo collapses below on
              narrow screens; full-width TBA card when there's no photo. */}
          {photoThumb ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
              {tbaNode}
              {photoThumb}
            </div>
          ) : (
            tbaNode
          )}
          <div
            data-testid="team-no-data"
            className="rounded-md border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400"
          >
            No scouting reports for team {selected} at this event yet.
            {/* EPA may still be available; show it so the team isn't a dead end. */}
            <div className="mt-3">{epaNode}</div>
          </div>
          {/* Pit data may still exist even without match reports. */}
          {pitNode}
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
        data-testid="team-report-sheet"
      >
        {openReport ? (
          <ReportDetail
            report={openReport}
            scoutName={scoutName(openReport.scout_id)}
            conflictGroup={conflicts.byRobotKey.get(conflicts.robotKey(openReport))}
            siblingName={scoutName}
            onOpenSibling={(report) => setOpenReportId(msrReportIdentity(report))}
          />
        ) : null}
      </Sheet>
    </div>
  );
}
