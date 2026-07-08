// src/dash/NextMatchView.tsx
// "Pit Display" — broadcast-style next-match screen (testid `dash-next`) for a
// kiosk/pit TV. A hero card anchored on OUR (3256) next match leads; live
// "On Field" / "Queuing" tiles and an "Upcoming" rail are fed by FRC Nexus when
// available and degrade to the schedule otherwise. The match-prediction and
// auto-routine breakdowns MOVED to the Strategy tab (src/dash/strategy/), so
// this screen carries no reports/EPA queries at all — it purely auto-tracks.
// Pure/injectable: the active event is passed via props.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFullscreen } from '@/dash/useFullscreen';
import {
  useEventMatches,
  useNexusEventStatus,
  useEventInfo,
  useTbaRankings,
  useTeamSeasonStats,
  type MatchRow,
} from '@/dash/useEventData';
import type { NexusEventStatus, NexusMatch } from '@/dash/nexusClient';
import { formatMatchKeyRaw, formatMatchShort, isQualLevel } from '@/lib/formatMatch';
import { redTeamsOf, blueTeamsOf, byPlay, shortTime } from '@/dash/matchOrder';
import PlayoffPath from '@/dash/PlayoffPath';
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

// redTeamsOf / blueTeamsOf / byPlay / shortTime moved to matchOrder.ts (shared
// with the Strategy tab's match selector).

/** Short HH:MM (local) for a unix-ms timestamp, or null when absent. */
function shortTimeMs(ms: number | null): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

/**
 * Compress a free-form match LABEL (e.g. a Nexus "Semifinal 3 Match 2" or our own
 * "Semi 3-2") to broadcast form: "Qualification 15" → "Q15", "Semi 3-2" → "SF3".
 * For raw match KEYS, prefer `formatMatchShort` (authoritative). Playoff rounds
 * key off the SET number — the FIRST number in the label — so a replayed set
 * ("Semi 3-2") reads "SF3", not the game number "SF2". Finals are best-of-N
 * within one set, so there the LAST number (the game) is the meaningful one.
 */
function shortMatchLabel(label: string): string {
  const lower = label.toLowerCase();
  const first = /(\d+)/.exec(label)?.[1] ?? '';
  const last = /(\d+)\s*$/.exec(label)?.[1] ?? '';
  // Order matters: test the more specific prefixes BEFORE the bare "q", otherwise
  // "Quarterfinal"/"Quarter" gets swallowed by the "q" → "Q{n}" branch.
  if (lower.startsWith('qf') || lower.startsWith('quarter')) return `QF${first}`;
  if (lower.startsWith('sf') || lower.startsWith('semi')) return `SF${first}`;
  if (lower.startsWith('ef') || lower.startsWith('eighth')) return `EF${first}`;
  if (lower.startsWith('qm') || lower.startsWith('qual') || lower.startsWith('q')) return `Q${first}`;
  if (lower.startsWith('f') || lower.startsWith('final')) return `F${last || first}`;
  const initial = label.trim().charAt(0).toUpperCase();
  return first ? `${initial}${first}` : label;
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

// TeamRowView / AllianceColumn / WinProbBanner moved to
// src/dash/strategy/PredictionPanel.tsx (Strategy tab).

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
  /** True when `label` is a live Nexus label (else it's our formatted schedule label). */
  nexusLabel: boolean;
  red: number[];
  blue: number[];
  time: string | null;
  isOurs: boolean;
}
function UpcomingCard({ u, baseTeam }: { u: UpcomingItem; baseTeam: number }) {
  const idx = [0, 1, 2];
  // Authoritative set-correct short label from the raw key when there's no Nexus
  // label; else compress the Nexus label string.
  const short = u.nexusLabel ? shortMatchLabel(u.label) : formatMatchShort(u.key);
  return (
    <li className="overflow-hidden rounded-lg border-l-4 border-red-500 bg-card/60">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="font-bold text-foreground">{short}</span>
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
  // Playoffs have started once the schedule carries any non-qual match. Then the
  // flat "upcoming" list (which can't express bracket structure) is replaced by
  // the double-elim bracket.
  const hasPlayoffs = useMemo(
    () => allMatches.some((m) => !isQualLevel(m.comp_level)),
    [allMatches],
  );

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

  // Pit Display purely AUTO-TRACKS — the manual match selector (and the whole
  // prediction data layer: reports, EPA, aggregateEvent, predictMatch) moved to
  // the Strategy tab.
  const match = trackedMatch;

  const loading = matchesQ.isLoading;

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

  const status = nexusLive ? nexus.status : null;
  const heroNexus = nexusMatchFor(status, match);
  // For the compact hero number use the authoritative raw-key short label when we
  // have no Nexus label (set-correct for double-elim replays); else compress the
  // Nexus label string.
  const heroLabel = heroNexus?.label
    ? shortMatchLabel(heroNexus.label)
    : formatMatchShort(match.match_key);
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
  const upcoming: UpcomingItem[] =
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
          label: nm?.label ?? formatMatchKeyRaw(m.match_key),
          nexusLabel: nm?.label != null,
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
          className="min-w-[12rem] flex-1 truncate text-2xl font-bold tracking-tight text-foreground"
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

        {/* RIGHT — next match hero, live field status, OUR upcoming rail.
            min-w-0 lets the playoff bracket's wide content scroll WITHIN this
            column instead of stretching the grid track. */}
        <div className="flex min-w-0 flex-col gap-3">
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

          {/* During playoffs the flat upcoming list can't express who advances
              where, so it's replaced IN PLACE by OUR bracket path: the match we're
              in, where a win/loss sends us, and who we'd face (the winner/loser of
              another match until it's decided). Otherwise the broadcast team-grid
              cards for OUR upcoming matches. */}
          {hasPlayoffs ? (
            <div data-testid="dash-next-bracket" className="flex flex-col gap-2">
              <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Our Playoff Path
              </div>
              <PlayoffPath matches={allMatches} baseTeam={baseTeam} />
            </div>
          ) : (
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
          )}
        </div>
      </div>

      {/* The prediction breakdown (selector, EPA banners, win prob, alliance
          columns, auto routines) MOVED to the Strategy tab. */}
    </div>
  );
}
