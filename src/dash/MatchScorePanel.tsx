// src/dash/MatchScorePanel.tsx
// Shared "match score" block: both alliances (three station numbers each, an
// optional OUR-team highlight), the final score, a winner banner and a "vs"
// divider. Extracted from TeamView's last-match card so the Match tab can reuse
// the exact same look. Pure presentation — degrades to "—"/"Not played yet" for
// an unplayed match. testids are caller-namespaced via `testidPrefix` so each
// host (team-last-match / match-results) keeps its own stable testids.

import { cn } from '@/lib/utils';

/** Winner side off a MatchRow — kept loose (`string`) since the row type is. */
export type Winner = 'red' | 'blue' | 'tie' | string | null;

function winnerText(winner: Winner): string | null {
  return winner === 'red'
    ? 'Red wins'
    : winner === 'blue'
      ? 'Blue wins'
      : winner === 'tie'
        ? 'Tie'
        : null;
}

/** One alliance's three station numbers, our team highlighted (when given). */
export function AllianceLine(props: {
  color: 'red' | 'blue';
  teams: (number | null)[];
  ourTeam?: number;
  score: number | null;
  isWinner: boolean;
  testid: string;
}): JSX.Element {
  const { color, teams, ourTeam, score, isWinner, testid } = props;
  const colorText = color === 'red' ? 'text-red-400' : 'text-blue-400';
  const winTint =
    color === 'red' ? 'border-red-500/50 bg-red-500/[0.07]' : 'border-blue-500/50 bg-blue-500/[0.07]';
  const winBadge = color === 'red' ? 'bg-red-500/20 text-red-300' : 'bg-blue-500/20 text-blue-300';
  return (
    <div
      data-testid={testid}
      className={cn(
        'flex flex-1 flex-col justify-center gap-2 rounded-lg border px-3 py-2.5 tabular-nums',
        isWinner ? winTint : 'border-zinc-800/70 bg-zinc-900/30',
      )}
    >
      <div className="flex items-center justify-between">
        <span className={cn('text-[11px] font-bold uppercase tracking-wider', colorText)}>{color}</span>
        {isWinner ? (
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide', winBadge)}>
            Win
          </span>
        ) : null}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="flex flex-wrap gap-1.5">
          {teams.map((t, i) => (
            <span
              key={`${color}-${i}`}
              className={cn(
                'rounded px-2 py-0.5 text-base font-semibold',
                ourTeam != null && t === ourTeam
                  ? 'bg-brand/25 text-brand ring-1 ring-brand/50'
                  : `${colorText} bg-white/5`,
              )}
            >
              {t ?? '—'}
            </span>
          ))}
        </span>
        <span className={cn('text-4xl font-black leading-none', colorText)}>{score ?? '—'}</span>
      </div>
    </div>
  );
}

/**
 * Compact match-score panel: a small "Final score / Matchup" caption, the two
 * alliance lines separated by a "vs" divider, then a tinted winner banner. Used
 * beside the match video. `ourTeam` highlights one robot (Team tab); omit it on
 * the Match tab where there's no single subject. `footer` hangs extra content
 * (e.g. a Ranking-Points line) under the banner. `bordered` wraps the panel in
 * its own card-like chrome (default) — pass false when it already sits inside a
 * Card so borders don't nest.
 */
export function MatchScorePanel(props: {
  redTeams: (number | null)[];
  blueTeams: (number | null)[];
  redScore: number | null;
  blueScore: number | null;
  winner: Winner;
  ourTeam?: number;
  testidPrefix: string;
  footer?: React.ReactNode;
  bordered?: boolean;
}): JSX.Element {
  const { redTeams, blueTeams, redScore, blueScore, winner, ourTeam, testidPrefix, footer } = props;
  const bordered = props.bordered ?? true;
  const text = winnerText(winner);
  return (
    <div
      data-testid={`${testidPrefix}-details`}
      className={cn(
        'flex flex-col gap-2.5',
        bordered && 'rounded-xl border border-zinc-800 bg-zinc-900/40 p-3',
      )}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {text ? 'Final score' : 'Matchup'}
      </span>
      <div data-testid={`${testidPrefix}-score`} className="flex flex-1 flex-col gap-2">
        <AllianceLine
          color="red"
          teams={redTeams}
          ourTeam={ourTeam}
          score={redScore}
          isWinner={winner === 'red'}
          testid={`${testidPrefix}-alliance-red`}
        />
        <div className="flex items-center gap-2 px-1 text-[10px] font-bold uppercase tracking-widest text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800" />
          vs
          <span className="h-px flex-1 bg-zinc-800" />
        </div>
        <AllianceLine
          color="blue"
          teams={blueTeams}
          ourTeam={ourTeam}
          score={blueScore}
          isWinner={winner === 'blue'}
          testid={`${testidPrefix}-alliance-blue`}
        />
      </div>
      <span
        data-testid={`${testidPrefix}-winner`}
        className={cn(
          'rounded-lg px-3 py-1.5 text-center text-sm font-bold uppercase tracking-wide',
          winner === 'red'
            ? 'bg-red-500/15 text-red-300'
            : winner === 'blue'
              ? 'bg-blue-500/15 text-blue-300'
              : 'bg-zinc-800/60 text-zinc-400',
        )}
      >
        {text ?? 'Not played yet'}
      </span>
      {footer}
    </div>
  );
}
