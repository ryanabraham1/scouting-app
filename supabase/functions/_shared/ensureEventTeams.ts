// supabase/functions/_shared/ensureEventTeams.ts
//
// `match.red1..blue3` reference `event_team(event_key, team_number)`, and
// event_team is only filled by the one-time TBA import. A team TBA adds to the
// event after that import (late registration, a swap, a schedule regenerated)
// made every later match write fail on the FK — and because the reconcile
// upserts in bulk, ONE such team froze the whole event's schedule and results.
// Scout reports for that team then dead-lettered on the same FK
// (msr_event_team_fkey / pit_report_event_team_fkey).
//
// Before writing match rows, the caller runs the service-role
// `ensure_event_teams` RPC (migration 20260927230100) for the teams those rows
// name. Only teams in TBA's own match data are added, so this never invents
// participants. Pure (no esm imports) so vitest can cover it; the caller passes
// the RPC call so its literal name stays visible to the grant-manifest test.

import { TEAM_COLUMNS, type MatchRow } from "./tbaMatchRow.ts";

/** Every team number the rows reference (roster columns only). */
export function referencedTeamNumbers(rows: readonly MatchRow[]): number[] {
  const teams = new Set<number>();
  for (const row of rows) {
    for (const column of TEAM_COLUMNS) {
      const value = row[column];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        teams.add(value);
      }
    }
  }
  return [...teams].sort((a, b) => a - b);
}

export interface EventTeamInput {
  team_number: number;
  nickname?: string;
}

/** `(teams) => svc.rpc("ensure_event_teams", { p_event_key, p_teams: teams })`. */
export type EnsureEventTeamsRpc = (
  teams: EventTeamInput[],
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * Make sure the event has every team `rows` reference. Returns the team numbers
 * that were newly added. For those (rare) additions `nicknameFor` is consulted
 * best-effort and a second call fills the missing nicknames in.
 */
export async function ensureEventTeams(
  callRpc: EnsureEventTeamsRpc,
  rows: readonly MatchRow[],
  nicknameFor?: (teamNumber: number) => Promise<string | null>,
): Promise<number[]> {
  const referenced = referencedTeamNumbers(rows);
  if (referenced.length === 0) return [];

  const { data, error } = await callRpc(referenced.map((team_number) => ({ team_number })));
  if (error) throw new Error(error.message);
  const added = Array.isArray(data)
    ? data.filter((team): team is number => Number.isSafeInteger(team) && team > 0)
    : [];
  if (added.length === 0 || !nicknameFor) return added;

  const named: EventTeamInput[] = [];
  for (const team_number of added) {
    try {
      const nickname = await nicknameFor(team_number);
      if (nickname) named.push({ team_number, nickname });
    } catch {
      // Best-effort: the team row already exists without a nickname.
    }
  }
  if (named.length > 0) {
    const fill = await callRpc(named);
    if (fill.error) console.warn("[ensureEventTeams] nickname fill failed", fill.error.message);
  }
  return added;
}
