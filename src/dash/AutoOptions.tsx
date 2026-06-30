// src/dash/AutoOptions.tsx
// TeamView's auto view: instead of a hard-to-read density heatmap, group a team's
// scouted auto routines into the distinct OPTIONS they tend to run (clustered by
// path shape) and draw each option's representative path on the field with how
// often they ran it. A second tab steps through every individual auto, one at a
// time (kept from the old heatmap's "Paths" mode). Read-only, 100% client-side —
// consumes the already-cached, team-scoped reports the caller passes.

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, LayoutGrid, Route } from 'lucide-react';
import { FieldDiagram } from '@/components/FieldDiagram';
import { collectPoints } from '@/dash/AutoHeatmap';
import { groupAutoPaths, autoPathToFrame } from '@/dash/autoGrouping';
import type { MsrRow } from '@/dash/types';

export interface AutoOptionsProps {
  teamNumber: number;
  /** Already-team-filtered reports (re-filtered defensively in collectPoints). */
  reports: MsrRow[];
  mirror?: boolean;
  ['data-testid']?: string;
}

type Mode = 'options' | 'all';

/** A, B, C … label for each discovered option. */
function optionLetter(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

export default function AutoOptions(props: AutoOptionsProps): JSX.Element {
  const { teamNumber, reports, mirror, ['data-testid']: testid = 'team-auto-options' } = props;

  const { paths: rawPaths, matchCount, autoCount } = useMemo(
    () => collectPoints(reports, teamNumber),
    [reports, teamNumber],
  );
  // Canonicalize every routine to the BLUE frame (red autos are rotated 180° onto
  // blue) so a routine the team ran on red groups with its mirror-equivalent run
  // on blue, and they all display on one consistent side.
  const paths = useMemo(() => rawPaths.map((p) => autoPathToFrame(p, 'blue')), [rawPaths]);
  const groups = useMemo(() => groupAutoPaths(paths), [paths]);

  const [mode, setMode] = useState<Mode>('options');
  const [idx, setIdx] = useState(0);

  if (paths.length === 0) {
    return (
      <div data-testid={`${testid}-empty`} className="text-sm text-zinc-400">
        No auto paths recorded.
      </div>
    );
  }

  const clampedIdx = Math.min(idx, paths.length - 1);
  const current = paths[clampedIdx];
  const step = (delta: number): void => {
    const n = clampedIdx + delta;
    setIdx(((n % paths.length) + paths.length) % paths.length); // wrap-around
  };

  const tabBtn = (active: boolean): string =>
    [
      'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
      active ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200',
    ].join(' ');

  return (
    <div data-testid={`${testid}-body`} className="flex flex-col gap-3">
      {/* View toggle: grouped options vs. step-through-all. */}
      <div
        role="tablist"
        className="inline-flex w-fit gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'options'}
          data-testid="auto-mode-options"
          className={tabBtn(mode === 'options')}
          onClick={() => setMode('options')}
        >
          <LayoutGrid className="size-3.5" />
          Options ({groups.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'all'}
          data-testid="auto-mode-all"
          className={tabBtn(mode === 'all')}
          onClick={() => setMode('all')}
        >
          <Route className="size-3.5" />
          All autos ({paths.length})
        </button>
      </div>

      <p data-testid={`${testid}-frame-note`} className="text-xs text-zinc-500">
        Autos shown on the blue side — routines run on red are mirrored over, so the
        same routine groups together no matter which alliance the team ran it on.
      </p>

      {mode === 'options' ? (
        <>
          <ul
            data-testid={`${testid}-list`}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            {groups.map((g, i) => {
              const sharePct = Math.round((100 * g.members.length) / paths.length);
              return (
                <li
                  key={g.id}
                  data-testid={`${testid}-group-${i}`}
                  className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-zinc-100">
                      Option {optionLetter(i)}
                    </span>
                    <span
                      data-testid={`${testid}-group-${i}-count`}
                      className="rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand"
                      title={`${g.members.length} of ${paths.length} scouted autos`}
                    >
                      ran {g.members.length}× · {sharePct}%
                    </span>
                  </div>
                  <FieldDiagram
                    mode="view"
                    mirror={mirror}
                    startPosition={g.representative.start}
                    path={g.representative.path}
                    data-testid={`${testid}-group-${i}-field`}
                  />
                  <span className="text-xs text-zinc-500">
                    {g.members.map((m) => m.label).join(' · ')}
                  </span>
                </li>
              );
            })}
          </ul>
          <span data-testid={`${testid}-summary`} className="text-sm text-zinc-400">
            {groups.length} distinct auto{groups.length === 1 ? '' : 's'} from {autoCount} run
            {autoCount === 1 ? '' : 's'} across {matchCount} match{matchCount === 1 ? '' : 'es'}.
          </span>
        </>
      ) : (
        <>
          <div className="mx-auto w-full max-w-[420px]">
            <FieldDiagram
              mode="view"
              mirror={mirror}
              startPosition={current?.start ?? null}
              path={current?.path ?? null}
              data-testid={`${testid}-field`}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              data-testid="auto-all-step-prev"
              className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={paths.length <= 1}
              onClick={() => step(-1)}
              aria-label="Previous auto path"
            >
              <ChevronLeft className="size-4" />
              Prev
            </button>
            <span
              data-testid="auto-all-step-label"
              className="flex-1 text-center text-sm text-zinc-300"
            >
              Auto {clampedIdx + 1} / {paths.length}
              {current ? <span className="block text-xs text-zinc-500">{current.label}</span> : null}
            </span>
            <button
              type="button"
              data-testid="auto-all-step-next"
              className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={paths.length <= 1}
              onClick={() => step(1)}
              aria-label="Next auto path"
            >
              Next
              <ChevronRight className="size-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
