// src/dash/strategy/StrategyView.tsx
// The Strategy tab — everything a drive coach needs for a pre-match strategy
// meeting with alliance partners, optimized for an iPad (44px targets, field
// whiteboard full-width) but responsive down to a phone.
//
//   * Two sub-views (segmented selector): WHITEBOARD (the drawing boards) and
//     ANALYTICS (prediction, team cards, matchup intel, auto routines) — so a
//     meeting can flip between planning and data without scrolling soup.
//   * FIVE whiteboards per match, one per game phase (Auto / Transition /
//     Active / Inactive / Endgame). The Auto board carries draggable
//     robot-sized start squares for OUR alliance, one color per team, with a
//     color key underneath. Every board saves offline-first to Dexie and
//     merge-syncs to `strategy_canvas` (stroke-id union + newer-robot-wins),
//     with realtime folding a partner device's changes in live.
//   * Auto-tracks OUR next match (Nexus-preferred, schedule fallback) with a
//     manual pin override — the selector lists ONLY matches we play in.
//     Auto-switching defers while ink is mid-stroke.
//   * MANUAL TEAMS: the lineup can be typed in by hand (PWA/no-schedule case,
//     or what-if planning). With no schedule at all the tab still works — the
//     boards key to '__manual__' and keep cloud-syncing.
//
// Everything renders from the persisted query cache, and the field image is
// precached by the service worker — the whole tab works with zero wifi.

import { useEffect, useMemo, useRef, useState } from 'react';
import { LocateFixed, Maximize2, Minimize2, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
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
import FieldWhiteboard, { type RobotSeed } from '@/dash/strategy/FieldWhiteboard';
import {
  useStrategyCanvas,
  MANUAL_MATCH_KEY,
} from '@/dash/strategy/strategyCanvasClient';
import {
  WHITEBOARD_PHASES,
  type WhiteboardPhase,
} from '@/dash/strategy/strokes';
import { WinProbBanner, AllianceColumn } from '@/dash/strategy/PredictionPanel';
import type { MsrRow } from '@/dash/types';

export interface StrategyViewProps {
  /** The active event key (injected by the shell — do NOT resolve it here). */
  eventKey: string;
}

type SubView = 'board' | 'analytics';

const PHASE_LABEL: Record<WhiteboardPhase, string> = {
  auto: 'Auto',
  transition: 'Transition',
  active: 'Active',
  inactive: 'Inactive',
  endgame: 'Endgame',
};

/** Stable per-slot colors for OUR alliance's start squares (and their key). */
const ROBOT_COLORS = ['#f59e0b', '#22d3ee', '#a855f7'];

/** One alliance's half of the matchup strip: big tappable-size team chips in
 *  alliance colors, the base team in amber, OUR side badged. Always visible —
 *  including on the whiteboard view — so the matchup never needs the selector
 *  to read. */
function MatchupAllianceChips({
  side,
  teams,
  baseTeam,
  isOurs,
}: {
  side: 'red' | 'blue';
  teams: number[];
  baseTeam: number;
  isOurs: boolean;
}): JSX.Element {
  return (
    <div
      data-testid={`dash-strategy-matchup-${side}`}
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border px-2.5 py-1.5',
        side === 'red' ? 'border-red-500/40 bg-red-950/30' : 'border-blue-500/40 bg-blue-950/30',
        isOurs && 'ring-1 ring-amber-400/60',
      )}
    >
      <span
        className={cn(
          'text-[10px] font-bold uppercase tracking-wider',
          side === 'red' ? 'text-red-400' : 'text-blue-400',
        )}
      >
        {side}
      </span>
      {isOurs ? (
        <span className="rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none text-neutral-900">
          us
        </span>
      ) : null}
      {teams.length === 0 ? (
        <span className="px-1 text-sm text-muted-foreground">—</span>
      ) : (
        teams.map((t) => (
          <span
            key={t}
            className={cn(
              'rounded-md px-2 py-1 font-mono text-base font-bold tabular-nums sm:text-lg',
              t === baseTeam
                ? 'bg-amber-400 text-neutral-900'
                : side === 'red'
                  ? 'bg-red-950/80 text-red-100'
                  : 'bg-blue-950/80 text-blue-100',
            )}
          >
            {t}
          </span>
        ))
      )}
    </div>
  );
}

interface ManualTeams {
  red: number[];
  blue: number[];
}

function manualTeamsStorageKey(eventKey: string): string {
  return `strategy_manual_teams:${eventKey}`;
}

function loadManualTeams(eventKey: string): ManualTeams | null {
  try {
    const raw = localStorage.getItem(manualTeamsStorageKey(eventKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ManualTeams;
    if (!Array.isArray(parsed.red) || !Array.isArray(parsed.blue)) return null;
    return {
      red: parsed.red.filter((t) => Number.isFinite(t) && t > 0),
      blue: parsed.blue.filter((t) => Number.isFinite(t) && t > 0),
    };
  } catch {
    return null;
  }
}

function storeManualTeams(eventKey: string, teams: ManualTeams | null): void {
  try {
    if (teams) localStorage.setItem(manualTeamsStorageKey(eventKey), JSON.stringify(teams));
    else localStorage.removeItem(manualTeamsStorageKey(eventKey));
  } catch {
    /* storage unavailable — manual teams just don't persist */
  }
}

/** Six-input editor for a manual lineup. Controlled by text so partially-typed
 *  numbers don't fight the parser; applied on submit. */
function ManualTeamsEditor({
  initialRed,
  initialBlue,
  onApply,
  onCancel,
  onUseSchedule,
  hasSchedule,
}: {
  initialRed: number[];
  initialBlue: number[];
  onApply: (teams: ManualTeams) => void;
  onCancel: () => void;
  onUseSchedule: () => void;
  hasSchedule: boolean;
}): JSX.Element {
  const toText = (teams: number[]): string[] =>
    [0, 1, 2].map((i) => (teams[i] ? String(teams[i]) : ''));
  const [red, setRed] = useState<string[]>(() => toText(initialRed));
  const [blue, setBlue] = useState<string[]>(() => toText(initialBlue));

  const parse = (vals: string[]): number[] =>
    vals.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0);

  const inputCls =
    'w-full min-h-[44px] rounded-md border border-input bg-background px-2 py-1.5 text-sm tabular-nums text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

  const sideInputs = (
    label: 'Red' | 'Blue',
    vals: string[],
    set: (v: string[]) => void,
  ): JSX.Element => (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span
        className={cn(
          'text-xs font-bold uppercase tracking-wider',
          label === 'Red' ? 'text-red-400' : 'text-blue-400',
        )}
      >
        {label} alliance
      </span>
      <div className="grid grid-cols-3 gap-2">
        {vals.map((v, i) => (
          <input
            key={i}
            type="number"
            inputMode="numeric"
            min={1}
            max={99999}
            placeholder={`${label[0]}${i + 1}`}
            aria-label={`${label} ${i + 1}`}
            data-testid={`manual-team-${label.toLowerCase()}${i + 1}`}
            value={v}
            onChange={(e) => set(vals.map((old, j) => (j === i ? e.target.value : old)))}
            className={inputCls}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div
      data-testid="manual-teams-editor"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3"
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        {sideInputs('Red', red, setRed)}
        {sideInputs('Blue', blue, setBlue)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="brand"
          size="sm"
          data-testid="manual-teams-apply"
          onClick={() => onApply({ red: parse(red), blue: parse(blue) })}
        >
          Apply teams
        </Button>
        {hasSchedule ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="manual-teams-use-schedule"
            onClick={onUseSchedule}
          >
            Use schedule lineup
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
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
  // The selector lists ONLY matches WE play — strategizing someone else's match
  // makes no sense here (what-ifs go through manual teams instead).
  const ourMatches = useMemo(
    () =>
      sortMatchesForSelect(
        allMatches.filter(
          (m) => redTeamsOf(m).includes(baseTeam) || blueTeamsOf(m).includes(baseTeam),
        ),
      ),
    [allMatches, baseTeam],
  );

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
  // trackedMatch; the first manual selection pins. NEW: while a stroke or a
  // robot drag is live, the auto-snap is deferred so the board never swaps
  // mid-ink.
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

  // Manual lineup override (persisted per event). With no schedule at all the
  // tab runs ENTIRELY on manual teams and the '__manual__' board key.
  const [manualTeams, setManualTeams] = useState<ManualTeams | null>(() =>
    loadManualTeams(eventKey),
  );
  const [editingTeams, setEditingTeams] = useState(false);
  const applyManualTeams = (teams: ManualTeams | null): void => {
    setManualTeams(teams);
    storeManualTeams(eventKey, teams);
    setEditingTeams(false);
  };

  const scheduleRed = useMemo(() => (match ? redTeamsOf(match) : []), [match]);
  const scheduleBlue = useMemo(() => (match ? blueTeamsOf(match) : []), [match]);
  const redTeams = manualTeams?.red?.length ? manualTeams.red : scheduleRed;
  const blueTeams = manualTeams?.blue?.length ? manualTeams.blue : scheduleBlue;
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

  // Sub-view + phase board selection.
  const [subView, setSubView] = useState<SubView>('board');
  const [phase, setPhase] = useState<WhiteboardPhase>('auto');

  // The whiteboard doc for THIS (match, phase). '__manual__' when no schedule.
  const boardMatchKey = match?.match_key ?? MANUAL_MATCH_KEY;
  const canvasQ = useStrategyCanvas(eventKey, boardMatchKey, phase);

  // Auto-routine underlay toggle for the whiteboard.
  const [showAutos, setShowAutos] = useState(true);
  const underlays = useMemo(
    () =>
      showAutos && phase === 'auto'
        ? defaultMatchupOverlays(redTeams, blueTeams, reports)
        : [],
    [showAutos, phase, redTeams, blueTeams, reports],
  );

  // Robot start squares (auto board): OUR alliance's teams, one stable color
  // each — the same assignment the color key under the board shows. Defaults
  // spread down our side of the field.
  const robotSeeds = useMemo<RobotSeed[]>(() => {
    if (phase !== 'auto' || !ourSide) return [];
    const teams = ourSide === 'red' ? redTeams : blueTeams;
    const x = ourSide === 'red' ? 0.12 : 0.88;
    const ys = [0.26, 0.5, 0.74];
    return teams.slice(0, 3).map((team, i) => ({
      key: String(team),
      team,
      color: ROBOT_COLORS[i % ROBOT_COLORS.length],
      defaultX: x,
      defaultY: ys[i] ?? 0.5,
    }));
  }, [phase, ourSide, redTeams, blueTeams]);

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

  const allTeams = teamsQ.data ?? [];
  const matchTime = match ? shortTime(match.scheduled_time) : null;
  const manualActive = !!(manualTeams?.red?.length || manualTeams?.blue?.length);
  const noSchedule = !match;

  return (
    <div
      ref={containerRef}
      data-testid="dash-strategy"
      className={cn(
        'flex flex-col gap-4 text-foreground',
        fullscreen.isFullscreen && 'h-screen w-screen overflow-y-auto bg-background p-6',
      )}
    >
      {/* Header row: match identity (left) + selector INLINE with it on wide
          screens (iPad/desktop) + actions (right). Wraps on phones. */}
      <div className="flex flex-col gap-2 rounded-lg bg-black/30 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="flex shrink-0 items-center text-2xl font-bold tracking-tight text-foreground">
            <span data-testid="dash-strategy-title">
              {match ? formatMatchKeyRaw(match.match_key) : 'Manual matchup'}
            </span>
            {matchTime ? (
              <span className="ml-3 text-base font-medium text-muted-foreground">
                {matchTime}
              </span>
            ) : null}
            {match && tracking && match.match_key === trackedKey ? (
              <span
                data-testid="dash-next-tracking"
                className="ml-3 inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand/15 px-2 py-0.5 align-middle text-[11px] font-semibold uppercase tracking-wide text-brand"
              >
                <LocateFixed className="size-3" />
                Tracking
              </span>
            ) : null}
            {manualActive ? (
              <span
                data-testid="dash-strategy-manual-chip"
                className="ml-3 inline-flex items-center rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 align-middle text-[11px] font-semibold uppercase tracking-wide text-warning"
              >
                Manual teams
              </span>
            ) : null}
          </h2>
          {ourMatches.length > 0 ? (
            <select
              id="dash-next-match-select"
              data-testid="dash-next-match-select"
              aria-label="Match to strategize"
              value={match?.match_key ?? ''}
              onChange={(e) => selectMatch(e.target.value)}
              className={cn(
                'min-w-[16rem] max-w-xl flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground',
                'min-h-[44px] tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              {/* OUR matches only. A tracked/pinned match outside the list (edge:
                  base team changed) still renders as a fallback option. */}
              {match && !ourMatches.some((m) => m.match_key === match.match_key) ? (
                <option value={match.match_key}>{matchOptionLabel(match)}</option>
              ) : null}
              {ourMatches.map((m) => (
                <option key={m.match_key} value={m.match_key}>
                  {matchOptionLabel(m)}
                </option>
              ))}
            </select>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {match && driftedFromTracked && trackedKey ? (
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
            <button
              type="button"
              data-testid="dash-strategy-edit-teams"
              onClick={() => setEditingTeams((e) => !e)}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card/60 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
            >
              <Users className="size-4" />
              Teams
            </button>
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
        {ourMatches.length === 0 ? (
          <p data-testid="dash-strategy-no-schedule" className="text-sm text-muted-foreground">
            {noSchedule
              ? 'No schedule yet — enter the teams manually to start strategizing.'
              : `No matches for ${baseTeam} in the schedule — enter teams manually or change the base team in Setup.`}
          </p>
        ) : null}
        {/* The matchup, glanceable from EVERY sub-view (the selector is too
            compact to read across a table): who's with us, who we play. */}
        {redTeams.length > 0 || blueTeams.length > 0 ? (
          <div
            data-testid="dash-strategy-matchup"
            className="flex flex-wrap items-center gap-2"
          >
            <MatchupAllianceChips
              side="red"
              teams={redTeams}
              baseTeam={baseTeam}
              isOurs={ourSide === 'red'}
            />
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              vs
            </span>
            <MatchupAllianceChips
              side="blue"
              teams={blueTeams}
              baseTeam={baseTeam}
              isOurs={ourSide === 'blue'}
            />
          </div>
        ) : null}
        {editingTeams ? (
          <ManualTeamsEditor
            initialRed={redTeams}
            initialBlue={blueTeams}
            hasSchedule={!!match}
            onApply={(teams) => applyManualTeams(teams)}
            onCancel={() => setEditingTeams(false)}
            onUseSchedule={() => applyManualTeams(null)}
          />
        ) : null}
      </div>

      {/* Whiteboard ↔ Analytics sub-view selector. */}
      <SegmentedToggle<SubView>
        ariaLabel="Strategy sub-view"
        value={subView}
        onChange={setSubView}
        size="default"
        options={[
          { value: 'board', label: 'Whiteboard' },
          { value: 'analytics', label: 'Analytics' },
        ]}
      />

      {subView === 'board' ? (
        <Card className="border-border">
          <CardHeader className="flex flex-col gap-2 space-y-0 p-4 pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* One board per game phase. */}
              <SegmentedToggle<WhiteboardPhase>
                ariaLabel="Whiteboard phase"
                value={phase}
                onChange={setPhase}
                size="default"
                className="max-w-2xl"
                options={WHITEBOARD_PHASES.map((p) => ({ value: p, label: PHASE_LABEL[p] }))}
              />
              {phase === 'auto' ? (
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
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <FieldWhiteboard
              key={`${eventKey}:${boardMatchKey}:${phase}`}
              eventKey={eventKey}
              matchKey={boardMatchKey}
              phase={phase}
              remoteDoc={canvasQ.data}
              underlays={underlays}
              robotSeeds={robotSeeds}
              onDrawingActiveChange={setDrawingActive}
            />
          </CardContent>
        </Card>
      ) : (
        <>
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

          {/* ONE combined auto field for the whole matchup — each team's latest
              auto drawn on the side they'll actually play. */}
          <Card className="border-border">
            <CardHeader className="p-4 pb-0">
              <CardTitle className="text-foreground">Auto routines</CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <CombinedAutoField redTeams={redTeams} blueTeams={blueTeams} reports={reports} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
