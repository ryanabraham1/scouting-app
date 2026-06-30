// src/dash/AutoHeatmap.tsx
// Stacks ALL of a single team's stored auto routines (normalized start position +
// drawn path vertices) into one density heatmap on the field image, so staff can
// judge auto CONSISTENCY at a glance (tight cluster = repeatable; scattered =
// improvised) instead of only seeing the most-recent auto the broadcast shows.
//
// Two views, toggled locally (TeamView-local controls — the testids here do NOT
// collide with NextMatchView's `auto-routines-mode-*`):
//   • HEATMAP  — a traditional density field (smooth ramp transparent→blue→cyan→
//     green→yellow→red) of every scouted start + path sample, painted under the
//     field markings.
//   • PATHS    — step through each scouted auto path one at a time (prev/next),
//     drawing that single match's start + path on the field.
//
// Read-only, 100% client-side (no fetch): consumes the already-cached reports the
// caller passes (TeamView passes the team-scoped `matches`; AutoRoutines passes the
// alliance-scoped reports). Defensively re-filters by team so it is correct
// regardless of caller. No scoring/wire-shape change — reads synced columns only.

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Flame, Route } from 'lucide-react';
import { FieldDiagram, type FieldPoint } from '@/components/FieldDiagram';
import { hasAutoData } from '@/dash/AutoRoutines';
import { matchLabelFromKey } from '@/capture/UpcomingMatches';
import type { AllianceColor } from '@/dash/fieldFrame';
import type { MsrRow } from '@/dash/types';

export interface AutoHeatmapProps {
  teamNumber: number;
  /** Already-team-filtered reports (re-filtered here defensively). */
  reports: MsrRow[];
  mirror?: boolean;
  color?: string;
  ['data-testid']?: string;
}

/** A single scouted auto routine, kept whole for the per-path stepper. */
export interface AutoPath {
  matchKey: string;
  label: string;
  start: FieldPoint | null;
  path: FieldPoint[] | null;
  /** Alliance the routine was RECORDED on (absolute-frame coords); lets consumers
   *  re-frame it to the other alliance via the 180° field rotation. */
  alliance: AllianceColor;
}

interface CollectedPoints {
  points: FieldPoint[]; // every start + every path vertex (raw [0,1] space)
  starts: FieldPoint[]; // just the start positions (for the consistency score)
  paths: AutoPath[]; // one entry per report with auto data (for the stepper)
  matchCount: number; // distinct match_key with auto data
  autoCount: number; // reports with auto data
}

export function collectPoints(
  reports: MsrRow[],
  teamNumber: number,
): CollectedPoints {
  const mine = reports.filter(
    (r) => r.target_team_number === teamNumber && hasAutoData(r),
  );
  const points: FieldPoint[] = [];
  const starts: FieldPoint[] = [];
  const paths: AutoPath[] = [];
  for (const r of mine) {
    if (r.auto_start_position) {
      points.push(r.auto_start_position);
      starts.push(r.auto_start_position);
    }
    if (r.auto_path) for (const p of r.auto_path) points.push(p);
    paths.push({
      matchKey: r.match_key,
      label: matchLabelFromKey(r.match_key),
      start: r.auto_start_position ?? null,
      path: r.auto_path ?? null,
      alliance: r.alliance_color === 'blue' ? 'blue' : 'red',
    });
  }
  const matchCount = new Set(mine.map((r) => r.match_key)).size;
  return { points, starts, paths, matchCount, autoCount: mine.length };
}

const mean = (xs: number[]): number =>
  xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * Consistency score 0–100 from how tightly the start positions cluster: 100% when
 * all starts coincide, 0% when the MEAN distance from the centroid reaches a
 * quarter-field. `null` (rendered "—") when fewer than 2 starts. Pure.
 */
export function consistency(starts: FieldPoint[]): number | null {
  if (starts.length < 2) return null;
  const cx = mean(starts.map((p) => p.x));
  const cy = mean(starts.map((p) => p.y));
  const meanDist = mean(starts.map((p) => Math.hypot(p.x - cx, p.y - cy)));
  const SPREAD_FLOOR = 0.25;
  const score = Math.max(0, 1 - meanDist / SPREAD_FLOOR);
  return Math.round(score * 100);
}

type Mode = 'heatmap' | 'paths';

export default function AutoHeatmap(props: AutoHeatmapProps): JSX.Element {
  const {
    teamNumber,
    reports,
    mirror,
    color,
    ['data-testid']: testid = 'team-auto-heatmap',
  } = props;

  const { points, starts, paths, matchCount, autoCount } = useMemo(
    () => collectPoints(reports, teamNumber),
    [reports, teamNumber],
  );
  const score = useMemo(() => consistency(starts), [starts]);

  const [mode, setMode] = useState<Mode>('heatmap');
  const [idx, setIdx] = useState(0);

  if (points.length === 0) {
    return (
      <div data-testid={`${testid}-empty`} className="text-sm text-zinc-400">
        No auto paths recorded.
      </div>
    );
  }

  // Clamp the stepper index defensively (paths can shrink between renders).
  const clampedIdx = paths.length === 0 ? 0 : Math.min(idx, paths.length - 1);
  const current = paths[clampedIdx];
  const step = (delta: number): void => {
    if (paths.length === 0) return;
    const n = clampedIdx + delta;
    setIdx(((n % paths.length) + paths.length) % paths.length); // wrap-around
  };

  const tabBtn = (active: boolean): string =>
    [
      'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
      active
        ? 'bg-zinc-100 text-zinc-900'
        : 'text-zinc-400 hover:text-zinc-200',
    ].join(' ');

  // NOTE: the bare `testid` lives on the FieldDiagram root (so its heatmap layer is
  // `${testid}-heatmap`); the surrounding wrapper uses `-body` to avoid a
  // duplicate-testid collision with that root.
  return (
    <div data-testid={`${testid}-body`} className="flex flex-col gap-2">
      {/* View toggle: aggregate heatmap vs. per-path stepper. */}
      <div
        role="tablist"
        className="inline-flex w-fit gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'heatmap'}
          data-testid="auto-mode-heatmap"
          className={tabBtn(mode === 'heatmap')}
          onClick={() => setMode('heatmap')}
        >
          <Flame className="size-3.5" />
          Heatmap
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'paths'}
          data-testid="auto-mode-paths"
          className={tabBtn(mode === 'paths')}
          onClick={() => setMode('paths')}
        >
          <Route className="size-3.5" />
          Paths
        </button>
      </div>

      <div className="mx-auto w-full max-w-[420px]">
        {mode === 'heatmap' ? (
          <FieldDiagram
            mode="view"
            mirror={mirror}
            heatmap={{ points, color }}
            data-testid={testid}
          />
        ) : (
          <FieldDiagram
            mode="view"
            mirror={mirror}
            startPosition={current?.start ?? null}
            path={current?.path ?? null}
            data-testid={testid}
          />
        )}
      </div>

      {mode === 'paths' ? (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            data-testid="auto-path-step-prev"
            className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={paths.length <= 1}
            onClick={() => step(-1)}
            aria-label="Previous auto path"
          >
            <ChevronLeft className="size-4" />
            Prev
          </button>
          <span
            data-testid="auto-path-step-label"
            className="flex-1 text-center text-sm text-zinc-300"
          >
            Path {clampedIdx + 1} / {paths.length}
            {current ? (
              <span className="block text-xs text-zinc-500">
                {current.label}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            data-testid="auto-path-step-next"
            className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={paths.length <= 1}
            onClick={() => step(1)}
            aria-label="Next auto path"
          >
            Next
            <ChevronRight className="size-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span data-testid={`${testid}-count`} className="text-sm text-zinc-400">
            {autoCount} auto{autoCount === 1 ? '' : 's'} across {matchCount} match
            {matchCount === 1 ? '' : 'es'}
          </span>
          <span
            data-testid={`${testid}-consistency`}
            className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-xs font-medium text-cyan-300"
            title="Higher = the team starts auto in a more repeatable spot."
          >
            {score == null ? '—' : `${score}%`} consistent
          </span>
        </div>
      )}
    </div>
  );
}
