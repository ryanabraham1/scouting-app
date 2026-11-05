// src/dash/autoScoutStats.ts — Auto-Scout estimates per team, for the pages that show scouting
// data. Deliberately not folded into TeamAgg: estimates stay labelled and never count as a second
// observation of a match a scout already covered.
import type { AutoScoutResultRow, AutoScoutTeam } from '@/dash/autoScoutClient';

/** Below this the bumper read is a guess, so the row is marked rather than trusted. */
export const LOW_IDENTITY_CONFIDENCE = 0.6;

export interface AutoScoutTeamMatch {
  matchKey: string;
  alliance: string | null;
  fuel: number | null;
  fuelAuto: number | null;
  fuelTeleop: number | null;
  fed: number | null;
  points: number | null;
  autoTower: string | null;
  endgameTower: string | null;
  lowConfidence: boolean;
}

export interface AutoScoutTeamSummary {
  matches: AutoScoutTeamMatch[];
  avgFuel: number | null;
  avgFuelAuto: number | null;
  avgFuelTeleop: number | null;
  avgFed: number | null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tower(value: unknown): string | null {
  return typeof value === 'string' && value && value !== 'None' ? value : null;
}

function average(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v != null);
  return known.length ? known.reduce((sum, v) => sum + v, 0) / known.length : null;
}

function seatConfidence(row: AutoScoutResultRow, team: AutoScoutTeam): number | null {
  if (!row.identity_conf || typeof team.station !== 'number') return null;
  return num(row.identity_conf[`${team.alliance}${team.station - 1}`]);
}

export function toTeamMatch(row: AutoScoutResultRow, team: AutoScoutTeam): AutoScoutTeamMatch {
  const confidence = seatConfidence(row, team);
  return {
    matchKey: row.match_key,
    alliance: typeof team.alliance === 'string' ? team.alliance : null,
    fuel: num(team.fuel_scored),
    fuelAuto: num(team.fuel_scored_auto),
    fuelTeleop: num(team.fuel_scored_teleop),
    fed: num(team.fuel_fed),
    points: num(team.points_contributed),
    autoTower: tower(team.auto_tower),
    endgameTower: tower(team.endgame_tower),
    lowConfidence: confidence != null && confidence < LOW_IDENTITY_CONFIDENCE,
  };
}

export function teamAutoScout(results: AutoScoutResultRow[] | undefined, teamNumber: number): AutoScoutTeamSummary | null {
  const matches = (results ?? [])
    .filter((row) => row.teams?.[teamNumber])
    .map((row) => toTeamMatch(row, row.teams[teamNumber]))
    .sort((a, b) => a.matchKey.localeCompare(b.matchKey, undefined, { numeric: true }));
  if (matches.length === 0) return null;
  // A guessed identity may be another robot's work, so it stays visible but out of the average.
  const trusted = matches.filter((m) => !m.lowConfidence);
  return {
    matches,
    avgFuel: average(trusted.map((m) => m.fuel)),
    avgFuelAuto: average(trusted.map((m) => m.fuelAuto)),
    avgFuelTeleop: average(trusted.map((m) => m.fuelTeleop)),
    avgFed: average(trusted.map((m) => m.fed)),
  };
}

/** Mean auto-scouted fuel per team, for a ranking column. */
export function autoFuelByTeam(results: AutoScoutResultRow[] | undefined): Map<number, number> {
  const teams = new Set<number>();
  for (const row of results ?? []) for (const team of Object.keys(row.teams ?? {})) teams.add(Number(team));
  const out = new Map<number, number>();
  for (const team of teams) {
    const avg = teamAutoScout(results, team)?.avgFuel;
    if (avg != null) out.set(team, avg);
  }
  return out;
}
