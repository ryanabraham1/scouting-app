// src/dash/TeamView.tsx
// TEAMVIEW (contracts §2 TeamAgg, §5 hooks, §8 testids). A staff-facing team
// deep-dive: pick a team from the event roster, then render that team's TeamAgg
// (fuel breakdown with a rate-FUEL low-confidence chip, climb, defense,
// reliability, scoutingExpectedPoints), its Statbotics EPA (or an "unavailable"
// note when Statbotics is down — never hard-fail), and the team's scouted
// matches. Dark theme, shadcn primitives, 44px touch targets.

import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { aggregateEvent, type TeamAgg } from '@/dash/aggregate';
import { useEventTeams, useEventReports, useEventEpa } from '@/dash/useEventData';
import type { MsrRow } from '@/dash/types';

export interface TeamViewProps {
  eventKey: string;
}

/** Confidence below this surfaces the rate-FUEL low-confidence chip. */
const LOW_CONFIDENCE_THRESHOLD = 0.7;

const CONTROL_MIN_HEIGHT = 44; // px — touch target floor

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}
function pct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

function Stat(props: {
  label: string;
  value: string;
  testid: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
      <span className="text-xs uppercase tracking-wide text-zinc-400">{props.label}</span>
      <span className="text-lg font-semibold text-zinc-100" data-testid={props.testid}>
        {props.value}
      </span>
      {props.hint ? <span className="text-xs text-zinc-500">{props.hint}</span> : null}
    </div>
  );
}

function TeamDetail(props: {
  agg: TeamAgg;
  matches: MsrRow[];
  epaNode: JSX.Element;
}): JSX.Element {
  const { agg, matches } = props;
  const lowConfidence = agg.meanFuelConfidence < LOW_CONFIDENCE_THRESHOLD;
  const downWeight = agg.meanFuelPoints - agg.fuelPointsWeighted;

  return (
    <div data-testid="team-detail" className="flex flex-col gap-4">
      {/* Fuel */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-zinc-100">Fuel</CardTitle>
          {lowConfidence ? (
            <span
              data-testid="team-fuel-lowconf-chip"
              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-300"
              title="FUEL is rate-derived; points are down-weighted by fuel_estimate_confidence."
            >
              rate-FUEL · low confidence ({pct(agg.meanFuelConfidence)})
            </span>
          ) : null}
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Auto fuel" value={fmt(agg.meanAutoFuel)} testid="team-mean-auto-fuel" />
          <Stat
            label="Teleop active"
            value={fmt(agg.meanTeleopFuelActive)}
            testid="team-mean-teleop-active"
          />
          <Stat
            label="Teleop inactive"
            value={fmt(agg.meanTeleopFuelInactive)}
            testid="team-mean-teleop-inactive"
          />
          <Stat label="Endgame fuel" value={fmt(agg.meanEndgameFuel)} testid="team-mean-endgame-fuel" />
          <Stat label="Total fuel" value={fmt(agg.meanTotalFuel)} testid="team-mean-total-fuel" />
          <Stat
            label="Mean fuel points (raw)"
            value={fmt(agg.meanFuelPoints)}
            testid="team-mean-fuel-points"
          />
          <Stat
            label="Fuel points (weighted)"
            value={fmt(agg.fuelPointsWeighted)}
            testid="team-fuel-points-weighted"
            hint={`down-weighted −${fmt(downWeight)} (×${fmt(agg.meanFuelConfidence, 2)})`}
          />
        </CardContent>
      </Card>

      {/* Climb / defense / reliability */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="space-y-0">
          <CardTitle className="text-zinc-100">Climb · Defense · Reliability</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat
            label="Climb success"
            value={pct(agg.climbSuccessRate)}
            testid="team-climb-success-rate"
          />
          <Stat label="Avg climb level" value={fmt(agg.avgClimbLevel)} testid="team-avg-climb-level" />
          <Stat
            label="Mean climb points"
            value={fmt(agg.meanClimbPoints)}
            testid="team-mean-climb-points"
          />
          <Stat
            label="Avg defense"
            value={fmt(agg.avgDefenseRating)}
            testid="team-avg-defense-rating"
          />
          <Stat
            label="Reliability"
            value={pct(agg.reliability)}
            testid="team-reliability"
            hint={`no-show ${pct(agg.noShowRate)} · died ${pct(agg.diedRate)}`}
          />
          <Stat
            label="Scouting expected pts"
            value={fmt(agg.scoutingExpectedPoints)}
            testid="team-scouting-expected"
          />
        </CardContent>
      </Card>

      {/* Statbotics EPA */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="space-y-0">
          <CardTitle className="text-zinc-100">Statbotics EPA</CardTitle>
        </CardHeader>
        <CardContent>{props.epaNode}</CardContent>
      </Card>

      {/* Scouted matches */}
      <Card className="border-zinc-800 bg-zinc-950">
        <CardHeader className="space-y-0">
          <CardTitle className="text-zinc-100">Scouted matches ({matches.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <ul data-testid="team-match-list" className="flex flex-col gap-2">
            {matches.map((m, i) => {
              const climb = m.climb_success ? `L${m.climb_level}` : 'no climb';
              return (
                <li
                  key={`${m.match_key}-${i}`}
                  className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200"
                >
                  <span className="font-mono">{m.match_key}</span>
                  <span className="text-zinc-400">
                    fuel {fmt(m.fuel_points)} · {climb}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

export default function TeamView(props: TeamViewProps): JSX.Element {
  const { eventKey } = props;
  const [selected, setSelected] = useState<number | null>(null);

  const teamsQuery = useEventTeams(eventKey);
  const reportsQuery = useEventReports(eventKey);

  // EPA only for the selected team (never hard-fail on Statbotics outage).
  const epaTeams = useMemo(() => (selected != null ? [selected] : []), [selected]);
  const epaQuery = useEventEpa(epaTeams, eventKey);

  // Aggregate the whole event once; index the selected team's TeamAgg out of it.
  const reports = reportsQuery.data ?? [];
  const aggByTeam = useMemo(() => aggregateEvent(reports), [reports]);

  const loading = teamsQuery.isLoading || reportsQuery.isLoading;
  const teams = teamsQuery.data ?? [];

  const agg = selected != null ? aggByTeam.get(selected) : undefined;
  const teamMatches = useMemo(
    () =>
      selected != null
        ? reports.filter((r) => r.target_team_number === selected && !r.deleted)
        : [],
    [reports, selected],
  );

  // EPA node: number when available, "unavailable" note when Statbotics is down.
  const epa = epaQuery.data;
  const epaValue = selected != null ? epa?.epaByTeam.get(selected) ?? null : null;
  const epaAvailable = epa?.available === true && epaValue != null;
  const epaNode = (
    <div data-testid="team-epa">
      {epaAvailable ? (
        <span className="text-2xl font-semibold text-zinc-100">{fmt(epaValue as number)}</span>
      ) : (
        <span className="text-sm text-zinc-400">
          EPA unavailable — Statbotics is offline or has no data for this team.
        </span>
      )}
    </div>
  );

  return (
    <div data-testid="dash-team" className="flex flex-col gap-4 text-zinc-100">
      <div className="flex flex-col gap-2">
        <label htmlFor="team-select" className="text-sm font-medium text-zinc-300">
          Team
        </label>
        <select
          id="team-select"
          data-testid="team-select"
          value={selected ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            setSelected(v === '' ? null : Number(v));
          }}
          style={{ minHeight: CONTROL_MIN_HEIGHT }}
          className={cn(
            'w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500',
          )}
        >
          <option value="">Select a team…</option>
          {teams
            .slice()
            .sort((a, b) => a.team_number - b.team_number)
            .map((t) => (
              <option key={t.team_number} value={t.team_number}>
                {t.team_number}
                {t.nickname ? ` — ${t.nickname}` : ''}
              </option>
            ))}
        </select>
      </div>

      {loading ? (
        <div data-testid="team-loading" className="text-sm text-zinc-400">
          Loading event data…
        </div>
      ) : selected == null ? (
        <div data-testid="team-prompt" className="text-sm text-zinc-400">
          Pick a team to see its scouting profile.
        </div>
      ) : agg ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-zinc-100">Team {selected}</span>
            <span data-testid="team-matches-scouted" className="text-sm text-zinc-400">
              {agg.matchesScouted} match{agg.matchesScouted === 1 ? '' : 'es'} scouted
            </span>
          </div>
          <TeamDetail agg={agg} matches={teamMatches} epaNode={epaNode} />
        </div>
      ) : (
        <div
          data-testid="team-no-data"
          className="rounded-md border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400"
        >
          No scouting reports for team {selected} at this event yet.
          {/* EPA may still be available; show it so the team isn't a dead end. */}
          <div className="mt-3">{epaNode}</div>
        </div>
      )}
    </div>
  );
}
