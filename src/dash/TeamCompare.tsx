// Multi-team comparison dashboard for RankingView. Every visual uses a fixed,
// meaningful unit: points/match, percentages, or the 1–10 qualitative scale.

import type { ReactNode } from 'react';
import { CHART_COLORS, EmptyChart } from '@/dash/charts';
import { aggregateTeamComponentSplit, type TeamAgg } from '@/dash/aggregate';
import { DEF_EFF_MIN_SAMPLE } from '@/dash/defenseAnalytics';
import { cn } from '@/lib/utils';

export interface CompareTeam {
  agg: TeamAgg;
  /** Best-available EPA (Statbotics → local → in-house), or null. */
  epa: number | null;
}

/** Max teams supported without making labels and colors hard to distinguish. */
export const MAX_COMPARE_TEAMS = 6;

/** Stable selection-order palette shared by every comparison chart. */
export const TEAM_COMPARE_COLORS = [
  CHART_COLORS.brand,
  CHART_COLORS.energy,
  CHART_COLORS.success,
  CHART_COLORS.warning,
  'hsl(265 83% 70%)',
  'hsl(330 81% 68%)',
] as const;

export interface ComparisonDatum {
  teamNumber: number;
  color: string;
  matchesScouted: number;
  scoring: {
    auto: number;
    teleopEndgame: number;
    climb: number;
    expected: number;
    epa: number | null;
  };
  reliability: number;
  climbSuccess: number;
  defenseRating: number;
  fuelSlowdownWhenDefended: number | null;
  opponentSlowdownCaused: number | null;
}

/** Pure chart-model builder, kept exported for focused unit tests. */
export function buildComparisonData(teams: CompareTeam[]): ComparisonDatum[] {
  return teams.slice(0, MAX_COMPARE_TEAMS).map((team, index) => {
    const split = aggregateTeamComponentSplit(team.agg);
    const validEpa =
      typeof team.epa === 'number' && Number.isFinite(team.epa)
        ? team.epa
        : null;
    return {
      teamNumber: team.agg.teamNumber,
      color: TEAM_COMPARE_COLORS[index],
      matchesScouted: team.agg.matchesScouted,
      scoring: {
        auto: split.auto,
        teleopEndgame: split.fuel,
        climb: split.climb,
        expected: team.agg.scoutingExpectedPoints,
        epa: validEpa,
      },
      reliability: team.agg.reliability,
      climbSuccess: team.agg.climbSuccessRate,
      defenseRating: team.agg.avgDefenseRating,
      fuelSlowdownWhenDefended: team.agg.fuelSuppressionWhileDefended,
      opponentSlowdownCaused:
        team.agg.defenderEffectiveness != null &&
        team.agg.defenseSampleCount >= DEF_EFF_MIN_SAMPLE
          ? team.agg.defenderEffectiveness
          : null,
    };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signedPct(value: number): string {
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function ChartFrame({
  title,
  subtitle,
  testid,
  wide = false,
  children,
}: {
  title: string;
  subtitle: string;
  testid: string;
  wide?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <figure
      data-testid={testid}
      className={cn(
        'm-0 min-w-0 rounded-lg border border-border/70 bg-muted/10 p-3 sm:p-4',
        wide && 'lg:col-span-2',
      )}
      aria-labelledby={`${testid}-title`}
      aria-describedby={`${testid}-subtitle`}
    >
      <figcaption>
        <h3
          id={`${testid}-title`}
          className="text-sm font-semibold text-foreground"
        >
          {title}
        </h3>
        <p
          id={`${testid}-subtitle`}
          className="mt-0.5 text-xs text-muted-foreground"
        >
          {subtitle}
        </p>
      </figcaption>
      <div className="mt-4">{children}</div>
    </figure>
  );
}

function TeamLegend({
  data,
  testid,
}: {
  data: ComparisonDatum[];
  testid: string;
}): JSX.Element {
  return (
    <ul
      data-testid={testid}
      className="flex flex-wrap gap-x-4 gap-y-2"
      aria-label="Team colors"
    >
      {data.map((team) => (
        <li key={team.teamNumber} className="flex items-center gap-2 text-sm">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-5 rounded-sm"
            style={{ backgroundColor: team.color }}
          />
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {team.teamNumber}
          </span>
          <span className="text-xs text-muted-foreground">
            {team.matchesScouted} match{team.matchesScouted === 1 ? '' : 'es'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ScoringChart({
  data,
  testid,
}: {
  data: ComparisonDatum[];
  testid: string;
}): JSX.Element {
  const rawMax = Math.max(
    0,
    ...data.flatMap((team) => [team.scoring.expected, team.scoring.epa ?? 0]),
  );
  const scaleMax = Math.max(10, Math.ceil(rawMax / 10) * 10);

  return (
    <ChartFrame
      title="Scoring composition"
      subtitle="Expected points per match split into auto fuel, teleop/endgame fuel, and climb. The line marks best-available EPA on the same points scale."
      testid={testid}
      wide
    >
      <div className="space-y-3">
        {data.map((team) => {
          const { scoring } = team;
          const segments = [
            { key: 'auto', value: scoring.auto, opacity: 0.45 },
            { key: 'teleop', value: scoring.teleopEndgame, opacity: 0.72 },
            { key: 'climb', value: scoring.climb, opacity: 1 },
          ];
          const details = `Team ${team.teamNumber}: ${scoring.expected.toFixed(1)} expected points; ${scoring.auto.toFixed(1)} auto fuel, ${scoring.teleopEndgame.toFixed(1)} teleop and endgame fuel, ${scoring.climb.toFixed(1)} climb${scoring.epa == null ? '; EPA unavailable' : `; ${scoring.epa.toFixed(1)} EPA`}`;
          return (
            <div
              key={team.teamNumber}
              data-testid={`${testid}-team-${team.teamNumber}`}
              className="grid min-w-0 grid-cols-[3.75rem_minmax(0,1fr)_3.25rem] items-center gap-2"
              role="img"
              aria-label={details}
            >
              <span className="truncate text-right font-mono text-xs font-semibold tabular-nums">
                {team.teamNumber}
              </span>
              <div className="relative h-7 min-w-0 rounded bg-muted/35">
                <div className="flex h-full overflow-hidden rounded">
                  {segments.map((segment) => (
                    <span
                      key={segment.key}
                      data-testid={`${testid}-${segment.key}-${team.teamNumber}`}
                      className="h-full"
                      style={{
                        width: `${clamp(segment.value / scaleMax, 0, 1) * 100}%`,
                        backgroundColor: team.color,
                        opacity: segment.opacity,
                      }}
                    />
                  ))}
                </div>
                {scoring.epa != null ? (
                  <span
                    data-testid={`${testid}-epa-${team.teamNumber}`}
                    aria-hidden="true"
                    className="absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 rounded bg-foreground shadow-[0_0_0_1px_hsl(var(--background))]"
                    style={{
                      left: `${clamp(scoring.epa / scaleMax, 0, 1) * 100}%`,
                    }}
                  />
                ) : null}
              </div>
              <span className="text-right font-mono text-xs tabular-nums">
                {scoring.expected.toFixed(1)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="ml-[4.25rem] mr-[3.75rem] mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>0</span>
        <span>{scaleMax} pts</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {[
          ['opacity-45', 'Auto fuel'],
          ['opacity-70', 'Teleop + endgame fuel'],
          ['opacity-100', 'Climb'],
        ].map(([opacity, label]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                'h-2.5 w-4 rounded-sm bg-muted-foreground',
                opacity,
              )}
            />
            {label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-3 w-0.5 bg-foreground" />
          EPA
        </span>
      </div>
    </ChartFrame>
  );
}

function RateChart({
  data,
  testid,
}: {
  data: ComparisonDatum[];
  testid: string;
}): JSX.Element {
  return (
    <ChartFrame
      title="Reliability & climb"
      subtitle="Shared 0–100% scale. Reliability excludes no-shows and deaths; climb is successful climbs per scouted match."
      testid={testid}
    >
      <div className="space-y-4">
        {data.map((team) => (
          <div key={team.teamNumber} className="space-y-1.5">
            <div className="font-mono text-xs font-semibold tabular-nums">
              {team.teamNumber}
            </div>
            {[
              { label: 'Reliability', value: team.reliability },
              { label: 'Climb success', value: team.climbSuccess },
            ].map((metric) => (
              <div
                key={metric.label}
                className="grid grid-cols-[5.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 text-xs"
                role="img"
                aria-label={`Team ${team.teamNumber} ${metric.label}: ${pct(metric.value)}`}
              >
                <span className="text-muted-foreground">{metric.label}</span>
                <div className="h-2.5 overflow-hidden rounded-full bg-muted/40">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${clamp(metric.value, 0, 1) * 100}%`,
                      backgroundColor: team.color,
                    }}
                  />
                </div>
                <span className="text-right font-mono tabular-nums">
                  {pct(metric.value)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="ml-[6.25rem] mr-[3.25rem] mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>0%</span>
        <span>100%</span>
      </div>
    </ChartFrame>
  );
}

function DefenseRatingChart({
  data,
  testid,
}: {
  data: ComparisonDatum[];
  testid: string;
}): JSX.Element {
  return (
    <ChartFrame
      title="Defense rating"
      subtitle="Super-scout qualitative rating on its fixed 1–10 scale; 0 means no positive rating was recorded."
      testid={testid}
    >
      <div className="space-y-3">
        {data.map((team) => (
          <div
            key={team.teamNumber}
            className="grid grid-cols-[3.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 text-xs"
            role="img"
            aria-label={`Team ${team.teamNumber} defense rating: ${team.defenseRating.toFixed(1)} out of 10`}
          >
            <span className="text-right font-mono font-semibold tabular-nums">
              {team.teamNumber}
            </span>
            <div className="h-3 overflow-hidden rounded-sm bg-muted/40">
              <div
                className="h-full rounded-sm"
                style={{
                  width: `${clamp(team.defenseRating / 10, 0, 1) * 100}%`,
                  backgroundColor: team.color,
                }}
              />
            </div>
            <span className="text-right font-mono tabular-nums">
              {team.defenseRating.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
      <div className="ml-[4.25rem] mr-[3.25rem] mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>0</span>
        <span>10</span>
      </div>
    </ChartFrame>
  );
}

function SignedImpactRail({
  team,
  label,
  value,
}: {
  team: ComparisonDatum;
  label: string;
  value: number | null;
}): JSX.Element {
  const visual = value == null ? 0 : clamp(value, -1, 1);
  const width = Math.abs(visual) * 50;
  return (
    <div
      className="grid grid-cols-[6.6rem_minmax(0,1fr)_3rem] items-center gap-2 text-xs"
      role="img"
      aria-label={`Team ${team.teamNumber} ${label}: ${value == null ? 'unavailable' : signedPct(value)}`}
    >
      <span className="text-muted-foreground">{label}</span>
      <div className="relative h-2.5 rounded-full bg-muted/40">
        <span
          aria-hidden="true"
          className="absolute inset-y-[-2px] left-1/2 w-px bg-border"
        />
        {value != null ? (
          <span
            className="absolute inset-y-0 rounded-full"
            style={{
              left: visual >= 0 ? '50%' : `${50 - width}%`,
              width: `${width}%`,
              backgroundColor: team.color,
            }}
          />
        ) : null}
      </div>
      <span className="text-right font-mono tabular-nums">
        {value == null ? '—' : signedPct(value)}
      </span>
    </div>
  );
}

function DefenseImpactChart({
  data,
  testid,
}: {
  data: ComparisonDatum[];
  testid: string;
}): JSX.Element {
  return (
    <ChartFrame
      title="Measured defense impact"
      subtitle="Signed fuel-rate change on a −100% to +100% scale. Positive is bad when defended and good when caused to opponents; defender effect requires multiple samples."
      testid={testid}
      wide
    >
      <div className="space-y-4">
        {data.map((team) => (
          <div key={team.teamNumber} className="space-y-1.5">
            <div className="font-mono text-xs font-semibold tabular-nums">
              {team.teamNumber}
            </div>
            <SignedImpactRail
              team={team}
              label="When defended"
              value={team.fuelSlowdownWhenDefended}
            />
            <SignedImpactRail
              team={team}
              label="Caused to opp."
              value={team.opponentSlowdownCaused}
            />
          </div>
        ))}
      </div>
      <div className="ml-[7.1rem] mr-[3.5rem] mt-2 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>−100%</span>
        <span>0</span>
        <span>+100%</span>
      </div>
    </ChartFrame>
  );
}

export interface TeamCompareProps {
  teams: CompareTeam[];
  testid?: string;
}

export function TeamCompare({
  teams,
  testid = 'team-compare',
}: TeamCompareProps): JSX.Element {
  const data = buildComparisonData(teams);

  if (data.length === 0) {
    return (
      <EmptyChart
        testid={`${testid}-empty`}
        message="Select 2–6 teams from the ranking table to compare."
      />
    );
  }

  if (data.length === 1) {
    return (
      <div
        data-testid={`${testid}-empty`}
        data-chart-empty="true"
        role="status"
        className="flex min-h-28 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-5 text-center"
      >
        <TeamLegend data={data} testid={`${testid}-legend`} />
        <p className="text-sm text-muted-foreground">
          Select one more team to unlock side-by-side charts.
        </p>
      </div>
    );
  }

  return (
    <section
      data-testid={testid}
      aria-label="Selected team comparison dashboard"
    >
      <TeamLegend data={data} testid={`${testid}-legend`} />
      <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
        <ScoringChart data={data} testid={`${testid}-scoring`} />
        <RateChart data={data} testid={`${testid}-rates`} />
        <DefenseRatingChart data={data} testid={`${testid}-defense-rating`} />
        <DefenseImpactChart data={data} testid={`${testid}-defense-impact`} />
      </div>
    </section>
  );
}

export default TeamCompare;
