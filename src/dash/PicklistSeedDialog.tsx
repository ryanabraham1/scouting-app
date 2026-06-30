// src/dash/PicklistSeedDialog.tsx
// Controlled modal for one-click "seed picklist from top N by metric". Pure UI +
// a call into the pure `seedPicklist`. No new dependency: a self-contained
// centered overlay (Escape + backdrop close) mirroring the project's dialog
// pattern. The seed order is byte-identical to the Ranking table because both
// resolve EPA via `resolveRowEpa` (seedPicklist passes epaAvailable +
// epaFromScouting through to it).

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { TeamAgg } from '@/dash/aggregate';
import type { PicklistEntry } from '@/dash/picklistClient';
import { seedPicklist } from '@/dash/picklistSeeding';
import type { RankSortKey } from '@/dash/sorting';

export interface PicklistSeedDialogProps {
  open: boolean;
  aggs: TeamAgg[];
  epaByTeam?: Map<number, number | null>;
  epaAvailable: boolean;
  onSeed: (entries: PicklistEntry[], mode: 'replace' | 'append') => void;
  onClose: () => void;
}

const METRIC_OPTIONS: Array<{ value: RankSortKey; label: string }> = [
  { value: 'scoutingExpectedPoints', label: 'Expected Pts' },
  { value: 'epa', label: 'EPA' },
  { value: 'climbSuccessRate', label: 'Climb %' },
  { value: 'avgDefenseRating', label: 'Defense' },
];

const TOUCH = 'min-h-[44px]';

export default function PicklistSeedDialog(props: PicklistSeedDialogProps): JSX.Element | null {
  const { open, aggs, epaByTeam, epaAvailable, onSeed, onClose } = props;

  const [metric, setMetric] = useState<RankSortKey>('scoutingExpectedPoints');
  const [topN, setTopN] = useState('24');
  const [minMatches, setMinMatches] = useState('0');
  const [mode, setMode] = useState<'replace' | 'append'>('replace');

  // Reset the form each time the dialog opens so a prior session never lingers.
  useEffect(() => {
    if (open) {
      setMetric('scoutingExpectedPoints');
      setTopN('24');
      setMinMatches('0');
      setMode('replace');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const empty = aggs.length === 0;
  // EPA chosen but no external source resolved → seed by in-house estimate.
  const epaFallback = metric === 'epa' && !epaAvailable;

  function onConfirm(): void {
    if (empty) return;
    const epaFromScouting = !epaAvailable;
    const entries = seedPicklist({
      aggs,
      sortKey: metric,
      topN: Number(topN),
      minMatches: Math.max(0, Math.trunc(Number(minMatches) || 0)),
      epaByTeam,
      epaAvailable,
      epaFromScouting,
    });
    onSeed(entries, mode);
  }

  return createPortal(
    <div
      data-testid="pick-seed-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Seed picklist"
    >
      <button
        type="button"
        aria-label="Close seed dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        data-testid="pick-seed-dialog"
        className="relative z-10 w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-5 text-foreground shadow-xl"
      >
        <div className="text-base font-semibold">Seed picklist</div>

        {empty ? (
          <div data-testid="pick-seed-empty" className="text-sm text-muted-foreground">
            No scouting data to seed from.
          </div>
        ) : (
          <>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">Metric</span>
              <select
                data-testid="pick-seed-metric"
                value={metric}
                onChange={(e) => setMetric(e.target.value as RankSortKey)}
                className={cn(
                  'w-full rounded-md border border-input bg-background px-3 text-foreground',
                  TOUCH,
                )}
              >
                {METRIC_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            {epaFallback ? (
              <div data-testid="pick-seed-epa-note" className="text-xs text-warning">
                EPA unavailable — seeding by in-house estimate.
              </div>
            ) : null}

            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">Top N</span>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={60}
                data-testid="pick-seed-topn"
                value={topN}
                onChange={(e) => setTopN(e.target.value)}
                className="h-11"
                aria-label="Number of teams to seed"
              />
            </label>

            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">Min matches scouted</span>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                data-testid="pick-seed-minmatches"
                value={minMatches}
                onChange={(e) => setMinMatches(e.target.value)}
                className="h-11"
                aria-label="Minimum matches scouted"
              />
            </label>

            <fieldset className="space-y-1 text-sm">
              <legend className="text-muted-foreground">Mode</legend>
              <div className="flex flex-wrap gap-4">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="pick-seed-mode"
                    data-testid="pick-seed-mode-replace"
                    checked={mode === 'replace'}
                    onChange={() => setMode('replace')}
                    className="h-5 w-5 accent-primary"
                  />
                  <span>Replace</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="pick-seed-mode"
                    data-testid="pick-seed-mode-append"
                    checked={mode === 'append'}
                    onChange={() => setMode('append')}
                    className="h-5 w-5 accent-primary"
                  />
                  <span>Append</span>
                </label>
              </div>
            </fieldset>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            data-testid="pick-seed-cancel"
            onClick={onClose}
            className={TOUCH}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="pick-seed-confirm"
            onClick={onConfirm}
            disabled={empty}
            className={TOUCH}
          >
            Seed
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
