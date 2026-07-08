// src/dash/strategy/PredictionPanel.tsx
// Match-prediction UI for the Strategy tab — MOVED here from NextMatchView
// (which is now the pure "Pit Display" broadcast screen). WinProbBanner /
// AllianceColumn / TeamRowView keep their legacy `dash-next-*` testids so the
// existing unit + e2e assertions retarget with a tab click, not a rewrite.
// TeamRowView is ENRICHED for strategy meetings: per-team component split
// (auto/fuel/climb + defense), super-scout ratings, and pit-scouting facts.

import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { LOW_CONFIDENCE_THRESHOLD, ratedMeanText, type TeamAgg } from '@/dash/aggregate';
import { teamRedFlags } from '@/dash/strategy/redFlags';
import type { TeamPrediction, ComponentBreakdown } from '@/dash/predict';
import type { TeamRow } from '@/dash/useEventData';
import type { MsrRow } from '@/dash/types';
import type { TeamPit } from '@/dash/useTeamPit';

export const SOURCE_LABEL: Record<TeamPrediction['source'], string> = {
  blend: 'blend',
  scouting: 'scouting',
  epa: 'epa',
  none: 'none',
};

export const SOURCE_CLASS: Record<TeamPrediction['source'], string> = {
  blend: 'bg-brand/15 text-brand border-brand/40',
  scouting: 'bg-success/15 text-success border-success/40',
  epa: 'bg-energy/15 text-energy border-energy/40',
  none: 'bg-muted text-muted-foreground border-border',
};

const EM_DASH = '—';

function round(n: number): number {
  return Math.round(n);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function comp(n: number | null | undefined, source: ComponentBreakdown['source']): string {
  if (source === 'none' || n == null) return EM_DASH;
  return String(Math.round(n));
}

export function nicknameFor(teams: TeamRow[], teamNumber: number): string | null {
  return teams.find((t) => t.team_number === teamNumber)?.nickname ?? null;
}

/** A small inline chip flagging that FUEL points are rate-derived (low conf). */
export function FuelLowConfidenceChip(): JSX.Element {
  return (
    <span
      data-testid="fuel-low-confidence"
      className="inline-flex items-center rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning"
      title="FUEL is rate-derived; treat its contribution as a low-confidence estimate."
    >
      FUEL est. — low confidence
    </span>
  );
}

export interface TeamRowViewProps {
  pred: TeamPrediction;
  agg: TeamAgg | undefined;
  nickname: string | null;
  /** THIS team's raw reports — feeds the super-scout rating means (which are
   *  deliberately kept off TeamAgg; same approach as TeamView). */
  reports?: MsrRow[];
  /** Pit-scouting facts, when a pit report exists. */
  pit?: TeamPit | null;
  /** Highlight the base ("our") team's row. */
  isBaseTeam?: boolean;
}

export function TeamRowView({
  pred,
  agg,
  nickname,
  reports,
  pit,
  isBaseTeam,
}: TeamRowViewProps): JSX.Element {
  const matchesScouted = agg?.matchesScouted ?? 0;
  const c = pred.components;
  const source = c?.source ?? 'none';
  const hasDefense = c?.defense != null && c.defense > 0;
  const driver = reports ? ratedMeanText(reports, (m) => m.driver_skill) : EM_DASH;
  const agility = reports ? ratedMeanText(reports, (m) => m.agility) : EM_DASH;
  // Red flags a coach must know pre-match (died/no-show/tips/climb fails/fouls/
  // defense identity) — pure derivation over this team's scouted reports.
  const redFlags = useMemo(() => teamRedFlags(reports ?? []), [reports]);
  const pitFacts: string[] = [];
  if (pit?.drivetrain) pitFacts.push(pit.drivetrain);
  if (pit?.robotLengthIn != null && pit?.robotWidthIn != null) {
    pitFacts.push(`${pit.robotLengthIn}×${pit.robotWidthIn} in`);
  }
  if (pit?.trenchCapable) pitFacts.push('trench');

  return (
    <li
      data-testid={`dash-next-team-${pred.teamNumber}`}
      className={cn(
        'flex min-h-[44px] flex-col gap-1 rounded-md border border-border bg-card/40 px-3 py-2',
        isBaseTeam && 'border-amber-400/60 bg-amber-400/10',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-foreground">
          {pred.teamNumber}
          {nickname ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">{nickname}</span>
          ) : null}
          {isBaseTeam ? (
            <span
              data-testid="dash-next-us-chip"
              className="ml-2 rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold uppercase text-neutral-900"
            >
              us
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums text-foreground" data-testid="dash-next-team-expected">
            {round(pred.expected)} pts
          </span>
          <span
            data-testid="dash-next-source-badge"
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
              SOURCE_CLASS[pred.source],
            )}
          >
            {SOURCE_LABEL[pred.source]}
          </span>
        </span>
      </div>

      {/* Component split — how the expected points decompose. */}
      <div
        data-testid={`dash-next-components-${pred.teamNumber}`}
        className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
      >
        <span>
          auto <span className="text-foreground">{comp(c?.auto, source)}</span>
        </span>
        <span>·</span>
        <span>
          fuel <span className="text-foreground">{comp(c?.fuel, source)}</span>
        </span>
        <span>·</span>
        <span>
          climb <span className="text-foreground">{comp(c?.climb, source)}</span>
        </span>
        {hasDefense ? (
          <>
            <span>·</span>
            <span>
              defense <span className="text-brand">↓{Math.round(c!.defense as number)} opp</span>
            </span>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>scouted: {matchesScouted}</span>
        <span>
          climb:{' '}
          <span
            className={cn(
              'font-medium',
              agg
                ? agg.climbSuccessRate >= 0.7
                  ? 'text-success'
                  : 'text-warning'
                : 'text-muted-foreground',
            )}
          >
            {agg ? pct(agg.climbSuccessRate) : EM_DASH}
          </span>
        </span>
        <span>
          defense:{' '}
          <span className={cn('font-medium', agg ? 'text-brand' : 'text-muted-foreground')}>
            {agg ? agg.avgDefenseRating.toFixed(1) : EM_DASH}
          </span>
        </span>
        <span>
          driver: <span className="font-medium text-foreground">{driver}</span>
        </span>
        <span>
          agility: <span className="font-medium text-foreground">{agility}</span>
        </span>
        {/* Only when THIS team's fuel data is actually low-confidence — the
            same gate TeamView uses. */}
        {agg && agg.meanFuelConfidence < LOW_CONFIDENCE_THRESHOLD ? (
          <FuelLowConfidenceChip />
        ) : null}
      </div>

      {pitFacts.length > 0 ? (
        <div
          data-testid={`dash-next-pit-${pred.teamNumber}`}
          className="flex flex-wrap items-center gap-1.5"
        >
          {pitFacts.map((f) => (
            <span
              key={f}
              className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {f}
            </span>
          ))}
        </div>
      ) : null}

      {/* Red flags — the pre-match "must know" list. */}
      {redFlags.length > 0 ? (
        <ul
          data-testid={`dash-next-flags-${pred.teamNumber}`}
          className="flex flex-col gap-1"
        >
          {redFlags.map((f) => (
            <li
              key={f.kind}
              data-severity={f.severity}
              className={cn(
                'flex items-start gap-1.5 rounded-md border px-2 py-1 text-xs',
                f.severity === 'high'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-warning/40 bg-warning/10 text-warning',
              )}
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export interface AllianceColumnProps {
  side: 'red' | 'blue';
  label: string;
  score: number;
  teams: TeamPrediction[];
  agg: Map<number, TeamAgg>;
  allTeams: TeamRow[];
  /** Per-team raw reports for the rating means (optional). */
  reportsByTeam?: Map<number, MsrRow[]>;
  /** Per-team pit reports (optional). */
  pitByTeam?: Map<number, TeamPit>;
  baseTeam?: number;
  /** Marks this column as OUR alliance for the meeting. */
  isOurs?: boolean;
}

export function AllianceColumn({
  side,
  label,
  score,
  teams,
  agg,
  allTeams,
  reportsByTeam,
  pitByTeam,
  baseTeam,
  isOurs,
}: AllianceColumnProps): JSX.Element {
  return (
    <Card
      className={cn(
        'border',
        side === 'red' ? 'border-red-500/40' : 'border-blue-500/40',
        isOurs && 'ring-1 ring-amber-400/50',
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4">
        <CardTitle className="flex items-center gap-2 text-foreground">
          {label}
          {isOurs ? (
            <span className="rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase text-neutral-900">
              our alliance
            </span>
          ) : null}
        </CardTitle>
        <span
          data-testid={`dash-next-${side}-score`}
          className={cn(
            'font-mono tabular-nums text-2xl font-bold',
            side === 'red' ? 'text-red-400' : 'text-blue-400',
          )}
        >
          {round(score)}
        </span>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <ul className="flex flex-col gap-2">
          {teams.map((p) => (
            <TeamRowView
              key={p.teamNumber}
              pred={p}
              agg={agg.get(p.teamNumber)}
              nickname={nicknameFor(allTeams, p.teamNumber)}
              reports={reportsByTeam?.get(p.teamNumber)}
              pit={pitByTeam?.get(p.teamNumber) ?? null}
              isBaseTeam={baseTeam != null && p.teamNumber === baseTeam}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Broadcast win-probability banner: a split red↔blue bar proportional to the
 * win odds, with both percentages called out boldly and the favored alliance
 * emphasized. Predicted alliance scores flank the bar for context. (Moved
 * verbatim from NextMatchView.)
 */
export function WinProbBanner({
  redWinProb,
  redScore,
  blueScore,
}: {
  redWinProb: number;
  redScore: number;
  blueScore: number;
}): JSX.Element {
  const redProb = Math.min(1, Math.max(0, redWinProb));
  const blueProb = 1 - redProb;
  // A perfect 50/50 (within rounding) is a genuine toss-up — don't crown a side.
  const even = Math.round(redProb * 100) === Math.round(blueProb * 100);
  const redFavored = !even && redProb >= blueProb;
  const blueFavored = !even && blueProb > redProb;
  // Clamp the bar split so the trailing side never fully vanishes.
  const redPct = Math.min(92, Math.max(8, Math.round(redProb * 100)));

  return (
    <div
      data-testid="dash-next-winprob-banner"
      className="overflow-hidden rounded-xl border border-border bg-black/40"
    >
      <div className="flex items-center justify-between px-4 pt-3">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Win Probability
        </span>
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Projected{' '}
          <span className="font-mono tabular-nums font-semibold text-red-400">{round(redScore)}</span>
          {' – '}
          <span className="font-mono tabular-nums font-semibold text-blue-400">{round(blueScore)}</span>
        </span>
      </div>

      <div className="flex items-end justify-between gap-3 px-4 pt-2">
        <div className="flex flex-col">
          <span className="text-xs font-semibold uppercase tracking-wider text-red-400/80">
            Red
          </span>
          <span
            data-testid="dash-next-red-winprob"
            className={cn(
              'font-mono tabular-nums font-black leading-none text-red-400',
              redFavored ? 'text-5xl sm:text-6xl' : 'text-3xl sm:text-4xl',
              blueFavored && 'opacity-70',
            )}
          >
            {pct(redProb)}
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-xs font-semibold uppercase tracking-wider text-blue-400/80">
            Blue
          </span>
          <span
            data-testid="dash-next-blue-winprob"
            className={cn(
              'font-mono tabular-nums font-black leading-none text-blue-400',
              blueFavored ? 'text-5xl sm:text-6xl' : 'text-3xl sm:text-4xl',
              redFavored && 'opacity-70',
            )}
          >
            {pct(blueProb)}
          </span>
        </div>
      </div>

      <div className="px-4 pb-4 pt-3">
        <div className="flex h-4 w-full overflow-hidden rounded-full ring-1 ring-white/10">
          <div
            className={cn(
              'h-full bg-red-500 transition-all',
              redFavored && 'shadow-[0_0_12px] shadow-red-500/50',
            )}
            style={{ width: `${redPct}%` }}
          />
          <div
            className={cn(
              'h-full flex-1 bg-blue-500 transition-all',
              blueFavored && 'shadow-[0_0_12px] shadow-blue-500/50',
            )}
          />
        </div>
        <div
          data-testid="dash-next-winprob-label"
          className="mt-1.5 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {even ? (
            <span className="text-muted-foreground">Even · toss-up</span>
          ) : redFavored ? (
            <span className="text-red-400">Red favored</span>
          ) : (
            <span className="text-blue-400">Blue favored</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** EPA source/health banners (moved verbatim from NextMatchView). */
export function EpaBanners({
  available,
  source,
}: {
  available: boolean;
  source: 'statbotics' | 'local' | 'none' | undefined;
}): JSX.Element | null {
  if (!available) {
    return (
      <div
        data-testid="epa-unavailable"
        role="status"
        className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
      >
        Statbotics EPA unavailable — predictions use scouting only.
      </div>
    );
  }
  if (source === 'local') {
    return (
      <div
        data-testid="epa-local"
        role="status"
        className="rounded-md border border-energy/40 bg-energy/10 px-3 py-2 text-sm text-energy"
      >
        Statbotics offline — EPA estimated from this event's results.
      </div>
    );
  }
  return null;
}
