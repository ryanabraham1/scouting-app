// src/dash/strategy/StrategyView.tsx
// The Strategy tab — everything a drive coach needs for a pre-match strategy
// meeting with alliance partners, optimized for an iPad (44px targets, field
// whiteboard full-width) but responsive down to a phone.
//
//   * Auto-tracks OUR next match (Nexus-preferred, schedule fallback — the same
//     trackedNextMatch chain the Pit Display uses) with a manual pin override.
//     Auto-switching is DEFERRED while ink is mid-stroke so the board never
//     swaps out under a moving pen.
//   * Field whiteboard (FieldWhiteboard): freehand plays over the field image,
//     saved offline-first to Dexie and merge-synced to `strategy_canvas`
//     (stroke-id union — two iPads in one meeting are additive). Realtime
//     (useEventLiveSync) folds a partner device's strokes in live.
//   * The match-prediction breakdown MOVED here from the old Next Match tab:
//     win-prob banner, alliance columns (enriched with component splits,
//     super-scout ratings, pit facts), EPA health banners.
//   * Alliance Matchup synthesis + per-opponent notes (MatchupPanel) and the
//     combined auto-routine field round out the meeting view.
//
// Everything renders from the persisted query cache, and the field image is
// precached by the service worker — the whole tab works with zero wifi.

import { useEffect, useMemo, useRef, useState } from 'react';
import { LocateFixed, Maximize2, Minimize2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useFullscreen } from '@/dash/useFullscreen';
import { useSync } from '@/sync/useSync';
import {
  useEventMatches,
  useEventReports,
  useEventTeams,
  useEventEpa,
  useEventComponentEpas,
  useNexusEventStatus,
  type MatchRow,
} from '@/dash/useEventData';
import { aggregateEvent } from '@/dash/aggregate';
import { predictMatch } from '@/dash/predict';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';
import {
  trackedNextMatch,
  lastMatchForTeam,
  lastMatchOverall,
} from '@/dash/nextMatch';
import {
  redTeamsOf,
  blueTeamsOf,
  sortMatchesForSelect,
  matchOptionLabel,
  shortTime,
} from '@/dash/matchOrder';
import { formatMatchKeyRaw } from '@/lib/formatMatch';
import { useEventPits } from '@/dash/useTeamPit';
import CombinedAutoField, { defaultMatchupOverlays } from '@/dash/CombinedAutoField';
import MatchupPanel from '@/dash/MatchupPanel';
import FieldWhiteboard from '@/dash/strategy/FieldWhiteboard';
import { useStrategyCanvas } from '@/dash/strategy/strategyCanvasClient';
import {
  WinProbBanner,
  AllianceColumn,
  EpaBanners,
} from '@/dash/strategy/PredictionPanel';
import type { MsrRow } from '@/dash/types';

export interface StrategyViewProps {
  /** The active event key (injected by the shell — do NOT resolve it here). */
  eventKey: string;
}

export default function StrategyView({ eventKey }: StrategyViewProps): JSX.Element {
  const baseTeam = getStoredBaseTeam();
  // Fullscreen for the meeting (mirrors Pit Display's kiosk toggle).
  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(containerRef);
  // Mount the sync controller so the whiteboard/notes outbox drains from this
  // tab too (mount, online edge, poll, and the `scout-sync-changed` nudge).
  useSync();

  const matchesQ = useEventMatches(eventKey);
  const reportsQ = useEventReports(eventKey);
  const teamsQ = useEventTeams(eventKey);
  // Optional-call guards mirror NextMatchView: unit tests mock useEventData.
  const nexusQ = useNexusEventStatus?.(eventKey);
  const nexus = nexusQ?.data ?? { status: null, available: false };
  const nexusLive = nexus.available && nexus.status != null && !nexus.stale;
  const liveStatus = nexusLive ? nexus.status : null;

  const allMatches = useMemo(() => matchesQ.data ?? [], [matchesQ.data]);
  const sortedMatches = useMemo(() => sortMatchesForSelect(allMatches), [allMatches]);

  // OUR next match to TRACK (Nexus-preferred → schedule → last played → last
  // overall) — identical fallback chain to the Pit Display.
  const trackedMatch = useMemo(
    () =>
      allMatches.length
        ? trackedNextMatch(allMatches, baseTeam, liveStatus) ??
          lastMatchForTeam(allMatches, baseTeam) ??
          lastMatchOverall(allMatches)
        : null,
    [allMatches, baseTeam, liveStatus],
  );

  // Pin/track state machine (moved from NextMatchView): tracking auto-follows
  // trackedMatch; the first manual selection pins. NEW: while a stroke is being
  // drawn, the auto-snap is deferred so the whiteboard never swaps mid-ink.
  const [tracking, setTracking] = useState(true);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [drawingActive, setDrawingActive] = useState(false);
  const trackedKey = trackedMatch?.match_key ?? null;
  useEffect(() => {
    if (drawingActive) return; // defer the snap until the pen lifts
    if (tracking && trackedKey && trackedKey !== pinnedKey) {
      setPinnedKey(trackedKey);
    }
  }, [tracking, trackedKey, pinnedKey, drawingActive]);

  const match: MatchRow | null = useMemo(() => {
    if (pinnedKey) {
      const found = allMatches.find((m) => m.match_key === pinnedKey);
      if (found) return found;
    }
    return trackedMatch;
  }, [pinnedKey, allMatches, trackedMatch]);

  const selectMatch = (key: string): void => {
    setTracking(false);
    setPinnedKey(key);
  };
  const startTracking = (): void => {
    setTracking(true);
    setPinnedKey(trackedKey);
  };
  const driftedFromTracked =
    !tracking || (trackedKey != null && match?.match_key !== trackedKey);

  const redTeams = useMemo(() => (match ? redTeamsOf(match) : []), [match]);
  const blueTeams = useMemo(() => (match ? blueTeamsOf(match) : []), [match]);
  const sixTeams = useMemo(() => [...redTeams, ...blueTeams], [redTeams, blueTeams]);
  const ourSide: 'red' | 'blue' | null = redTeams.includes(baseTeam)
    ? 'red'
    : blueTeams.includes(baseTeam)
      ? 'blue'
      : null;

  // Prediction inputs (moved from NextMatchView, plus the component fraction so
  // every team row can show its auto/fuel/climb split).
  const epaQ = useEventEpa(sixTeams, eventKey, allMatches);
  const componentQ = useEventComponentEpas?.(sixTeams, eventKey);
  const fraction = componentQ?.data?.fraction;
  const playedMatches = useMemo(
    () =>
      allMatches.filter((m) => m.actual_red_score != null && m.actual_blue_score != null)
        .length,
    [allMatches],
  );

  // Memoized: this view re-renders every Nexus poll / realtime invalidation, and
  // aggregateEvent + predictMatch are O(reports) passes.
  const reports = useMemo(() => reportsQ.data ?? [], [reportsQ.data]);
  const agg = useMemo(() => aggregateEvent(reports), [reports]);
  const epa = useMemo(
    () =>
      epaQ.data ?? {
        epaByTeam: new Map<number, number | null>(),
        available: false,
        source: 'none' as const,
      },
    [epaQ.data],
  );
  const pred = useMemo(
    () =>
      predictMatch({
        redTeams,
        blueTeams,
        agg,
        epaByTeam: epa.epaByTeam,
        statboticsAvailable: epa.available,
        fraction,
        playedMatches,
      }),
    [redTeams, blueTeams, agg, epa, fraction, playedMatches],
  );

  // Per-team raw reports for the rating means; pit facts per team.
  const reportsByTeam = useMemo(() => {
    const map = new Map<number, MsrRow[]>();
    for (const t of sixTeams) map.set(t, []);
    for (const r of reports) {
      const arr = map.get(r.target_team_number);
      if (arr) arr.push(r);
    }
    return map;
  }, [reports, sixTeams]);
  const pitsQ = useEventPits?.(eventKey);
  const pitByTeam = pitsQ?.data;

  // The whiteboard doc for THIS match (server+local merge; realtime refreshes).
  const canvasQ = useStrategyCanvas(eventKey, match?.match_key ?? null);

  // Auto-routine underlay toggle for the whiteboard.
  const [showAutos, setShowAutos] = useState(true);
  const underlays = useMemo(
    () => (showAutos ? defaultMatchupOverlays(redTeams, blueTeams, reports) : []),
    [showAutos, redTeams, blueTeams, reports],
  );

  const loading = matchesQ.isLoading || reportsQ.isLoading || teamsQ.isLoading;

  if (loading) {
    return (
      <div data-testid="dash-strategy" className="text-foreground">
        <div data-testid="dash-strategy-loading" className="p-6 text-sm text-muted-foreground">
          Loading strategy…
        </div>
      </div>
    );
  }

  if (!match) {
    return (
      <div data-testid="dash-strategy" className="text-foreground">
        <div
          data-testid="dash-strategy-no-match"
          className="rounded-md border border-border bg-card/40 p-6 text-sm text-muted-foreground"
        >
          No matches found for this event.
        </div>
      </div>
    );
  }

  const allTeams = teamsQ.data ?? [];
  const matchTime = shortTime(match.scheduled_time);

  return (
    <div
      ref={containerRef}
      data-testid="dash-strategy"
      className={cn(
        'flex flex-col gap-4 text-foreground',
        fullscreen.isFullscreen && 'h-screen w-screen overflow-y-auto bg-background p-6',
      )}
    >
      {/* Header: match identity + selector + tracking + fullscreen. */}
      <div className="flex flex-col gap-2 rounded-lg bg-black/30 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">
            <span data-testid="dash-strategy-title">{formatMatchKeyRaw(match.match_key)}</span>
            {matchTime ? (
              <span className="ml-3 text-base font-medium text-muted-foreground">
                {matchTime}
              </span>
            ) : null}
            {tracking && match.match_key === trackedKey ? (
              <span
                data-testid="dash-next-tracking"
                className="ml-3 inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand/15 px-2 py-0.5 align-middle text-[11px] font-semibold uppercase tracking-wide text-brand"
              >
                <LocateFixed className="size-3" />
                Tracking
              </span>
            ) : null}
          </h2>
          <div className="flex items-center gap-2">
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
            {fullscreen.supported ? (
              <button
                type="button"
                data-testid="dash-strategy-fullscreen"
                onClick={fullscreen.toggle}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card/60 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
                aria-label={fullscreen.isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              >
                {fullscreen.isFullscreen ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Maximize2 className="size-4" />
                )}
              </button>
            ) : null}
          </div>
        </div>
        <select
          id="dash-next-match-select"
          data-testid="dash-next-match-select"
          aria-label="Match to strategize"
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

      <EpaBanners available={epa.available} source={epa.source} />

      {/* Whiteboard — full width so the field is as large as the screen allows
          (the 2.46:1 field would be cramped in a split column on an iPad). */}
      <Card className="border-border">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
          <CardTitle className="text-foreground">Whiteboard</CardTitle>
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              data-testid="dash-strategy-autos-toggle"
              checked={showAutos}
              onChange={(e) => setShowAutos(e.target.checked)}
              className="size-4 accent-[hsl(var(--brand))]"
            />
            Show auto routines
          </label>
        </CardHeader>
        <CardContent className="p-4 pt-2">
          <FieldWhiteboard
            key={`${eventKey}:${match.match_key}`}
            eventKey={eventKey}
            matchKey={match.match_key}
            remoteDoc={canvasQ.data}
            underlays={underlays}
            onDrawingActiveChange={setDrawingActive}
          />
        </CardContent>
      </Card>

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
          reportsByTeam={reportsByTeam}
          pitByTeam={pitByTeam}
          baseTeam={baseTeam}
          isOurs={ourSide === 'red'}
        />
        <AllianceColumn
          side="blue"
          label="Blue Alliance"
          score={pred.blue.score}
          teams={pred.blue.teams}
          agg={agg}
          allTeams={allTeams}
          reportsByTeam={reportsByTeam}
          pitByTeam={pitByTeam}
          baseTeam={baseTeam}
          isOurs={ourSide === 'blue'}
        />
      </div>

      {/* Synthesized exploit/watch guidance + persistent per-opponent notes. */}
      <MatchupPanel
        eventKey={eventKey}
        redTeams={redTeams}
        blueTeams={blueTeams}
        ourSide={ourSide}
        redAggs={redTeams.map((t) => agg.get(t))}
        blueAggs={blueTeams.map((t) => agg.get(t))}
      />

      {/* ONE combined auto field for the whole matchup — each team's latest auto
          drawn on the side they'll actually play. */}
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
