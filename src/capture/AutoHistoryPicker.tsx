// src/capture/AutoHistoryPicker.tsx
// Review-step picker that lets a scout REUSE an auto their team has already been
// scouted running, instead of re-tracing it by finger. Routines are clustered into
// the distinct "options" the team tends to run (the same shape-grouping the Team
// dashboard uses) and each is re-framed onto the alliance the team plays in THIS
// match — autos are stored in absolute field coords, so a routine traced on the
// other alliance is rotated 180° onto this side before it's previewed or applied.
//
// Phone-first: full-bleed tappable cards, big targets, one accent (brand cyan) on
// the selected option. Read-only previews — selecting hands the re-framed start +
// path back to the caller, which writes them into the report exactly as a drawn
// path would be.

import { useMemo } from 'react';
import { Check, Route } from 'lucide-react';
import { FieldDiagram, type FieldPoint } from '@/components/FieldDiagram';
import { groupAutoPaths, autoPathToFrame } from '@/dash/autoGrouping';
import type { AutoPath } from '@/dash/AutoHeatmap';
import type { AllianceColor } from '@/dash/fieldFrame';

export interface AutoHistoryPickerProps {
  /** Prior routines for the team, in the absolute coords they were recorded in. */
  autos: AutoPath[];
  /** Alliance the team plays THIS match — every option is re-framed onto this side. */
  alliance: AllianceColor;
  /** The report's current auto path, used to highlight an already-applied option. */
  selectedPath: FieldPoint[] | null;
  /** Apply a chosen routine (already re-framed to `alliance`) to the report. */
  onSelect: (routine: { start: FieldPoint | null; path: FieldPoint[] | null }) => void;
  ['data-testid']?: string;
}

/** A, B, C … label per option (matches the Team dashboard's auto options). */
function optionLetter(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

/** Stable signature for a path so the applied option highlights without extra state. */
function pathSig(path: FieldPoint[] | null | undefined): string {
  if (!path || path.length === 0) return '';
  return path.map((p) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`).join(';');
}

/** Round a coord to 6 decimals so the red→blue→red round-trip stores clean values
 *  (1 − (1 − x) leaves binary float noise like 0.19999999996 otherwise). */
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const cleanPoint = (p: FieldPoint): FieldPoint => ({ x: r6(p.x), y: r6(p.y) });

export default function AutoHistoryPicker(props: AutoHistoryPickerProps): JSX.Element {
  const { autos, alliance, selectedPath, onSelect, ['data-testid']: testid = 'auto-history' } = props;

  // Cluster in one shared frame (blue), then re-frame each option onto the side the
  // team plays this match. Most-run option first (groupAutoPaths sorts by count).
  const options = useMemo(() => {
    const blueFramed = autos.map((a) => autoPathToFrame(a, 'blue'));
    return groupAutoPaths(blueFramed).map((g) => {
      const framed = autoPathToFrame(g.representative, alliance);
      return {
        id: g.id,
        runs: g.members.length,
        routine: {
          start: framed.start ? cleanPoint(framed.start) : null,
          path: framed.path ? framed.path.map(cleanPoint) : null,
        },
      };
    });
  }, [autos, alliance]);

  const selectedSig = useMemo(() => pathSig(selectedPath), [selectedPath]);

  if (options.length === 0) {
    return (
      <p data-testid={`${testid}-empty`} className="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">
        No autos scouted for this team yet — draw the path below.
      </p>
    );
  }

  return (
    <div data-testid={testid} className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Tap the auto this team ran — paths are flipped onto your alliance automatically.
      </p>
      <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 landscape:grid-cols-3">
        {options.map((opt, i) => {
          const selected = pathSig(opt.routine.path) === selectedSig && selectedSig !== '';
          return (
            <li key={opt.id}>
              <button
                type="button"
                data-testid={`${testid}-opt-${i}`}
                aria-pressed={selected}
                onClick={() => onSelect({ start: opt.routine.start, path: opt.routine.path })}
                className={`group flex w-full flex-col gap-2 rounded-2xl border-2 p-2.5 text-left transition-colors ${
                  selected
                    ? 'border-brand bg-brand/10'
                    : 'border-border bg-card hover:border-brand/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-base font-semibold">
                    <Route className={`size-4 ${selected ? 'text-brand' : 'text-muted-foreground'}`} />
                    Option {optionLetter(i)}
                  </span>
                  {selected ? (
                    <span className="flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-brand-foreground">
                      <Check className="size-3.5" />
                      Selected
                    </span>
                  ) : (
                    <span
                      className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums"
                      title={`Scouted ${opt.runs} time${opt.runs === 1 ? '' : 's'}`}
                    >
                      ran {opt.runs}×
                    </span>
                  )}
                </div>
                <div className="overflow-hidden rounded-lg">
                  <FieldDiagram
                    mode="view"
                    startPosition={opt.routine.start}
                    path={opt.routine.path}
                    data-testid={`${testid}-opt-${i}-field`}
                  />
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
