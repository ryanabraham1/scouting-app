// Single, consolidated coverage summary. Fed ONE precomputed CoverageSummary —
// the draft while authoring, or the published set otherwise. The live-for-scouts
// state rides along as a one-line note (`liveNote`) instead of a second stacked
// panel, so the lead never sees the seat count twice.
import type { CoverageSummary } from './coverage';

export interface CoverageGapPanelProps {
  summary: CoverageSummary;
  eventKey: string;
  title?: string;
  diverged?: boolean;
  /** One-line published/live-for-scouts status shown under the headline. */
  liveNote?: string;
  /**
   * Force the "no published assignments cached" empty state. The board sets this
   * when there are zero published rows (offline / never published) — the summary
   * still has a non-zero `totalSeats` (from `slots`), so "empty" can't be
   * inferred from the summary alone.
   */
  empty?: boolean;
}

export function CoverageGapPanel({
  summary,
  eventKey,
  title,
  diverged,
  liveNote,
  empty,
}: CoverageGapPanelProps): JSX.Element {
  const { totalSeats, coveredSeats, gapCount, gapsByMatch, coverageRate } = summary;
  const plural = gapCount === 1 ? '' : 's';
  const shortMatch = (matchKey: string): string => matchKey.replace(`${eventKey}_`, '');
  const pct = Math.round(coverageRate * 100);
  const full = gapCount === 0;

  if (empty || totalSeats === 0) {
    return (
      <div className="mt-4 rounded-lg border p-3 text-sm">
        {title ? (
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </div>
        ) : null}
        <p data-testid="coverage-published-empty" className="mt-1 text-muted-foreground">
          No published assignments cached.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-lg border p-3 text-sm">
      {title ? (
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
      ) : null}

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div data-testid="coverage-headline" className="font-medium">
          Coverage: {coveredSeats} / {totalSeats} seats ({gapCount} gap{plural})
        </div>
        <div
          className={`text-sm font-semibold tabular-nums ${full ? 'text-success' : 'text-amber-300'}`}
        >
          {pct}%
        </div>
      </div>

      {/* Signature glance element: a single coverage bar. Green when full, amber
          while gaps remain — readable across the room during a match. */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-all ${full ? 'bg-success' : 'bg-amber-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {diverged ? (
        <p data-testid="coverage-diverged" className="text-amber-300">
          Draft has unpublished changes — Publish to update scouts.
        </p>
      ) : null}

      {liveNote ? <p className="text-xs text-muted-foreground">{liveNote}</p> : null}

      {full ? (
        <p data-testid="coverage-all-covered" className="text-success">
          All {totalSeats} seats covered
        </p>
      ) : (
        <div
          data-testid="coverage-gaps"
          className="flex max-h-[38vh] flex-col gap-2 overflow-y-auto rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-300"
        >
          {gapsByMatch.map((group) => (
            <div
              key={group.matchKey}
              data-testid="coverage-gap-match"
              className="flex flex-wrap items-center gap-1.5"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {shortMatch(group.matchKey)}
              </span>
              {group.gaps.map((g) => (
                <span
                  key={`${g.allianceColor}:${g.station}`}
                  data-testid="coverage-gap-seat"
                  className={`rounded px-1.5 py-0.5 font-mono ${
                    g.allianceColor === 'red'
                      ? 'bg-red-500/15 text-red-400'
                      : 'bg-blue-500/15 text-blue-400'
                  }`}
                >
                  {shortMatch(g.matchKey)} · {g.allianceColor} {g.station} · {g.targetTeamNumber}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CoverageGapPanel;
