// src/dash/NextMatchView.tsx
// Next-match preview (contracts §3, §8 testid `dash-next`). Picks OUR (3256)
// next unplayed qm, gathers the 6 teams, and renders a confidence-weighted
// prediction over scouting + Statbotics EPA — degrading gracefully when
// Statbotics is down. Pure/injectable: the active event is passed via props
// (the shell owns useActiveEvent), so this stays testable.

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  useEventMatches,
  useEventReports,
  useEventTeams,
  useEventEpa,
  type MatchRow,
  type TeamRow,
} from '@/dash/useEventData';
import { aggregateEvent, type TeamAgg } from '@/dash/aggregate';
import { predictMatch, type TeamPrediction } from '@/dash/predict';
import AutoRoutines from '@/dash/AutoRoutines';
import { OUR_TEAM } from '@/dash/constants';
import type { MsrRow } from '@/dash/types';

export interface NextMatchViewProps {
  /** The active event key (injected by the shell — do NOT resolve it here). */
  eventKey: string;
}

const SOURCE_LABEL: Record<TeamPrediction['source'], string> = {
  blend: 'blend',
  scouting: 'scouting',
  epa: 'epa',
  none: 'none',
};

const SOURCE_CLASS: Record<TeamPrediction['source'], string> = {
  blend: 'bg-violet-500/20 text-violet-300 border-violet-500/40',
  scouting: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  epa: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  none: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/40',
};

function redTeamsOf(m: MatchRow): number[] {
  return [m.red1, m.red2, m.red3].filter((t): t is number => t != null);
}
function blueTeamsOf(m: MatchRow): number[] {
  return [m.blue1, m.blue2, m.blue3].filter((t): t is number => t != null);
}
function isUnplayed(m: MatchRow): boolean {
  return m.actual_red_score == null && m.actual_blue_score == null;
}

/**
 * Pick OUR (3256) next unplayed qm: smallest match_number among unplayed qms
 * whose alliances include 3256. Fall back to the first unplayed qm if 3256 has
 * no scheduled unplayed match.
 */
export function pickNextMatch(matches: MatchRow[]): MatchRow | null {
  const unplayedQms = matches
    .filter((m) => m.comp_level === 'qm' && isUnplayed(m))
    .sort((a, b) => a.match_number - b.match_number);
  if (unplayedQms.length === 0) return null;

  const ours = unplayedQms.find(
    (m) => redTeamsOf(m).includes(OUR_TEAM) || blueTeamsOf(m).includes(OUR_TEAM),
  );
  return ours ?? unplayedQms[0];
}

function round(n: number): number {
  return Math.round(n);
}

function nicknameFor(teams: TeamRow[], teamNumber: number): string | null {
  return teams.find((t) => t.team_number === teamNumber)?.nickname ?? null;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** A small inline chip flagging that FUEL points are rate-derived (low conf). */
function FuelLowConfidenceChip() {
  return (
    <span
      data-testid="fuel-low-confidence"
      className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300"
      title="FUEL is rate-derived; treat its contribution as a low-confidence estimate."
    >
      FUEL est. — low confidence
    </span>
  );
}

interface TeamRowViewProps {
  pred: TeamPrediction;
  agg: TeamAgg | undefined;
  nickname: string | null;
}

function TeamRowView({ pred, agg, nickname }: TeamRowViewProps) {
  const matchesScouted = agg?.matchesScouted ?? 0;
  return (
    <li
      data-testid={`dash-next-team-${pred.teamNumber}`}
      className="flex min-h-[44px] flex-col gap-1 rounded-md border border-zinc-700/60 bg-zinc-900/40 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-zinc-100">
          {pred.teamNumber}
          {nickname ? (
            <span className="ml-2 text-xs font-normal text-zinc-400">{nickname}</span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums text-zinc-200" data-testid="dash-next-team-expected">
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
        <span>scouted: {matchesScouted}</span>
        <span>climb: {agg ? pct(agg.climbSuccessRate) : '—'}</span>
        <span>defense: {agg ? agg.avgDefenseRating.toFixed(1) : '—'}</span>
        <FuelLowConfidenceChip />
      </div>
    </li>
  );
}

interface AllianceColumnProps {
  side: 'red' | 'blue';
  label: string;
  score: number;
  teams: TeamPrediction[];
  agg: Map<number, TeamAgg>;
  allTeams: TeamRow[];
  reports: MsrRow[];
  isOurAlliance: boolean;
}

function AllianceColumn({
  side,
  label,
  score,
  teams,
  agg,
  allTeams,
  reports,
  isOurAlliance,
}: AllianceColumnProps) {
  return (
    <Card
      className={cn(
        'border bg-zinc-900/60',
        side === 'red' ? 'border-red-500/40' : 'border-blue-500/40',
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4">
        <CardTitle className="text-zinc-100">{label}</CardTitle>
        <span
          data-testid={`dash-next-${side}-score`}
          className={cn(
            'tabular-nums text-2xl font-bold',
            side === 'red' ? 'text-red-300' : 'text-blue-300',
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
            />
          ))}
        </ul>
        <div className="mt-3">
          <AutoRoutines reports={reports} isOurAlliance={isOurAlliance} />
        </div>
      </CardContent>
    </Card>
  );
}

export default function NextMatchView({ eventKey }: NextMatchViewProps): JSX.Element {
  const matchesQ = useEventMatches(eventKey);
  const reportsQ = useEventReports(eventKey);
  const teamsQ = useEventTeams(eventKey);

  const match = matchesQ.data ? pickNextMatch(matchesQ.data) : null;
  const redTeams = match ? redTeamsOf(match) : [];
  const blueTeams = match ? blueTeamsOf(match) : [];
  const sixTeams = [...redTeams, ...blueTeams];

  // Always call the hook (stable order); it is disabled internally when empty.
  const epaQ = useEventEpa(sixTeams, eventKey);

  const loading =
    matchesQ.isLoading || reportsQ.isLoading || teamsQ.isLoading;

  if (loading) {
    return (
      <div data-testid="dash-next" className="text-zinc-300">
        <div data-testid="dash-next-loading" className="p-6 text-sm text-zinc-400">
          Loading next match…
        </div>
      </div>
    );
  }

  if (!match) {
    return (
      <div data-testid="dash-next" className="text-zinc-300">
        <div
          data-testid="dash-next-no-match"
          className="rounded-md border border-zinc-700/60 bg-zinc-900/40 p-6 text-sm text-zinc-400"
        >
          No upcoming unplayed qualification match found.
        </div>
      </div>
    );
  }

  const reports = reportsQ.data ?? [];
  const allTeams = teamsQ.data ?? [];
  const epa = epaQ.data ?? { epaByTeam: new Map<number, number | null>(), available: false };

  const agg = aggregateEvent(reports);
  const pred = predictMatch({
    redTeams,
    blueTeams,
    agg,
    epaByTeam: epa.epaByTeam,
    statboticsAvailable: epa.available,
  });

  const ourAllianceIsRed = redTeams.includes(OUR_TEAM);
  const redReports = reports.filter((r) => redTeams.includes(r.target_team_number));
  const blueReports = reports.filter((r) => blueTeams.includes(r.target_team_number));

  return (
    <div data-testid="dash-next" className="flex flex-col gap-4 text-zinc-200">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-zinc-100">
          Qualification {match.match_number}
        </h2>
        <span
          data-testid="dash-next-red-winprob"
          className="rounded-md border border-zinc-700/60 bg-zinc-900/50 px-3 py-1 text-sm text-zinc-300"
        >
          Red win probability: {pct(pred.redWinProb)}
        </span>
      </div>

      {!epa.available ? (
        <div
          data-testid="epa-unavailable"
          role="status"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
        >
          Statbotics EPA unavailable — predictions use scouting only.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <AllianceColumn
          side="red"
          label="Red Alliance"
          score={pred.red.score}
          teams={pred.red.teams}
          agg={agg}
          allTeams={allTeams}
          reports={redReports}
          isOurAlliance={ourAllianceIsRed}
        />
        <AllianceColumn
          side="blue"
          label="Blue Alliance"
          score={pred.blue.score}
          teams={pred.blue.teams}
          agg={agg}
          allTeams={allTeams}
          reports={blueReports}
          isOurAlliance={!ourAllianceIsRed}
        />
      </div>
    </div>
  );
}
