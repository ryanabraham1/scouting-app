// src/dash/NextMatchView.tsx
// Broadcast-style next-match dashboard (contracts §3, §8 testid `dash-next`).
// A hero card anchored on OUR (3256) next match leads; live "On Field" /
// "Queuing" tiles and an "Upcoming" rail are fed by FRC Nexus when available and
// degrade to the schedule otherwise; the confidence-weighted prediction
// breakdown (alliance expected points, win prob, source badges, auto routines)
// stays below. Pure/injectable: the active event is passed via props.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, LocateFixed } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { formatMatchKey, compareMatchKeys } from '@/lib/formatMatch';
import { predictMatch, type TeamPrediction } from '@/dash/predict';
import CombinedAutoField from '@/dash/CombinedAutoField';
import EventStream from '@/dash/EventStream';
import { EventRankSummary, parseTbaRankings } from '@/dash/Leaderboard';
import SeasonStats from '@/dash/SeasonStats';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';
import {
  trackedNextMatch,
  lastMatchForTeam,
  lastMatchOverall,
  matchRowForNexus,
  nexusMatchesRow,
  isUnplayedMatch,
} from '@/dash/nextMatch';

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

/** PLAY order: comp level (qm→ef→qf→sf→f) then the set/game key tail — so
 *  double-elim playoff sets order correctly (sf1m1 < sf2m1), not tied at 1. */
const LEVEL_ORDER: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
function byPlay(a: MatchRow, b: MatchRow): number {
  const la = LEVEL_ORDER[a.comp_level] ?? 9;
  const lb = LEVEL_ORDER[b.comp_level] ?? 9;
  return la !== lb ? la - lb : compareMatchKeys(a.match_key, b.match_key);
}
function sortMatchesForSelect(matches: MatchRow[]): MatchRow[] {
  return matches.slice().sort(byPlay);
}

/** "in 7 min" / "in 1h 5m" / "now" for a future unix-ms target; null if absent. */
function untilLabel(targetMs: number | null | undefined, nowMs: number): string | null {
  if (targetMs == null) return null;
  const mins = Math.round((targetMs - nowMs) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

/** A clock that re-renders every `intervalMs` so ETAs stay fresh between pushes. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
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

/** Compress a match label to broadcast form: "Qualification 15"/"Qual 15" → "Q15". */
function shortMatchLabel(label: string): string {
  const m = /(\d+)\s*$/.exec(label);
  const num = m ? m[1] : '';
  const lower = label.toLowerCase();
  // Order matters: test the more specific prefixes BEFORE the bare "q", otherwise
  // "Quarterfinal"/"Quarter" gets swallowed by the "q" → "Q{n}" branch.
  if (lower.startsWith('qf') || lower.startsWith('quarter')) return `QF${num}`;
  if (lower.startsWith('sf') || lower.startsWith('semi')) return `SF${num}`;
  if (lower.startsWith('qm') || lower.startsWith('qual') || lower.startsWith('q')) return `Q${num}`;
  if (lower.startsWith('f') || lower.startsWith('final')) return `F${num}`;
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
}

function AllianceColumn({ side, label, score, teams, agg, allTeams }: AllianceColumnProps) {
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
      </CardContent>
    </Card>
  );
}

/**
 * Broadcast win-probability banner: a split red↔blue bar proportional to the
 * win odds, with both percentages called out boldly and the favored alliance
 * emphasized. Predicted alliance scores flank the bar for context. This is the
 * single most important predictive number, so it crowns the alliance columns.
 */
function WinProbBanner({
  redWinProb,
  redScore,
  blueScore,
}: {
  redWinProb: number;
  redScore: number;
  blueScore: number;
}) {
  const redProb = Math.min(1, Math.max(0, redWinProb));
  const blueProb = 1 - redProb;
  const redFavored = redProb >= blueProb;
  // Clamp the bar split so the trailing side never fully vanishes (keeps both
  // colors legible even in a blowout prediction).
  const redPct = Math.min(92, Math.max(8, Math.round(redProb * 100)));

  return (
    <div
      data-testid="dash-next-winprob-banner"
      className="overflow-hidden rounded-xl border border-border bg-black/40"
    >
      <div className="flex items-center justify-between px-4 pt-3">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Win Probability
        </span>
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Projected{' '}
          <span className="tabular-nums font-semibold text-red-400">{round(redScore)}</span>
          {' – '}
          <span className="tabular-nums font-semibold text-blue-400">{round(blueScore)}</span>
        </span>
      </div>

      {/* Big call-outs: favored side larger + ring; trailing side dimmed. */}
      <div className="flex items-end justify-between gap-3 px-4 pt-2">
        <div className="flex flex-col">
          <span className="text-xs font-semibold uppercase tracking-wider text-red-400/80">
            Red
          </span>
          <span
            data-testid="dash-next-red-winprob"
            className={cn(
              'tabular-nums font-black leading-none text-red-400',
              redFavored ? 'text-5xl sm:text-6xl' : 'text-3xl sm:text-4xl opacity-70',
            )}
          >
            {pct(redProb)}
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-xs font-semibold uppercase tracking-wider text-blue-400/80">
            Blue
          </span>
          <span
            data-testid="dash-next-blue-winprob"
            className={cn(
              'tabular-nums font-black leading-none text-blue-400',
              !redFavored ? 'text-5xl sm:text-6xl' : 'text-3xl sm:text-4xl opacity-70',
            )}
          >
            {pct(blueProb)}
          </span>
        </div>
      </div>

      {/* The split bar. */}
      <div className="px-4 pb-4 pt-3">
        <div className="flex h-4 w-full overflow-hidden rounded-full ring-1 ring-white/10">
          <div
            className={cn(
              'h-full bg-red-500 transition-all',
              redFavored && 'shadow-[0_0_12px] shadow-red-500/50',
            )}
            style={{ width: `${redPct}%` }}
          />
          <div
            className={cn(
              'h-full flex-1 bg-blue-500 transition-all',
              !redFavored && 'shadow-[0_0_12px] shadow-blue-500/50',
            )}
          />
        </div>
        <div className="mt-1.5 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {redFavored ? (
            <span className="text-red-400">Red favored</span>
          ) : (
            <span className="text-blue-400">Blue favored</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Find the Nexus match whose label corresponds to a scheduled MatchRow
 *  (quals + playoffs — shared resolver in nextMatch.ts). */
function nexusMatchFor(status: NexusEventStatus | null, m: MatchRow | null): NexusMatch | null {
  if (!status || !m) return null;
  return status.matches.find((nm) => nexusMatchesRow(nm, m)) ?? null;
}

/** A compact live-status tile (On Field / Queuing) fed by Nexus, with an ETA. */
function FieldTile({
  label,
  match,
  tone,
  eta,
}: {
  label: string;
  match: NexusMatch | null;
  tone: 'now' | 'next';
  eta?: string | null;
}) {
  // brand cyan = live/now (most time-critical), amber = next/get-ready.
  const bg = tone === 'now' ? 'bg-brand text-background' : 'bg-amber-400 text-neutral-900';
  return (
    <div className={cn('min-w-0 rounded-xl px-4 py-3', bg)}>
      <div className="text-sm font-semibold opacity-80">{label}</div>
      <div className="mt-1 truncate text-3xl font-black leading-none tracking-tight sm:text-4xl">
        {match ? shortMatchLabel(match.label) : '—'}
      </div>
      {eta ? <div className="mt-0.5 truncate text-xs font-semibold opacity-80">{eta}</div> : null}
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
  // Ticking clock so the "in X min" ETAs stay current between Nexus pushes.
  const now = useNow();
  const matchesQ = useEventMatches(eventKey);
  const reportsQ = useEventReports(eventKey);
  const teamsQ = useEventTeams(eventKey);
  // Nexus is optional; in unit tests the data-hooks module is mocked without it,
  // so guard against an undefined result and always degrade gracefully.
  const nexusQ = useNexusEventStatus?.(eventKey);
  const nexus = nexusQ?.data ?? { status: null, available: false };
  // A stale snapshot (no fresh push within NEXUS_STALE_MS) is treated as not-live
  // so the view degrades to the schedule — which now carries real results from the
  // webhook/reconcile — instead of showing a frozen "On Field" tile.
  const nexusLive = nexus.available && nexus.status != null && !nexus.stale;

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

  const allMatches = useMemo(() => matchesQ.data ?? [], [matchesQ.data]);
  const sortedMatches = useMemo(() => sortMatchesForSelect(allMatches), [allMatches]);

  // The live Nexus status (null when Nexus is unavailable) feeds match TRACKING:
  // while tracking, we follow OUR next match as Nexus sees it, falling back to the
  // schedule. Computed here (not just in the broadcast tiles) so the tracked match
  // re-derives whenever live status changes.
  const liveStatus = nexusLive ? nexus.status : null;

  // OUR next match to TRACK — prefer live Nexus, else the schedule (then the
  // first unplayed qm as a last resort so the prediction always has a match).
  // OUR match to anchor on: next unplayed (Nexus-preferred, schedule fallback);
  // when the event is over with nothing left for us, the most recent match we
  // played; finally the event's last match. So a completed event shows the last
  // match instead of an empty state.
  const trackedMatch = useMemo(
    () =>
      allMatches.length
        ? trackedNextMatch(allMatches, baseTeam, liveStatus) ??
          lastMatchForTeam(allMatches, baseTeam) ??
          lastMatchOverall(allMatches)
        : null,
    [allMatches, baseTeam, liveStatus],
  );

  // Tracking mode: when true, the view auto-follows `trackedMatch` (and live-
  // updates as Nexus reports a new next match). The first manual selection from
  // the dropdown drops out of tracking and pins to the chosen match_key.
  const [tracking, setTracking] = useState(true);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  // While tracking, snap the selection to OUR next match whenever it changes.
  // Only setState when the key actually differs to avoid a render loop.
  const trackedKey = trackedMatch?.match_key ?? null;
  useEffect(() => {
    if (tracking && trackedKey && trackedKey !== pinnedKey) {
      setPinnedKey(trackedKey);
    }
  }, [tracking, trackedKey, pinnedKey]);

  // Resolve the viewed match: pinned (if it still exists) else the tracked pick.
  const match = useMemo(() => {
    if (pinnedKey) {
      const found = allMatches.find((m) => m.match_key === pinnedKey);
      if (found) return found;
    }
    return trackedMatch;
  }, [pinnedKey, allMatches, trackedMatch]);

  // Manual selection: pin to a match and stop auto-tracking.
  const selectMatch = (key: string) => {
    setTracking(false);
    setPinnedKey(key);
  };

  // Re-enter tracking and snap back to OUR next match.
  const startTracking = () => {
    setTracking(true);
    setPinnedKey(trackedKey);
  };

  // The selection has DRIFTED from what we'd track (manual mode pointing elsewhere,
  // or a stale pin) — used to offer the "Track our next match" button.
  const driftedFromTracked = !tracking || (trackedKey != null && match?.match_key !== trackedKey);

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
          No matches found for this event.
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


  const status = nexusLive ? nexus.status : null;
  const heroNexus = nexusMatchFor(status, match);
  // Prefer a Nexus live label for the hero; else the formatted schedule label.
  const heroLabelFull = heroNexus?.label ?? formatMatchKey(match.comp_level, match.match_number);
  const heroLabel = shortMatchLabel(heroLabelFull);
  const heroTime =
    shortTimeMs(heroNexus?.times.estimatedStartTime ?? null) ?? shortTime(match.scheduled_time);
  // Status line under the hero match number. Prefer live Nexus ETAs ("Queues in
  // 7 min · on field in 12 min"); else the scheduled time; else, for a finished
  // match (completed event), the final score.
  const heroPlayed = !isUnplayedMatch(match);
  const queueEta = untilLabel(heroNexus?.times.estimatedQueueTime, now);
  const onFieldEta = untilLabel(heroNexus?.times.estimatedOnFieldTime, now);
  const nexState = heroNexus?.status?.toLowerCase();
  let heroStatus: string;
  if (nexState === 'on field') {
    heroStatus = 'On field now';
  } else if (nexState === 'now queuing' || nexState === 'on deck') {
    heroStatus =
      onFieldEta && onFieldEta !== 'now' ? `Queuing now · on field ${onFieldEta}` : 'Queuing now';
  } else if (queueEta || onFieldEta) {
    const parts: string[] = [];
    if (queueEta) parts.push(`Queues ${queueEta}`);
    if (onFieldEta) parts.push(`on field ${onFieldEta}`);
    heroStatus = parts.join(' · ');
  } else if (heroPlayed) {
    const r = match.actual_red_score;
    const b = match.actual_blue_score;
    heroStatus = r != null && b != null ? `Final · ${r}–${b}` : 'Final';
  } else {
    heroStatus = heroTime ? `Scheduled ${heroTime}` : 'Upcoming';
  }
  // ETAs for the live field tiles.
  const onFieldTileEta = (() => {
    const e = untilLabel(status?.onField?.times.estimatedStartTime ?? null, now);
    return e && e !== 'now' ? `starts ${e}` : null;
  })();
  const queuingTileEta = (() => {
    const e = untilLabel(status?.queuing?.times.estimatedOnFieldTime ?? null, now);
    return e ? `on field ${e}` : null;
  })();

  // Upcoming rail: ONLY OUR matches that are STILL TO COME. Sourced from the
  // schedule (the source of truth for who-plays-what) and filtered two ways so a
  // match we've already played never lingers here:
  //   1. drop anything with a result (isUnplayedMatch),
  //   2. drop anything at/before the match Nexus says is on the field — this
  //      removes already-played matches even when their results haven't synced to
  //      the DB yet (Nexus tells us the live frontier). Each row is enriched with
  //      the Nexus label/time when available. (The On-Field/Queuing tiles still
  //      reflect the whole field.)
  const frontierRow =
    (status?.onField ? matchRowForNexus(allMatches, status.onField) : null) ??
    (status?.queuing ? matchRowForNexus(allMatches, status.queuing) : null);
  const upcoming: Array<{ key: string; label: string; red: number[]; blue: number[]; time: string | null; isOurs: boolean }> =
    allMatches
      .filter((m) => redTeamsOf(m).includes(baseTeam) || blueTeamsOf(m).includes(baseTeam))
      .filter((m) => isUnplayedMatch(m))
      .filter((m) => !frontierRow || byPlay(m, frontierRow) > 0)
      .sort(byPlay)
      .slice(0, 6)
      .map((m) => {
        const nm = nexusMatchFor(status, m);
        return {
          key: m.match_key,
          label: nm?.label ?? formatMatchKey(m.comp_level, m.match_number),
          red: redTeamsOf(m),
          blue: blueTeamsOf(m),
          time: dayTimeMs(nm?.times.estimatedStartTime ?? null) ?? dayTime(m.scheduled_time),
          isOurs: true,
        };
      });

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
            </div>
            <div
              data-testid="dash-next-title"
              className="mt-3 break-words text-5xl font-black leading-none tracking-tight sm:text-6xl lg:text-7xl"
            >
              {heroLabel}
            </div>
            <div className="mt-3 text-base font-medium text-red-50/90">{heroStatus}</div>
          </div>

          {/* Live field status — On Field (gray) / Queuing (yellow). */}
          <div className="grid grid-cols-2 gap-3">
            <FieldTile label="On Field" tone="now" match={status?.onField ?? null} eta={onFieldTileEta} />
            <FieldTile label="Queuing" tone="next" match={status?.queuing ?? null} eta={queuingTileEta} />
          </div>

          {/* Upcoming — OUR matches only, broadcast team-grid cards. */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Upcoming
              </div>
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
            {tracking && match?.match_key === trackedKey ? (
              <span
                data-testid="dash-next-tracking"
                className="ml-2 inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-brand"
              >
                <LocateFixed className="size-3" />
                Tracking
              </span>
            ) : null}
          </label>
          {driftedFromTracked && trackedKey ? (
            <Button
              type="button"
              variant="brand"
              size="sm"
              data-testid="dash-next-track-btn"
              onClick={startTracking}
            >
              <LocateFixed className="size-4" />
              Track our next match
            </Button>
          ) : null}
        </div>
        <select
          id="dash-next-match-select"
          data-testid="dash-next-match-select"
          value={match.match_key}
          onChange={(e) => selectMatch(e.target.value)}
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

      {/* Win-probability banner — crowns the red-vs-blue prediction columns. */}
      <WinProbBanner
        redWinProb={pred.redWinProb}
        redScore={pred.red.score}
        blueScore={pred.blue.score}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <AllianceColumn
          side="red"
          label="Red Alliance"
          score={pred.red.score}
          teams={pred.red.teams}
          agg={agg}
          allTeams={allTeams}
        />
        <AllianceColumn
          side="blue"
          label="Blue Alliance"
          score={pred.blue.score}
          teams={pred.blue.teams}
          agg={agg}
          allTeams={allTeams}
        />
      </div>

      {/* ONE combined auto field for the whole matchup — each team's latest auto
          drawn on the side they'll actually play (rotated 180° onto that side when
          it was scouted on the other alliance). */}
      <Card className="border-border">
        <CardHeader className="p-4 pb-0">
          <CardTitle className="text-foreground">Auto routines</CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <CombinedAutoField redTeams={redTeams} blueTeams={blueTeams} reports={reports} />
        </CardContent>
      </Card>
    </div>
  );
}
