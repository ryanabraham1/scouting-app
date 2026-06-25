// src/dash/NextMatchView.tsx
// Broadcast-style next-match dashboard (contracts §3, §8 testid `dash-next`).
// A hero card anchored on OUR (3256) next match leads; live "On Field" /
// "Queuing" tiles and an "Upcoming" rail are fed by FRC Nexus when available and
// degrade to the schedule otherwise; the confidence-weighted prediction
// breakdown (alliance expected points, win prob, source badges, auto routines)
// stays below. Pure/injectable: the active event is passed via props.

import { useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useFullscreen } from '@/dash/useFullscreen';
import {
  useEventMatches,
  useEventReports,
  useEventTeams,
  useEventEpa,
  useNexusEventStatus,
  useEventInfo,
  useTbaRankings,
  useTeamSeasonStats,
  type MatchRow,
  type TeamRow,
} from '@/dash/useEventData';
import type { NexusEventStatus, NexusMatch } from '@/dash/nexusClient';
import { aggregateEvent, type TeamAgg } from '@/dash/aggregate';
import { formatMatchKey } from '@/lib/formatMatch';
import { predictMatch, type TeamPrediction } from '@/dash/predict';
import AutoRoutines from '@/dash/AutoRoutines';
import EventStream from '@/dash/EventStream';
import { EventRankSummary, parseTbaRankings } from '@/dash/Leaderboard';
import SeasonStats from '@/dash/SeasonStats';
import { OUR_TEAM } from '@/dash/constants';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';
import type { MsrRow } from '@/dash/types';

export interface NextMatchViewProps {
  /** The active event key (injected by the shell — do NOT resolve it here). */
  eventKey: string;
}

const SOURCE_LABEL: Record<TeamPrediction['source'], string> = {
  blend: 'blend',
  scouting: 'scouting',
  epa: 'epa',
  none: 'none',
};

const SOURCE_CLASS: Record<TeamPrediction['source'], string> = {
  blend: 'bg-brand/15 text-brand border-brand/40',
  scouting: 'bg-success/15 text-success border-success/40',
  epa: 'bg-energy/15 text-energy border-energy/40',
  none: 'bg-muted text-muted-foreground border-border',
};

function redTeamsOf(m: MatchRow): number[] {
  return [m.red1, m.red2, m.red3].filter((t): t is number => t != null);
}
function blueTeamsOf(m: MatchRow): number[] {
  return [m.blue1, m.blue2, m.blue3].filter((t): t is number => t != null);
}
function isUnplayed(m: MatchRow): boolean {
  return m.actual_red_score == null && m.actual_blue_score == null;
}

/**
 * Pick OUR (3256) next unplayed qm: smallest match_number among unplayed qms
 * whose alliances include 3256. Fall back to the first unplayed qm if 3256 has
 * no scheduled unplayed match.
 */
export function pickNextMatch(
  matches: MatchRow[],
  baseTeam: number = OUR_TEAM,
): MatchRow | null {
  const unplayedQms = matches
    .filter((m) => m.comp_level === 'qm' && isUnplayed(m))
    .sort((a, b) => a.match_number - b.match_number);
  if (unplayedQms.length === 0) return null;

  const ours = unplayedQms.find(
    (m) => redTeamsOf(m).includes(baseTeam) || blueTeamsOf(m).includes(baseTeam),
  );
  return ours ?? unplayedQms[0];
}

function round(n: number): number {
  return Math.round(n);
}

/** Short HH:MM (local) for a scheduled_time ISO string, or null when absent. */
function shortTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Short HH:MM (local) for a unix-ms timestamp, or null when absent. */
function shortTimeMs(ms: number | null): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Friendly one-line label for a match in the selector. */
function matchOptionLabel(m: MatchRow): string {
  const name = formatMatchKey(m.comp_level, m.match_number);
  const red = redTeamsOf(m).join('/') || '—';
  const blue = blueTeamsOf(m).join('/') || '—';
  const time = shortTime(m.scheduled_time);
  const played = !isUnplayed(m) ? ' · played' : '';
  return `${name} — R ${red} vs B ${blue}${time ? ` · ${time}` : ''}${played}`;
}

/** Sort matches for the selector: by comp level (qm→sf→f) then match number. */
const LEVEL_ORDER: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
function sortMatchesForSelect(matches: MatchRow[]): MatchRow[] {
  return matches.slice().sort((a, b) => {
    const la = LEVEL_ORDER[a.comp_level] ?? 9;
    const lb = LEVEL_ORDER[b.comp_level] ?? 9;
    if (la !== lb) return la - lb;
    return a.match_number - b.match_number;
  });
}

function nicknameFor(teams: TeamRow[], teamNumber: number): string | null {
  return teams.find((t) => t.team_number === teamNumber)?.nickname ?? null;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** A small inline chip flagging that FUEL points are rate-derived (low conf). */
function FuelLowConfidenceChip() {
  return (
    <span
      data-testid="fuel-low-confidence"
      className="inline-flex items-center rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning"
      title="FUEL is rate-derived; treat its contribution as a low-confidence estimate."
    >
      FUEL est. — low confidence
    </span>
  );
}

/** A live indicator (a pulsing dot) shown when Nexus data is feeding. */
function LiveBadge() {
  return (
    <span
      data-testid="dash-next-live"
      className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success"
    >
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-success" />
      </span>
      Live
    </span>
  );
}

/** Compress a match label to broadcast form: "Qualification 15"/"Qual 15" → "Q15". */
function shortMatchLabel(label: string): string {
  const m = /(\d+)\s*$/.exec(label);
  const num = m ? m[1] : '';
  const lower = label.toLowerCase();
  if (lower.startsWith('q')) return `Q${num}`;
  if (lower.startsWith('sf') || lower.startsWith('semi')) return `SF${num}`;
  if (lower.startsWith('f') || lower.startsWith('final')) return `F${num}`;
  if (lower.startsWith('qf') || lower.startsWith('quarter')) return `QF${num}`;
  const first = label.trim().charAt(0).toUpperCase();
  return num ? `${first}${num}` : label;
}

/** Weekday + short time, e.g. "Wed 2:24 AM", for a unix-ms timestamp. */
function dayTimeMs(ms: number | null): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
/** Weekday + short time for an ISO string. */
function dayTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** One team cell in an upcoming match's 2×3 alliance grid (broadcast style). */
function TeamCell({
  team,
  color,
  mine,
}: {
  team: number | null;
  color: 'red' | 'blue';
  mine: boolean;
}) {
  return (
    <span
      className={cn(
        'px-2 py-1.5 text-center font-mono text-sm font-semibold tabular-nums',
        color === 'red' ? 'bg-red-950/80 text-red-100' : 'bg-blue-950/80 text-blue-100',
        mine && 'bg-amber-400 text-neutral-900',
      )}
    >
      {team ?? ''}
    </span>
  );
}

interface TeamRowViewProps {
  pred: TeamPrediction;
  agg: TeamAgg | undefined;
  nickname: string | null;
}

function TeamRowView({ pred, agg, nickname }: TeamRowViewProps) {
  const matchesScouted = agg?.matchesScouted ?? 0;
  return (
    <li
      data-testid={`dash-next-team-${pred.teamNumber}`}
      className="flex min-h-[44px] flex-col gap-1 rounded-md border border-border bg-card/40 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-foreground">
          {pred.teamNumber}
          {nickname ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">{nickname}</span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums text-foreground" data-testid="dash-next-team-expected">
            {round(pred.expected)} pts
          </span>
          <span
            data-testid="dash-next-source-badge"
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
              SOURCE_CLASS[pred.source],
            )}
          >
            {SOURCE_LABEL[pred.source]}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>scouted: {matchesScouted}</span>
        <span>
          climb:{' '}
          <span
            className={cn(
              'font-medium',
              agg
                ? agg.climbSuccessRate >= 0.7
                  ? 'text-success'
                  : 'text-warning'
                : 'text-muted-foreground',
            )}
          >
            {agg ? pct(agg.climbSuccessRate) : '—'}
          </span>
        </span>
        <span>
          defense:{' '}
          <span className={cn('font-medium', agg ? 'text-brand' : 'text-muted-foreground')}>
            {agg ? agg.avgDefenseRating.toFixed(1) : '—'}
          </span>
        </span>
        <FuelLowConfidenceChip />
      </div>
    </li>
  );
}

interface AllianceColumnProps {
  side: 'red' | 'blue';
  label: string;
  score: number;
  teams: TeamPrediction[];
  agg: Map<number, TeamAgg>;
  allTeams: TeamRow[];
  reports: MsrRow[];
  isOurAlliance: boolean;
  baseTeam: number;
}

function AllianceColumn({
  side,
  label,
  score,
  teams,
  agg,
  allTeams,
  reports,
  isOurAlliance,
  baseTeam,
}: AllianceColumnProps) {
  return (
    <Card
      className={cn(
        'border',
        side === 'red' ? 'border-red-500/40' : 'border-blue-500/40',
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4">
        <CardTitle className="text-foreground">{label}</CardTitle>
        <span
          data-testid={`dash-next-${side}-score`}
          className={cn(
            'tabular-nums text-2xl font-bold',
            side === 'red' ? 'text-red-400' : 'text-blue-400',
          )}
        >
          {round(score)}
        </span>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <ul className="flex flex-col gap-2">
          {teams.map((p) => (
            <TeamRowView
              key={p.teamNumber}
              pred={p}
              agg={agg.get(p.teamNumber)}
              nickname={nicknameFor(allTeams, p.teamNumber)}
            />
          ))}
        </ul>
        <div className="mt-3">
          <AutoRoutines reports={reports} isOurAlliance={isOurAlliance} baseTeam={baseTeam} />
        </div>
      </CardContent>
    </Card>
  );
}

/** Find the Nexus match whose label corresponds to a scheduled MatchRow. */
function nexusMatchFor(status: NexusEventStatus | null, m: MatchRow | null): NexusMatch | null {
  if (!status || !m) return null;
  const label = formatMatchKey(m.comp_level, m.match_number);
  // Nexus labels are like "Qualification 12"; ours are "Qual 12". Match on the
  // trailing number plus a shared level prefix to stay defensive.
  return (
    status.matches.find((nm) => {
      const a = nm.label.toLowerCase();
      return a.endsWith(` ${m.match_number}`) && a.split(' ')[0].startsWith(label.split(' ')[0].toLowerCase().slice(0, 4));
    }) ?? null
  );
}

/** A compact live-status tile (On Field / Queuing) fed by Nexus. */
function FieldTile({
  label,
  match,
  tone,
}: {
  label: string;
  match: NexusMatch | null;
  tone: 'now' | 'next';
}) {
  // brand cyan = live/now (most time-critical), amber = next/get-ready.
  const bg = tone === 'now' ? 'bg-brand text-background' : 'bg-amber-400 text-neutral-900';
  return (
    <div className={cn('min-w-0 rounded-xl px-4 py-3', bg)}>
      <div className="text-sm font-semibold opacity-80">{label}</div>
      <div className="mt-1 truncate text-3xl font-black leading-none tracking-tight sm:text-4xl">
        {match ? shortMatchLabel(match.label) : '—'}
      </div>
    </div>
  );
}

/** One upcoming match: label + time header, then a 2×3 alliance team grid. */
interface UpcomingItem {
  key: string;
  label: string;
  red: number[];
  blue: number[];
  time: string | null;
  isOurs: boolean;
}
function UpcomingCard({ u, baseTeam }: { u: UpcomingItem; baseTeam: number }) {
  const idx = [0, 1, 2];
  return (
    <li className="overflow-hidden rounded-lg border-l-4 border-red-500 bg-card/60">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="font-bold text-foreground">{shortMatchLabel(u.label)}</span>
        {u.time ? <span className="text-xs text-muted-foreground">{u.time}</span> : null}
      </div>
      <div className="grid grid-cols-3 gap-px bg-border/30 p-px">
        {idx.map((i) => (
          <TeamCell key={`r${i}`} team={u.red[i] ?? null} color="red" mine={u.red[i] === baseTeam} />
        ))}
        {idx.map((i) => (
          <TeamCell key={`b${i}`} team={u.blue[i] ?? null} color="blue" mine={u.blue[i] === baseTeam} />
        ))}
      </div>
    </li>
  );
}

export default function NextMatchView({ eventKey }: NextMatchViewProps): JSX.Element {
  // The base/"our" team — configurable in Setup so the whole view can pivot onto
  // another team for testing events 3256 isn't registered at. Defaults to 3256.
  const baseTeam = getStoredBaseTeam();
  // Fullscreen the broadcast view for a kiosk/display (driver station, pit TV).
  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(containerRef);
  const matchesQ = useEventMatches(eventKey);
  const reportsQ = useEventReports(eventKey);
  const teamsQ = useEventTeams(eventKey);
  // Nexus is optional; in unit tests the data-hooks module is mocked without it,
  // so guard against an undefined result and always degrade gracefully.
  const nexusQ = useNexusEventStatus?.(eventKey);
  const nexus = nexusQ?.data ?? { status: null, available: false };
  const nexusLive = nexus.available && nexus.status != null;

  // Broadcast-panel data sources (all degrade gracefully; each may be absent in
  // unit tests that mock useEventData, so guard the optional-call result).
  const eventInfoQ = useEventInfo?.(eventKey);
  const eventInfo = eventInfoQ?.data ?? { name: null, webcast: null };
  const rankingsQ = useTbaRankings?.(eventKey);
  const rankRows = useMemo(() => parseTbaRankings(rankingsQ?.data), [rankingsQ?.data]);
  const ourRankRow = rankRows.find((r) => r.teamNumber === baseTeam) ?? null;
  const seasonQ = useTeamSeasonStats?.(baseTeam, eventKey, matchesQ.data ?? []);
  const season =
    seasonQ?.data ?? {
      worldRank: null,
      totalEpa: null,
      epaSource: 'none' as const,
      seasonRecord: null,
    };

  // User-overridable selection. `null` means "follow the auto-picked next match";
  // once the user picks, we pin to that match_key.
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);

  const allMatches = useMemo(() => matchesQ.data ?? [], [matchesQ.data]);
  const sortedMatches = useMemo(() => sortMatchesForSelect(allMatches), [allMatches]);
  const autoMatch = useMemo(
    () => (allMatches.length ? pickNextMatch(allMatches, baseTeam) : null),
    [allMatches, baseTeam],
  );

  // Resolve the viewed match: pinned (if it still exists) else the auto-pick.
  const match = useMemo(() => {
    if (pinnedKey) {
      const found = allMatches.find((m) => m.match_key === pinnedKey);
      if (found) return found;
    }
    return autoMatch;
  }, [pinnedKey, allMatches, autoMatch]);

  const redTeams = match ? redTeamsOf(match) : [];
  const blueTeams = match ? blueTeamsOf(match) : [];
  const sixTeams = [...redTeams, ...blueTeams];

  // Always call the hook (stable order); it is disabled internally when empty.
  // Pass matches so EPA can fall back to a local computation when Statbotics is down.
  const epaQ = useEventEpa(sixTeams, eventKey, allMatches);

  const loading = matchesQ.isLoading || reportsQ.isLoading || teamsQ.isLoading;

  if (loading) {
    return (
      <div data-testid="dash-next" className="text-foreground">
        <div data-testid="dash-next-loading" className="p-6 text-sm text-muted-foreground">
          Loading next match…
        </div>
      </div>
    );
  }

  if (!match) {
    return (
      <div data-testid="dash-next" className="text-foreground">
        <div
          data-testid="dash-next-no-match"
          className="rounded-md border border-border bg-card/40 p-6 text-sm text-muted-foreground"
        >
          No upcoming unplayed qualification match found.
        </div>
      </div>
    );
  }

  const reports = reportsQ.data ?? [];
  const allTeams = teamsQ.data ?? [];
  const epa = epaQ.data ?? {
    epaByTeam: new Map<number, number | null>(),
    available: false,
    source: 'none' as const,
  };

  const agg = aggregateEvent(reports);
  const pred = predictMatch({
    redTeams,
    blueTeams,
    agg,
    epaByTeam: epa.epaByTeam,
    statboticsAvailable: epa.available,
  });

  const ourAllianceIsRed = redTeams.includes(baseTeam);
  const redReports = reports.filter((r) => redTeams.includes(r.target_team_number));
  const blueReports = reports.filter((r) => blueTeams.includes(r.target_team_number));

  const status = nexusLive ? nexus.status : null;
  const heroNexus = nexusMatchFor(status, match);
  // Prefer a Nexus live label for the hero; else the formatted schedule label.
  const heroLabelFull = heroNexus?.label ?? formatMatchKey(match.comp_level, match.match_number);
  const heroLabel = shortMatchLabel(heroLabelFull);
  const heroTime =
    shortTimeMs(heroNexus?.times.estimatedStartTime ?? null) ?? shortTime(match.scheduled_time);
  // Status line under the hero match number, broadcast-style ("queuing soon").
  const heroStatus =
    heroNexus?.status?.toLowerCase() === 'now queuing'
      ? 'queuing soon'
      : heroNexus?.status
        ? heroNexus.status
        : heroTime
          ? `scheduled ${heroTime}`
          : 'upcoming';

  // Upcoming rail: ONLY OUR (3256) upcoming matches — prefer Nexus' ordered list,
  // else the schedule. (The On-Field/Queuing tiles still reflect the whole field.)
  const nexusOursUpcoming = (status?.upcoming ?? []).filter(
    (nm) => nm.redTeams.includes(baseTeam) || nm.blueTeams.includes(baseTeam),
  );
  const upcoming: Array<{ key: string; label: string; red: number[]; blue: number[]; time: string | null; isOurs: boolean }> =
    nexusOursUpcoming.length > 0
      ? nexusOursUpcoming.slice(0, 6).map((nm, i) => ({
          key: `${nm.label}-${i}`,
          label: nm.label,
          red: nm.redTeams,
          blue: nm.blueTeams,
          time: dayTimeMs(nm.times.estimatedStartTime),
          isOurs: true,
        }))
      : allMatches
          .filter(
            (m) =>
              isUnplayed(m) &&
              (redTeamsOf(m).includes(baseTeam) || blueTeamsOf(m).includes(baseTeam)),
          )
          .sort((a, b) => a.match_number - b.match_number)
          .slice(0, 6)
          .map((m) => ({
            key: m.match_key,
            label: formatMatchKey(m.comp_level, m.match_number),
            red: redTeamsOf(m),
            blue: blueTeamsOf(m),
            time: dayTime(m.scheduled_time),
            isOurs: true,
          }));

  return (
    <div
      ref={containerRef}
      data-testid="dash-next"
      className={cn(
        'flex flex-col gap-4 text-foreground',
        fullscreen.isFullscreen && 'h-screen w-screen overflow-y-auto bg-background p-6',
      )}
    >
      {/* Top bar: event name (left) · base team + key + fullscreen (right). */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/30 px-4 py-3">
        <h2
          data-testid="dash-next-event-title"
          className="min-w-0 flex-1 truncate text-2xl font-bold tracking-tight text-foreground"
        >
          {eventInfo.name ?? eventKey}
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold text-muted-foreground">
            <span className="text-foreground">{baseTeam}</span> | {eventKey}
          </span>
          {fullscreen.supported ? (
            <button
              type="button"
              data-testid="dash-next-fullscreen"
              onClick={fullscreen.toggle}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card/60 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
              aria-label={fullscreen.isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {fullscreen.isFullscreen ? (
                <Minimize2 className="size-4" />
              ) : (
                <Maximize2 className="size-4" />
              )}
              {fullscreen.isFullscreen ? 'Exit' : 'Fullscreen'}
            </button>
          ) : null}
        </div>
      </div>

      {/* Broadcast grid (no leaderboard): LEFT = livestream + event/season
          rankings; RIGHT = OUR next match + live field status + OUR upcoming. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        {/* LEFT — livestream over the event & season ranking blocks. */}
        <div className="flex flex-col gap-4">
          <EventStream webcast={eventInfo.webcast} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <EventRankSummary row={ourRankRow} teamCount={rankRows.length || null} />
            <SeasonStats
              team={baseTeam}
              worldRank={season.worldRank}
              totalEpa={season.totalEpa}
              epaSource={season.epaSource}
              seasonRecord={season.seasonRecord}
            />
          </div>
        </div>

        {/* RIGHT — next match hero, live field status, OUR upcoming rail. */}
        <div className="flex flex-col gap-3">
          {/* Next match — the loud red hero card. */}
          <div className="rounded-xl bg-red-600 px-6 py-6 text-white">
            <div className="flex items-center justify-between gap-2">
              <span className="text-base font-semibold">{baseTeam} Next Match</span>
              {nexusLive ? <LiveBadge /> : null}
            </div>
            <div
              data-testid="dash-next-title"
              className="mt-3 break-words text-5xl font-black leading-none tracking-tight sm:text-6xl lg:text-7xl"
            >
              {heroLabel}
            </div>
            <div className="mt-3 text-base font-medium capitalize text-red-50/90">{heroStatus}</div>
          </div>

          {/* Live field status — On Field (gray) / Queuing (yellow). */}
          <div className="grid grid-cols-2 gap-3">
            <FieldTile label="On Field" tone="now" match={status?.onField ?? null} />
            <FieldTile label="Queuing" tone="next" match={status?.queuing ?? null} />
          </div>

          {/* Upcoming — OUR matches only, broadcast team-grid cards. */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Upcoming
              </div>
              {nexusLive ? <LiveBadge /> : null}
            </div>
            {upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">No upcoming matches for {baseTeam}.</p>
            ) : (
              <ul data-testid="dash-next-upcoming" className="flex flex-col gap-2">
                {upcoming.map((u) => (
                  <UpcomingCard key={u.key} u={u} baseTeam={baseTeam} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Prediction breakdown — keep the selector + per-team detail + auto routines. */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="dash-next-match-select" className="text-sm font-medium text-muted-foreground">
            Prediction for match
          </label>
          <span className="text-sm text-muted-foreground">
            Red win{' '}
            <span
              data-testid="dash-next-red-winprob"
              className={cn(
                'font-bold tabular-nums',
                pred.redWinProb > 0.5 ? 'text-red-400' : 'text-blue-400',
              )}
            >
              {pct(pred.redWinProb)}
            </span>
          </span>
        </div>
        <select
          id="dash-next-match-select"
          data-testid="dash-next-match-select"
          value={match.match_key}
          onChange={(e) => setPinnedKey(e.target.value)}
          className={cn(
            'w-full max-w-xl rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground',
            'min-h-[44px] tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          {sortedMatches.map((m) => (
            <option key={m.match_key} value={m.match_key}>
              {matchOptionLabel(m)}
            </option>
          ))}
        </select>
      </div>

      {!epa.available ? (
        <div
          data-testid="epa-unavailable"
          role="status"
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          Statbotics EPA unavailable — predictions use scouting only.
        </div>
      ) : epa.source === 'local' ? (
        <div
          data-testid="epa-local"
          role="status"
          className="rounded-md border border-energy/40 bg-energy/10 px-3 py-2 text-sm text-energy"
        >
          Statbotics offline — EPA estimated from this event's results.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <AllianceColumn
          side="red"
          label="Red Alliance"
          score={pred.red.score}
          teams={pred.red.teams}
          agg={agg}
          allTeams={allTeams}
          reports={redReports}
          isOurAlliance={ourAllianceIsRed}
          baseTeam={baseTeam}
        />
        <AllianceColumn
          side="blue"
          label="Blue Alliance"
          score={pred.blue.score}
          teams={pred.blue.teams}
          agg={agg}
          allTeams={allTeams}
          reports={blueReports}
          isOurAlliance={!ourAllianceIsRed}
          baseTeam={baseTeam}
        />
      </div>
    </div>
  );
}
