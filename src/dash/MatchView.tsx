// src/dash/MatchView.tsx
// MATCHVIEW — staff-facing match drill-down / cross-check. List the event's
// matches (friendly labels + per-match report count); tap one to see EVERY
// report on that match across stations / teams / scouters. Tap a report row to
// open the FULL per-report detail in a Sheet. Field-Control Console styling.

import { useMemo, useRef, useState } from 'react';
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
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/utils';
import { formatMatchKey, formatMatchKeyRaw } from '@/lib/formatMatch';
import { useEventMatches, useEventReports, useEventScouts } from '@/dash/useEventData';
import ReportDetail from '@/dash/ReportDetail';
import TeamTimeline from '@/dash/TeamTimeline';
import MatchVideo from '@/dash/MatchVideo';
import { MATCH_MS } from '@/dash/matchTimeline';
import type { MsrRow } from '@/dash/types';

export interface MatchViewProps {
  eventKey: string;
}

const CONTROL_MIN_HEIGHT = 56; // px — touch target floor

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
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
  return (
    <Card className="border-border bg-card">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Activity className="size-5 text-brand" />
        <CardTitle className="text-foreground">Activity timelines</CardTitle>
      </CardHeader>
      <CardContent>
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
}): JSX.Element {
  const { matchKey, videoSeconds, offsetSeconds, onTimeMs, onSyncNow, onResetSync } = props;
  const hasTime = videoSeconds != null && Number.isFinite(videoSeconds);
  const matchSecs = hasTime ? Math.max(0, (videoSeconds as number) - offsetSeconds) : null;
  return (
    <Card className="border-border bg-card">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Video className="size-5 text-brand" />
        <CardTitle className="text-foreground">Match video</CardTitle>
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
      </CardContent>
    </Card>
  );
}

function MatchDetail(props: {
  reports: MsrRow[];
  scoutName: (id: string | null | undefined) => string;
  onOpenReport: (r: MsrRow) => void;
}): JSX.Element {
  const { reports, scoutName, onOpenReport } = props;

  return (
    <Card className="border-border bg-card">
      <CardHeader className="space-y-0">
        <CardTitle className="text-foreground">Reports on this match ({reports.length})</CardTitle>
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
                return (
                  <li key={`${r.target_team_number}-${r.station}-${i}`}>
                    <button
                      type="button"
                      data-testid={`match-report-${r.target_team_number}-${r.station}`}
                      onClick={() => onOpenReport(r)}
                      style={{ minHeight: CONTROL_MIN_HEIGHT }}
                      className="flex w-full flex-col gap-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-left text-sm text-foreground hover:bg-muted/60"
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
                            <Shield className="size-4 text-brand" /> {r.defense_rating}
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
                );
              })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function MatchView(props: MatchViewProps): JSX.Element {
  const { eventKey } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<MsrRow | null>(null);

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
    setVideoSeconds(null);
    setOffsetSeconds(0);
    const isNarrow = window.matchMedia?.('(max-width: 1023px)')?.matches;
    if (isNarrow) {
      requestAnimationFrame(() =>
        detailRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }),
      );
    }
  };

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

  const loading = matchesQuery.isLoading || reportsQuery.isLoading;
  const matches = matchesQuery.data ?? [];
  const reports = reportsQuery.data ?? [];
  const scouts = scoutsQuery.data ?? [];

  const countByMatch = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of reports) m.set(r.match_key, (m.get(r.match_key) ?? 0) + 1);
    return m;
  }, [reports]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scouts) m.set(s.id, s.display_name ?? '(unnamed)');
    return m;
  }, [scouts]);
  const scoutName = (id: string | null | undefined): string =>
    id ? nameById.get(id) ?? '(unknown)' : 'unassigned';

  const selectedReports = useMemo(
    () => (selected != null ? reports.filter((r) => r.match_key === selected) : []),
    [reports, selected],
  );

  return (
    <div data-testid="dash-match" className="flex flex-col gap-4 text-foreground">
      {loading ? (
        <div data-testid="match-loading" className="text-sm text-muted-foreground">
          Loading event data…
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[20rem_1fr]">
          <Card className="border-border bg-card lg:sticky lg:top-4">
            <CardHeader className="flex flex-row items-center gap-2 space-y-0">
              <Grid3x3 className="size-5 text-brand" />
              <CardTitle className="text-foreground">Matches ({matches.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {matches.length === 0 ? (
                <div data-testid="match-none" className="text-sm text-muted-foreground">
                  No matches scheduled for this event yet.
                </div>
              ) : (
                <ul
                  data-testid="match-list"
                  className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto pr-1 lg:max-h-[70vh]"
                >
                  {matches.map((m) => {
                    const count = countByMatch.get(m.match_key) ?? 0;
                    const isSel = selected === m.match_key;
                    const label = formatMatchKey(m.comp_level, m.match_number);
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
                          <span
                            className={cn(
                              'tabular-nums',
                              count === 0 ? 'text-warning' : 'text-success',
                            )}
                          >
                            {count} report{count === 1 ? '' : 's'}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <div ref={detailRef} className="flex scroll-mt-4 flex-col gap-4">
            {selected != null ? (
              <>
                {/* Video on top, activity timelines next (so they can be read
                    alongside the video), reports below — stacked. Sits in the
                    main pane so it's visible the moment a match is picked, no
                    scrolling past the match list. */}
                <div
                  data-testid="match-detail-grid"
                  className="flex flex-col items-stretch gap-4"
                >
                  <MatchVideoCard
                    matchKey={selected}
                    videoSeconds={videoSeconds}
                    offsetSeconds={offsetSeconds}
                    onTimeMs={(ms) => setVideoSeconds(ms / 1000)}
                    onSyncNow={() => {
                      if (videoSeconds != null) setOffsetSeconds(videoSeconds);
                    }}
                    onResetSync={() => setOffsetSeconds(0)}
                  />
                  {selectedReports.length > 0 ? (
                    <MatchTimelines reports={selectedReports} currentTimeMs={currentTimeMs} />
                  ) : null}
                  <MatchDetail
                    reports={selectedReports}
                    scoutName={scoutName}
                    onOpenReport={setOpenReport}
                  />
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
        onClose={() => setOpenReport(null)}
        side="right"
        title={
          openReport
            ? `${formatMatchKeyRaw(openReport.match_key)} · Team ${openReport.target_team_number}`
            : ''
        }
        data-testid="match-report-sheet"
      >
        {openReport ? (
          <ReportDetail report={openReport} scoutName={scoutName(openReport.scout_id)} />
        ) : null}
      </Sheet>
    </div>
  );
}
