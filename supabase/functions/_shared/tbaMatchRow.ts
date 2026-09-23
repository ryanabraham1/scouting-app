// supabase/functions/_shared/tbaMatchRow.ts
// Pure TBA Match -> `match` row mapping shared by the two writers of match
// results: `tba-webhook` (push) and `sync-event-results` (pull reconcile).
// They used to carry separate copies that drifted (truthy vs > 0 timestamps,
// one path could NULL a roster the other never would). Keeping one copy means a
// webhook-landed row and a reconcile-landed row are always byte-identical.
//
// No imports on purpose: Deno loads this with a `.ts` specifier and the Vitest
// contract test (tests/functions/tbaMatchRow.test.ts) loads it from Node.

export const ALLOWED_LEVELS = new Set(["qm", "ef", "qf", "sf", "f"]);

export interface TbaAlliance {
  score?: number | null;
  teams?: string[];
  team_keys?: string[];
}

export interface TbaMatch {
  key?: string;
  event_key?: string;
  comp_level?: string;
  match_number?: number;
  set_number?: number;
  time?: number | null;
  predicted_time?: number | null;
  actual_time?: number | null;
  winning_alliance?: string | null;
  alliances?: { red?: TbaAlliance; blue?: TbaAlliance };
}

export type MatchRow = Record<string, unknown>;

export const TEAM_COLUMNS = ["red1", "red2", "red3", "blue1", "blue2", "blue3"] as const;

/** `frcNNNN` -> NNNN; anything unparseable (or a non-positive number) -> null. */
export function teamNum(teamKey: unknown): number | null {
  if (typeof teamKey !== "string" && typeof teamKey !== "number") return null;
  const n = parseInt(String(teamKey).replace(/^frc/i, ""), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** TBA epoch seconds -> ISO string; missing / zero / garbage -> null. */
export function epochToIso(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** A played score is a finite, non-negative number (TBA uses -1 for unplayed). */
function playedScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Winner from TBA's field if present, else derived from the two scores. */
export function winnerOf(
  m: Pick<TbaMatch, "winning_alliance">,
  red: number | null,
  blue: number | null,
): string | null {
  const wa = String(m.winning_alliance ?? "").toLowerCase();
  if (wa === "red" || wa === "blue") return wa;
  if (red == null || blue == null) return null;
  if (red > blue) return "red";
  if (blue > red) return "blue";
  return "tie";
}

function allianceKeys(alliance: TbaAlliance | undefined): unknown[] {
  const keys = alliance?.team_keys ?? alliance?.teams;
  return Array.isArray(keys) ? keys : [];
}

export interface MappedMatch {
  row: MatchRow;
  played: boolean;
  /** Whether the row carries roster columns (see tbaMatchToRow). */
  hasTeams: boolean;
}

/**
 * Map a TBA Match object to a `match` upsert row, or null when it is unusable
 * (no key, or a comp level we do not store).
 *
 *   - Roster columns are written only for an alliance that actually lists
 *     teams: a result-only / malformed payload must never NULL out the teams
 *     the importer already populated (an upsert leaves omitted columns as-is).
 *   - Result columns are always present: null while unplayed, so a new row
 *     lands in the "unplayed" set the next-match selector reads. Callers use
 *     shouldWriteMatchRow() so a regressed TBA payload cannot erase a result.
 *   - `timing: "present-only"` (webhook) omits a missing time instead of
 *     writing null, since one notification may carry only part of the picture.
 */
export function tbaMatchToRow(
  m: TbaMatch,
  eventKey: string,
  opts: { timing?: "authoritative" | "present-only"; now?: Date } = {},
): MappedMatch | null {
  const matchKey = typeof m?.key === "string" ? m.key : "";
  const compLevel = String(m?.comp_level ?? "").toLowerCase();
  if (!matchKey || !eventKey || !ALLOWED_LEVELS.has(compLevel)) return null;

  const redScore = playedScore(m.alliances?.red?.score);
  const blueScore = playedScore(m.alliances?.blue?.score);
  const played = redScore != null && blueScore != null;

  const row: MatchRow = {
    match_key: matchKey,
    event_key: eventKey,
    comp_level: compLevel,
    match_number:
      typeof m.match_number === "number" && Number.isSafeInteger(m.match_number)
        ? m.match_number
        : null,
    actual_red_score: played ? redScore : null,
    actual_blue_score: played ? blueScore : null,
    winner: played ? winnerOf(m, redScore, blueScore) : null,
    result_synced_at: played ? (opts.now ?? new Date()).toISOString() : null,
  };

  let hasTeams = false;
  const redKeys = allianceKeys(m.alliances?.red);
  const blueKeys = allianceKeys(m.alliances?.blue);
  if (redKeys.length > 0) {
    row.red1 = teamNum(redKeys[0]);
    row.red2 = teamNum(redKeys[1]);
    row.red3 = teamNum(redKeys[2]);
    hasTeams = true;
  }
  if (blueKeys.length > 0) {
    row.blue1 = teamNum(blueKeys[0]);
    row.blue2 = teamNum(blueKeys[1]);
    row.blue3 = teamNum(blueKeys[2]);
    hasTeams = true;
  }

  const timing = opts.timing ?? "authoritative";
  const times: Array<[string, string | null]> = [
    ["scheduled_time", epochToIso(m.time)],
    ["predicted_time", epochToIso(m.predicted_time)],
    // FMS actual start — drives the livestream match-jump on the dashboard.
    ["actual_time", epochToIso(m.actual_time)],
  ];
  for (const [column, value] of times) {
    if (value != null || timing === "authoritative") row[column] = value;
  }

  return { row, played, hasTeams };
}

/**
 * Webhook shape: a `match_score` notification that has NOT been played must
 * not touch the result columns at all (the push can arrive out of order with
 * the reconcile). Strips them so the upsert leaves the stored result alone.
 */
export function withoutUnplayedResult(mapped: MappedMatch): MatchRow {
  if (mapped.played) return mapped.row;
  const {
    actual_red_score: _r,
    actual_blue_score: _b,
    winner: _w,
    result_synced_at: _s,
    ...rest
  } = mapped.row;
  return rest;
}

/** The subset of a stored `match` row the reconcile diff reads. */
export interface StoredMatch {
  scheduled_time?: string | null;
  predicted_time?: string | null;
  actual_time?: string | null;
  actual_red_score?: number | null;
  actual_blue_score?: number | null;
  winner?: string | null;
  red1?: number | null;
  red2?: number | null;
  red3?: number | null;
  blue1?: number | null;
  blue2?: number | null;
  blue3?: number | null;
}

/** Compare timestamptz values by instant, not by `Z` versus `+00:00` spelling. */
export function sameTimestamp(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  return Number.isFinite(aMs) && Number.isFinite(bMs) && aMs === bMs;
}

/**
 * Reconcile diff: write a mapped row only when it is new or carries a real
 * change, so a 60 s reconcile doesn't rewrite the whole schedule every minute.
 *
 *   - Never let an unplayed-shaped payload erase a result we already hold
 *     (TBA occasionally regresses a played match for a moment).
 *   - A roster change (FMS schedule re-publish, playoff alliance fill-in) is a
 *     change even when timing and result are identical — before this, the
 *     reconcile silently kept the stale roster forever.
 *   - A winner flip with numerically equal scores (DQ / tiebreaker) counts.
 */
export function shouldWriteMatchRow(
  prev: StoredMatch | undefined,
  mapped: MappedMatch,
): boolean {
  if (!prev) return true;
  const { row, played } = mapped;
  if (!played && (prev.actual_red_score != null || prev.actual_blue_score != null || prev.winner != null)) {
    return false;
  }
  const timingChanged =
    !sameTimestamp(prev.scheduled_time ?? null, row.scheduled_time ?? null) ||
    !sameTimestamp(prev.predicted_time ?? null, row.predicted_time ?? null) ||
    !sameTimestamp(prev.actual_time ?? null, row.actual_time ?? null);
  const teamsChanged =
    mapped.hasTeams &&
    TEAM_COLUMNS.some(
      (column) => column in row && (prev[column] ?? null) !== (row[column] ?? null),
    );
  if (timingChanged || teamsChanged) return true;
  if (!played) return false;
  return (
    (prev.actual_red_score ?? null) !== row.actual_red_score ||
    (prev.actual_blue_score ?? null) !== row.actual_blue_score ||
    (prev.winner ?? null) !== row.winner
  );
}

/**
 * Map a TBA `upcoming_match` notification to a schedule-only row (never touches
 * result columns). The key tail "<level><set>m<game>" is parsed so a playoff
 * match gets match_number = the GAME within its set, exactly what the
 * match_score path writes for the same key.
 *
 * `team_keys` is red[0..2] then blue[3..5]; roster columns are written only
 * when all six are present so a partial payload cannot NULL a stored roster.
 */
export function upcomingMatchToRow(data: Record<string, unknown>): MatchRow | null {
  const matchKey = typeof data.match_key === "string" ? data.match_key : "";
  const eventKey = typeof data.event_key === "string" ? data.event_key : "";
  if (!matchKey || !eventKey) return null;
  const tail = matchKey.includes("_") ? matchKey.slice(matchKey.lastIndexOf("_") + 1) : matchKey;
  const parsed = tail.match(/^([a-zA-Z]+)(\d+)(?:m(\d+))?/);
  const lvl = (parsed?.[1] ?? "").toLowerCase();
  if (!ALLOWED_LEVELS.has(lvl)) return null;
  const num = Number(parsed?.[3] ?? parsed?.[2] ?? NaN);

  const row: MatchRow = {
    match_key: matchKey,
    event_key: eventKey,
    comp_level: lvl,
    match_number: Number.isSafeInteger(num) ? num : null,
  };
  const teamKeys = Array.isArray(data.team_keys) ? data.team_keys : [];
  if (teamKeys.length >= 6) {
    TEAM_COLUMNS.forEach((column, index) => {
      row[column] = teamNum(teamKeys[index]);
    });
  }
  const scheduled = epochToIso(data.scheduled_time);
  const predicted = epochToIso(data.predicted_time);
  if (scheduled) row.scheduled_time = scheduled;
  if (predicted) row.predicted_time = predicted;
  return row;
}
