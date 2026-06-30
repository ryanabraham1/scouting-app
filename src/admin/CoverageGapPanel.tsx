// Presentational coverage-gap summary. No data fetching — fed a precomputed
// CoverageSummary from AssignmentBoard for BOTH the draft and published panels.
import type { CoverageSummary } from './coverage';

export interface CoverageGapPanelProps {
  summary: CoverageSummary;
  eventKey: string;
  title?: string;
  diverged?: boolean;
  note?: string;
  /**
   * Force the "no published assignments cached" empty state regardless of the
   * slot universe. The published panel sets this when there are zero published
   * rows (offline / never published) — the summary still has a non-zero
   * `totalSeats` (from `slots`), so we can't infer "empty" from the summary alone.
   */
  empty?: boolean;
}

export function CoverageGapPanel({
  summary,
  eventKey,
  title,
  diverged,
  note,
  empty,
}: CoverageGapPanelProps): JSX.Element {
  const { totalSeats, coveredSeats, gapCount, gapsByMatch } = summary;
  const plural = gapCount === 1 ? '' : 's';
  const shortMatch = (matchKey: string): string => matchKey.replace(`${eventKey}_`, '');

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-lg border p-3 text-sm">
      {title ? <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div> : null}

      {empty || totalSeats === 0 ? (
        <p data-testid="coverage-published-empty" className="text-muted-foreground">
          No published assignments cached.
        </p>
      ) : (
        <>
          <div data-testid="coverage-headline" className="font-medium">
            Coverage: {coveredSeats} / {totalSeats} seats ({gapCount} gap{plural})
          </div>

          {diverged ? (
            <p data-testid="coverage-diverged" className="text-amber-300">
              Draft has unpublished changes — Publish to update scouts.
            </p>
          ) : null}

          {note ? <p className="text-muted-foreground">{note}</p> : null}

          {gapCount === 0 ? (
            <p data-testid="coverage-all-covered" className="text-success">
              All {totalSeats} seats covered
            </p>
          ) : (
            <div
              data-testid="coverage-gaps"
              className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-300"
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
        </>
      )}
    </div>
  );
}

export default CoverageGapPanel;
