// src/dash/strategy/PredictionPanel.tsx
// Match-prediction UI for the Strategy tab — MOVED here from NextMatchView
// (which is now the pure "Pit Display" broadcast screen). The win-probability
// strip keeps the legacy `dash-next-*` testids; the per-team rows now live in
// MatchupDashboard's team table (which reuses the source badge styles below).

import type { TeamPrediction } from '@/dash/predict';

export const SOURCE_LABEL: Record<TeamPrediction['source'], string> = {
  scouting: 'scouting',
  epa: 'epa',
  none: 'none',
};

export const SOURCE_CLASS: Record<TeamPrediction['source'], string> = {
  scouting: 'bg-success/15 text-success border-success/40',
  epa: 'bg-energy/15 text-energy border-energy/40',
  none: 'bg-muted text-muted-foreground border-border',
};

const EM_DASH = '—';

function round(n: number): number {
  return Math.round(n);
}

function scoreText(n: number): string {
  return Number.isFinite(n) ? String(round(n)) : EM_DASH;
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${Math.round(x * 100)}%` : EM_DASH;
}

/**
 * Win-probability strip: predicted red score, a split red↔blue bar with both
 * win percentages, predicted blue score — one row instead of a tall banner.
 * A projected score is shown only when it's known.
 */
export function WinProbBanner({
  redWinProb,
  redScore,
  blueScore,
  ourSide,
}: {
  redWinProb: number;
  redScore: number;
  blueScore: number;
  ourSide?: 'red' | 'blue' | null;
}): JSX.Element {
  const redProb = Number.isFinite(redWinProb) ? Math.min(1, Math.max(0, redWinProb)) : 0.5;
  const blueProb = 1 - redProb;
  // A perfect 50/50 (within rounding) is a genuine toss-up — don't crown a side.
  const even = Math.round(redProb * 100) === Math.round(blueProb * 100);
  const redFavored = !even && redProb >= blueProb;
  // Clamp the bar split so the trailing side never fully vanishes.
  const redPct = Math.min(92, Math.max(8, Math.round(redProb * 100)));

  return (
    <div
      data-testid="dash-next-winprob-banner"
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-border bg-card px-4 py-3"
    >
      <div className="flex flex-col">
        <span
          data-testid="dash-next-red-score"
          className="font-mono text-3xl font-black leading-none tabular-nums text-red-400"
        >
          {scoreText(redScore)}
        </span>
        <span className="text-xs text-muted-foreground">Red{ourSide === 'red' ? ' · us' : ''}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex h-3 w-full overflow-hidden rounded-full ring-1 ring-white/10">
          <div className="h-full bg-red-500 transition-all" style={{ width: `${redPct}%` }} />
          <div className="h-full flex-1 bg-blue-500 transition-all" />
        </div>
        <div className="flex items-center justify-between text-xs font-semibold tabular-nums">
          <span data-testid="dash-next-red-winprob" className="text-red-400">
            {pct(redProb)}
          </span>
          <span
            data-testid="dash-next-winprob-label"
            className="uppercase tracking-wider text-muted-foreground"
          >
            {even ? (
              'Even'
            ) : redFavored ? (
              <span className="text-red-400">Red favored</span>
            ) : (
              <span className="text-blue-400">Blue favored</span>
            )}
          </span>
          <span data-testid="dash-next-blue-winprob" className="text-blue-400">
            {pct(blueProb)}
          </span>
        </div>
      </div>
      <div className="flex flex-col items-end">
        <span
          data-testid="dash-next-blue-score"
          className="font-mono text-3xl font-black leading-none tabular-nums text-blue-400"
        >
          {scoreText(blueScore)}
        </span>
        <span className="text-xs text-muted-foreground">
          Blue{ourSide === 'blue' ? ' · us' : ''}
        </span>
      </div>
    </div>
  );
}

// The old EPA-health banners were dropped from the Strategy tab (vertical-space
// cost on an iPad without decision value — the per-team source badges already
// say where every number comes from).
