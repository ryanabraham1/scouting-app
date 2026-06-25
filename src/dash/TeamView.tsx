// src/dash/TeamView.tsx
// TEAMVIEW (contracts §2 TeamAgg, §5 hooks, §8 testids). A staff-facing team
// deep-dive: pick a team from the event roster, then render that team's TeamAgg
// (fuel breakdown with a rate-FUEL low-confidence chip, climb, defense,
// reliability, scoutingExpectedPoints), its Statbotics EPA (or an "unavailable"
// note when Statbotics is down — never hard-fail), and the team's scouted
// matches. Dark theme, shadcn primitives, 44px touch targets.

import { useEffect, useMemo, useState } from 'react';
import {
  Wrench,
  Cog,
  Sparkles,
  Inbox,
  Image as ImageIcon,
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
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/utils';
import { formatMatchKeyRaw } from '@/lib/formatMatch';
import { aggregateEvent, type TeamAgg } from '@/dash/aggregate';
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
import { useTeamPit, type TeamPit } from '@/dash/useTeamPit';
import ReportDetail from '@/dash/ReportDetail';
import MatchVideo from '@/dash/MatchVideo';
import TeamTimeline from '@/dash/TeamTimeline';
import { MATCH_MS } from '@/dash/matchTimeline';
import { BarChart, LineChart, StackedBar } from '@/dash/charts';
import type { MsrRow } from '@/dash/types';

export interface TeamViewProps {
  eventKey: string;
  /**
   * Team to preselect — e.g. when arriving from a click in Ranking. Syncs the
   * dropdown when it changes; the dropdown still drives manual selection after.
   */
  selectedTeam?: number | null;
}

/** Confidence below this surfaces the rate-FUEL low-confidence chip. */
const LOW_CONFIDENCE_THRESHOLD = 0.7;

const CONTROL_MIN_HEIGHT = 44; // px — touch target floor

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}
function pct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

// Chronological ordering for match keys: quals first, then the playoff rounds,
// then finals — so the "last" scouted match is the latest the team actually
// played, not just the lexicographically-largest key (qm10 < qm9 as strings).
const COMP_ORDER: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
function matchOrder(matchKey: string): number {
  const tail = matchKey.includes('_') ? matchKey.slice(matchKey.lastIndexOf('_') + 1) : matchKey;
  const m = tail.match(/^([a-zA-Z]+)(\d+)/);
  if (!m) return 0;
  const level = COMP_ORDER[m[1].toLowerCase()] ?? 0;
  return level * 100000 + Number(m[2]);
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
  items: string[];
  testid: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" data-testid={props.testid}>
      <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-4">
        {props.icon}
        {props.label}
      </span>
      {props.items.length ? (
        <div className="flex flex-wrap gap-1.5">
          {props.items.map((it) => (
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
 * and overlays OUR activity timeline for that report, with an optional playhead
 * synced to the video (press "Sync to match start" once the video's auto kickoff
 * lines up). The timeline degrades on its own for legacy reports without
 * timestamps; the video degrades to a "no video" note when TBA has none yet.
 */
function LastMatchCard(props: { report: MsrRow }): JSX.Element {
  const { report } = props;
  const [videoSeconds, setVideoSeconds] = useState<number | null>(null);
  const [offsetSeconds, setOffsetSeconds] = useState(0);

  const currentTimeMs = useMemo(() => {
    if (videoSeconds == null || !Number.isFinite(videoSeconds)) return null;
    const ms = (videoSeconds - offsetSeconds) * 1000;
    return Math.max(0, Math.min(MATCH_MS, ms));
  }, [videoSeconds, offsetSeconds]);

  const hasTime = videoSeconds != null && Number.isFinite(videoSeconds);
  const matchSecs = hasTime ? Math.max(0, (videoSeconds as number) - offsetSeconds) : null;

  return (
    <Card className="border-zinc-800 bg-zinc-950" data-testid="team-last-match">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Video className="size-5 text-brand" />
        <CardTitle className="text-zinc-100">
          Last match — {formatMatchKeyRaw(report.match_key)}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="mx-auto w-full max-w-xl">
          <MatchVideo matchKey={report.match_key} onTimeMs={(ms) => setVideoSeconds(ms / 1000)} />
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
      </CardContent>
    </Card>
  );
}

function PitPanel(props: { pit: TeamPit | null; isLoading: boolean }): JSX.Element {
  const { pit, isLoading } = props;
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
          <div data-testid="team-pit-data" className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-4">
                <Cog />
                Drivetrain
              </span>
              <span className="text-base font-semibold text-foreground" data-testid="team-pit-drivetrain">
                {pit.drivetrain ?? '—'}
              </span>
            </div>
            <ChipRow icon={<Cog />} label="Mechanisms" items={pit.mechanisms} testid="team-pit-mechanisms" />
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
            {pit.photoPath ? (
              <div className="flex flex-col gap-1.5" data-testid="team-pit-photo">
                <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-4">
                  <ImageIcon />
                  Photo
                </span>
                <img
                  src={pit.photoPath}
                  alt={`Pit robot for team ${pit.teamNumber}`}
                  className="max-h-64 w-full rounded-xl border border-border object-contain"
                />
              </div>
            ) : null}
            {pit.notes ? (
              <div className="flex flex-col gap-1.5" data-testid="team-pit-notes">
                <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-4">
                  <StickyNote />
                  Notes
                </span>
                <p className="rounded-xl border border-border bg-muted/30 p-3 text-sm leading-relaxed text-foreground">
                  {pit.notes}
                </p>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Trends: data-viz over the team's scouted matches (chronological by match_key).
 * Charts degrade to a "Not enough data to chart" state under 2 reports. Uses the
 * dependency-free SVG chart set with design tokens (brand/energy/success/warning).
 */
function TeamTrends(props: { matches: MsrRow[] }): JSX.Element {
  const { matches } = props;

  // Stable chronological order so x-axis labels read left→right by match.
  const ordered = useMemo(
    () => matches.slice().sort((a, b) => a.match_key.localeCompare(b.match_key)),
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
        <LineChart
          data={climbData}
          color="success"
          yMax={3}
          title="Climb level per match (success-gated)"
          testid="team-trend-climb"
        />
        <LineChart
          data={defenseData}
          color="brand"
          yMax={5}
          title="Defense rating per match"
          testid="team-trend-defense"
        />
      </CardContent>
    </Card>
  );
}

function TeamDetail(props: {
  agg: TeamAgg;
  matches: MsrRow[];
  tbaNode: JSX.Element;
  lastMatchNode: JSX.Element | null;
  epaNode: JSX.Element;
  pitNode: JSX.Element;
  scoutName: (id: string | null | undefined) => string;
  onOpenReport: (r: MsrRow) => void;
}): JSX.Element {
  const { agg, matches, scoutName } = props;
  const lowConfidence = agg.meanFuelConfidence < LOW_CONFIDENCE_THRESHOLD;
  const downWeight = agg.meanFuelPoints - agg.fuelPointsWeighted;
  // Index of the expanded scouted-match row (click to reveal that report's detail).
  const [openRow, setOpenRow] = useState<number | null>(null);

  return (
    <div data-testid="team-detail" className="flex flex-col gap-4">
      {/* The Blue Alliance: rank, record, season stats, location. */}
      {props.tbaNode}

      {/* Last-match video + our activity timeline. */}
      {props.lastMatchNode}

      {/* Fuel */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <Flame className="size-5 text-energy" />
            Fuel
          </CardTitle>
          {lowConfidence ? (
            <span
              data-testid="team-fuel-lowconf-chip"
              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-300"
              title="FUEL is rate-derived; points are down-weighted by fuel_estimate_confidence."
            >
              rate-FUEL · low confidence ({pct(agg.meanFuelConfidence)})
            </span>
          ) : null}
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
            label="Mean fuel points (raw)"
            value={fmt(agg.meanFuelPoints)}
            testid="team-mean-fuel-points"
          />
          <Stat
            label="Fuel points (weighted)"
            value={fmt(agg.fuelPointsWeighted)}
            testid="team-fuel-points-weighted"
            hint={`down-weighted −${fmt(downWeight)} (×${fmt(agg.meanFuelConfidence, 2)})`}
            tone="energy"
          />
        </CardContent>
      </Card>

      {/* Climb / defense / reliability */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="space-y-0">
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <Mountain className="size-5 text-success" />
            Climb · Defense · Reliability
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat
            label="Climb success"
            value={pct(agg.climbSuccessRate)}
            testid="team-climb-success-rate"
            tone={
              agg.climbSuccessRate >= 0.6 ? 'success' : agg.climbSuccessRate >= 0.3 ? 'warning' : 'default'
            }
          />
          <Stat label="Avg climb level" value={fmt(agg.avgClimbLevel)} testid="team-avg-climb-level" />
          <Stat
            label="Mean climb points"
            value={fmt(agg.meanClimbPoints)}
            testid="team-mean-climb-points"
          />
          <Stat
            label="Avg defense"
            value={fmt(agg.avgDefenseRating)}
            testid="team-avg-defense-rating"
            tone="brand"
          />
          <Stat
            label="Reliability"
            value={pct(agg.reliability)}
            testid="team-reliability"
            hint={`no-show ${pct(agg.noShowRate)} · died ${pct(agg.diedRate)}`}
            tone={
              agg.reliability >= 0.85 ? 'success' : agg.reliability >= 0.6 ? 'warning' : 'destructive'
            }
          />
          <Stat
            label="Scouting expected pts"
            value={fmt(agg.scoutingExpectedPoints)}
            testid="team-scouting-expected"
          />
        </CardContent>
      </Card>

      {/* Trends — per-match data-viz over this team's scouted matches. */}
      <TeamTrends matches={matches} />

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

      {/* Scouted matches */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="space-y-0">
          <CardTitle className="flex items-center gap-2 text-zinc-100">
            <ListChecks className="size-5 text-brand" />
            Scouted matches ({matches.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul data-testid="team-match-list" className="flex flex-col gap-2">
            {matches.map((m, i) => {
              const climb = m.climb_success ? `L${m.climb_level}` : 'no climb';
              const open = openRow === i;
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
                    <span className="font-semibold">{formatMatchKeyRaw(m.match_key)}</span>
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
  const [openReport, setOpenReport] = useState<MsrRow | null>(null);

  // Sync from the incoming prop (e.g. a click in Ranking) without clobbering
  // manual dropdown changes: only when the prop names a real, different team.
  useEffect(() => {
    if (selectedTeam != null && selectedTeam !== selected) {
      setSelected(selectedTeam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeam]);

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
  const aggByTeam = useMemo(() => aggregateEvent(reports), [reports]);

  const loading = teamsQuery.isLoading || reportsQuery.isLoading;
  const teams = teamsQuery.data ?? [];

  const agg = selected != null ? aggByTeam.get(selected) : undefined;
  const teamMatches = useMemo(
    () =>
      selected != null
        ? reports.filter((r) => r.target_team_number === selected && !r.deleted)
        : [],
    [reports, selected],
  );

  // The team's most-recent scouted match (latest by chronological match order)
  // anchors the last-match video + timeline. Null when nothing's been scouted.
  const lastReport = useMemo(() => {
    if (teamMatches.length === 0) return null;
    return teamMatches.reduce((latest, r) =>
      matchOrder(r.match_key) > matchOrder(latest.match_key) ? r : latest,
    );
  }, [teamMatches]);

  // EPA node: number when available, "unavailable" note when Statbotics is down.
  const epa = epaQuery.data;
  const epaValue = selected != null ? epa?.epaByTeam.get(selected) ?? null : null;
  const epaAvailable = epa?.available === true && epaValue != null;
  const epaIsLocal = epa?.source === 'local';
  const epaNode = (
    <div data-testid="team-epa">
      {epaAvailable ? (
        <div className="flex flex-col items-start gap-2">
          <span className="text-2xl font-semibold text-energy">{fmt(epaValue as number)}</span>
          {epaIsLocal ? (
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

  const pitNode = <PitPanel pit={pitQuery.data ?? null} isLoading={pitQuery.isLoading} />;

  // TBA + last-match nodes only make sense once a team is chosen.
  const tbaNode =
    selected != null ? (
      <TeamTbaPanel team={selected} eventKey={eventKey} matches={matchesQuery.data ?? []} />
    ) : null;
  const lastMatchNode = lastReport ? <LastMatchCard report={lastReport} /> : null;

  return (
    <div data-testid="dash-team" className="flex flex-col gap-4 text-zinc-100">
      <div className="flex flex-col gap-2">
        <label htmlFor="team-select" className="text-sm font-medium text-zinc-300">
          Team
        </label>
        <select
          id="team-select"
          data-testid="team-select"
          value={selected ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            setSelected(v === '' ? null : Number(v));
          }}
          style={{ minHeight: CONTROL_MIN_HEIGHT }}
          className={cn(
            'w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500',
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

      {loading ? (
        <div data-testid="team-loading" className="text-sm text-zinc-400">
          Loading event data…
        </div>
      ) : selected == null ? (
        <div data-testid="team-prompt" className="text-sm text-zinc-400">
          Pick a team to see its scouting profile.
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
            agg={agg}
            matches={teamMatches}
            tbaNode={tbaNode ?? <></>}
            lastMatchNode={lastMatchNode}
            epaNode={epaNode}
            pitNode={pitNode}
            scoutName={scoutName}
            onOpenReport={setOpenReport}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* TBA rank/record/season stats need no scouting reports — show them. */}
          {tbaNode}
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
        onClose={() => setOpenReport(null)}
        side="right"
        title={
          openReport
            ? `${formatMatchKeyRaw(openReport.match_key)} · Team ${openReport.target_team_number}`
            : ''
        }
        data-testid="team-report-sheet"
      >
        {openReport ? (
          <ReportDetail report={openReport} scoutName={scoutName(openReport.scout_id)} />
        ) : null}
      </Sheet>
    </div>
  );
}
