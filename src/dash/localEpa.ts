// src/dash/localEpa.ts
// A point-unit "overall EPA" computed from played match results (actual scores +
// alliance rosters). Used as a fallback when Statbotics is offline so the
// next-match prediction and Total-EPA tile still have a baseline.
//
// This ports the SCALAR (overall, index-0) recurrence from the live Statbotics
// source (github.com/avgupta456/statbotics, backend/src/models/epa/*) for modern
// games (>= 2016). It deliberately does NOT replicate the full multi-dimensional
// component model (auto/teleop/endgame/RP + per-year score-breakdown logic + the
// MLE-fit year-normalized distributions), which needs year-wide stats. The
// overall EPA is what we display and what predicts alliance score, so the scalar
// port is the right scope.
//
// NOTE (component-epa-estimation): the raw TBA `score_breakdown` JSON DOES exist
// per-event (it is dropped on the way into MatchRow). `parseRebuiltBreakdown`
// below is the dark, flag-gated, single-event Tier-2 seam that reads it once the
// 2026 REBUILT field names are confirmed. The shipped v1 component split does
// NOT use it — it decomposes the already-shown prediction total instead.
//
// Algorithm (per played match, chronological by match_number):
//   * Init each team's EPA = max(0, mean/NUM_TEAMS - 0.2*sd)  (init.py, no history),
//     mean/sd = mean & population std of this dataset's alliance scores.
//   * Snapshot predicted alliance score = sum of its teams' EPAs (pre-update).
//   * For each team, with N = quals it has played so far (pre-match):
//       percent = (2/3) * clamp(0.5 - (1/30)*(N-6), 0.3, 0.5)   (percent_func)
//       ΔEPA    = weight * percent * (ownScore - ownEPA) / NUM_TEAMS
//     where weight = 1 for quals, 1/3 for playoffs (ELIM_WEIGHT). MARGIN is 0 for
//     modern games, so there is no opponent term. All six updates use the SAME
//     pre-match snapshot; apply, then increment N for QUAL matches only. Null
//     roster slots are skipped.

import type { MatchRow } from '@/dash/useEventData';

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function finiteOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** "frc254" → 254; anything malformed → null. */
function teamKeyToNum(key: unknown): number | null {
  if (typeof key !== 'string') return null;
  const n = Number(key.replace(/^frc/i, ''));
  return Number.isFinite(n) ? n : null;
}

/** Chronological sort key for a TBA match: when it was (or will be) played. */
function matchTime(m: Record<string, unknown>): number {
  return (
    finiteOrNull(m.actual_time) ??
    finiteOrNull(m.predicted_time) ??
    finiteOrNull(m.time) ??
    0
  );
}

const COMP_LEVEL_ORDER: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };

/**
 * Convert a TBA matches payload (`/event/{event}/matches` or
 * `/team/{team}/matches/{year}`) into the {@link MatchRow} shape that
 * {@link computeLocalEpa} consumes. This is the bridge that lets the EPA model
 * run on real results when Statbotics is down — the local `match` table only
 * stores the schedule (the importer never writes scores), so TBA is the source
 * of actual results.
 *
 * Matches are sorted chronologically (actual/predicted/scheduled time, then
 * comp_level + match_number) and given a synthetic monotonic `match_number` so
 * the EPA model processes them in true play order across events and playoff
 * rounds (raw match_number resets per event/level). Unplayed matches (TBA
 * reports an alliance `score` of -1 before results) keep null actual scores so
 * the model ignores them. Defensive: skips malformed entries, never throws.
 */
export function tbaMatchesToRows(json: unknown): MatchRow[] {
  if (!Array.isArray(json)) return [];
  const parsed: Array<{ row: MatchRow; t: number; cl: number; n: number }> = [];

  for (const m of json) {
    if (!isObject(m) || !isObject(m.alliances)) continue;
    const red = isObject(m.alliances.red) ? m.alliances.red : null;
    const blue = isObject(m.alliances.blue) ? m.alliances.blue : null;
    if (!red || !blue) continue;

    const redKeys = Array.isArray(red.team_keys) ? red.team_keys : [];
    const blueKeys = Array.isArray(blue.team_keys) ? blue.team_keys : [];
    const redScore = finiteOrNull(red.score);
    const blueScore = finiteOrNull(blue.score);
    const played =
      redScore != null && blueScore != null && redScore >= 0 && blueScore >= 0;

    const compLevel = typeof m.comp_level === 'string' ? m.comp_level : 'qm';
    const matchNumber = finiteOrNull(m.match_number) ?? 0;
    const winner = typeof m.winning_alliance === 'string' ? m.winning_alliance : null;

    parsed.push({
      t: matchTime(m),
      cl: COMP_LEVEL_ORDER[compLevel] ?? 0,
      n: matchNumber,
      row: {
        match_key: typeof m.key === 'string' ? m.key : '',
        event_key: typeof m.event_key === 'string' ? m.event_key : '',
        comp_level: compLevel,
        match_number: matchNumber,
        scheduled_time: null,
        red1: teamKeyToNum(redKeys[0]),
        red2: teamKeyToNum(redKeys[1]),
        red3: teamKeyToNum(redKeys[2]),
        blue1: teamKeyToNum(blueKeys[0]),
        blue2: teamKeyToNum(blueKeys[1]),
        blue3: teamKeyToNum(blueKeys[2]),
        actual_red_score: played ? redScore : null,
        actual_blue_score: played ? blueScore : null,
        winner: played && winner ? winner : null,
        result_synced_at: null,
      },
    });
  }

  parsed.sort((a, b) => a.t - b.t || a.cl - b.cl || a.n - b.n);
  return parsed.map((p, i) => ({ ...p.row, match_number: i + 1 }));
}

// EPA update learning rate (the EWMA "percent"), ported from Statbotics
// `models/epa/main.py::EPA.percent_func` for modern years (>= 2016):
//   prev    = clamp(0.5 - (1/30)*(N-6), 0.3, 0.5)        (== the blog's K)
//   percent = (2/3) * prev                                (the modern-year scale)
// N is the number of QUALIFICATION matches the team has played so far.
function percentOf(n: number): number {
  const prev = Math.min(0.5, Math.max(0.3, 0.5 - (1 / 30) * (n - 6)));
  return (2 / 3) * prev;
}

// Statbotics' margin parameter (`EPA.margin_func`) is 0 for every modern game
// (only 2002/2003 use 1), so the overall-EPA update has no opponent term.
const MARGIN = 0;
// Alliances are 3 teams; the alliance residual is attributed equally across them
// (`attribute_match`: err / num_teams). Matches Statbotics for 2005+.
const NUM_TEAMS = 3;
// Playoff (elim) matches update at 1/3 weight and don't advance the match count
// (`update_team`: weight = ELIM_WEIGHT = 1/3; counts only bump on quals).
const ELIM_WEIGHT = 1 / 3;
// Init z-score for a team with no prior-season data: INIT_PENALTY from
// `models/epa/constants.py` (NORM_MEAN 1500, NORM_SD 250, INIT_PENALTY 0.2 ->
// curr_norm_epa collapses to 1450, z = (1450-1500)/250 = -0.2).
const INIT_PENALTY = 0.2;

function redOf(m: MatchRow): Array<number | null> {
  return [m.red1, m.red2, m.red3];
}
function blueOf(m: MatchRow): Array<number | null> {
  return [m.blue1, m.blue2, m.blue3];
}

function isPlayed(m: MatchRow): boolean {
  return m.actual_red_score != null && m.actual_blue_score != null;
}

/** Options for {@link computeLocalEpa}. */
export interface LocalEpaOptions {
  /**
   * Recency tilt (default 0 = exact Statbotics port). Re-weights each match's
   * update by its chronological position so recent form counts more: a CENTERED
   * multiplier where the oldest match scales by `1 - recencyBoost/2` and the
   * newest by `1 + recencyBoost/2` (mean ≈ 1, so it tilts toward recent matches
   * without inflating the overall learning rate). See EPA_RECENCY_BOOST.
   */
  recencyBoost?: number;
}

/**
 * Compute a local EPA (total points) per team from played matches.
 * Returns an empty map when there are no played matches.
 */
export function computeLocalEpa(
  matches: MatchRow[],
  options: LocalEpaOptions = {},
): Map<number, number> {
  const recencyBoost = options.recencyBoost ?? 0;
  const played = matches
    .filter(isPlayed)
    .slice()
    .sort((a, b) => a.match_number - b.match_number);

  const epa = new Map<number, number>();
  if (played.length === 0) return epa;

  // Recency multiplier for the match at chronological index `i` of `total`.
  const total = played.length;
  const recencyMult = (i: number): number => {
    if (recencyBoost === 0 || total <= 1) return 1;
    const frac = i / (total - 1); // 0 (oldest) .. 1 (newest)
    return 1 + recencyBoost * (frac - 0.5); // centered: mean ≈ 1
  };

  // Init EPA, ported from Statbotics `models/epa/init.py::get_init_epa` with no
  // prior-season data: year_mean/NUM_TEAMS + year_sd * z, z = -INIT_PENALTY,
  // floored at >= 0 (the z-score clamp). year_mean/year_sd are the mean and
  // population std of the alliance scores in this dataset (the local analogue of
  // Statbotics' year-wide score stats).
  const allianceScores: number[] = [];
  for (const m of played) {
    allianceScores.push(m.actual_red_score as number, m.actual_blue_score as number);
  }
  const yearMean = allianceScores.reduce((s, x) => s + x, 0) / allianceScores.length;
  const yearVar =
    allianceScores.reduce((s, x) => s + (x - yearMean) ** 2, 0) / allianceScores.length;
  const yearSd = Math.sqrt(yearVar);
  const init = Math.max(0, yearMean / NUM_TEAMS - INIT_PENALTY * yearSd);

  const nByTeam = new Map<number, number>();
  const ensure = (team: number): void => {
    if (!epa.has(team)) {
      epa.set(team, init);
      nByTeam.set(team, 0);
    }
  };

  played.forEach((m, i) => {
    const reds = redOf(m).filter((t): t is number => t != null);
    const blues = blueOf(m).filter((t): t is number => t != null);
    for (const t of [...reds, ...blues]) ensure(t);

    const redScore = m.actual_red_score as number;
    const blueScore = m.actual_blue_score as number;
    const elim = m.comp_level !== 'qm';
    const weight = elim ? ELIM_WEIGHT : 1;
    // Recent matches count more (centered tilt; 1 when recencyBoost is 0).
    const rec = recencyMult(i);

    // Pre-match snapshot of predicted alliance scores (sum of team EPAs), used
    // for ALL six updates so they don't see each other within the match.
    const redEPA = reds.reduce((s, t) => s + (epa.get(t) as number), 0);
    const blueEPA = blues.reduce((s, t) => s + (epa.get(t) as number), 0);

    // Per-team Δ, ported from main.py (attribute_match + math.py add_obs, MARGIN=0):
    //   err  = (ownScore - ownEPA) - MARGIN*(oppScore - oppEPA)   (MARGIN=0)
    //   ΔEPA = weight * recency * percent(N) * err / NUM_TEAMS
    const deltas: Array<[number, number]> = [];
    const redErr = redScore - redEPA - MARGIN * (blueScore - blueEPA);
    const blueErr = blueScore - blueEPA - MARGIN * (redScore - redEPA);

    for (const t of reds) {
      const p = percentOf(nByTeam.get(t) as number);
      deltas.push([t, (weight * rec * p * redErr) / NUM_TEAMS]);
    }
    for (const t of blues) {
      const p = percentOf(nByTeam.get(t) as number);
      deltas.push([t, (weight * rec * p * blueErr) / NUM_TEAMS]);
    }

    // Apply all deltas (from the snapshot), then bump N for QUALS only.
    for (const [t, delta] of deltas) {
      epa.set(t, (epa.get(t) as number) + delta);
    }
    if (!elim) {
      for (const t of [...reds, ...blues]) {
        nByTeam.set(t, (nByTeam.get(t) as number) + 1);
      }
    }
  });

  return epa;
}

// ===========================================================================
// Tier 2 — real TBA score_breakdown extraction (component-epa-estimation §3B/§4).
//
// DARK behind a flag, DEFAULT OFF, and scoped to SINGLE-EVENT raw JSON only
// (`fetchEventMatchesCached(eventKey)` objects DO carry `score_breakdown`;
// MatchRow drops it, so the season recurrence can never use this). The exact
// 2026 REBUILT `score_breakdown` field names are UNCONFIRMED in live data, so
// `parseRebuiltBreakdown` is defensive: every key access is finite-guarded and
// any missing/renamed key makes the whole parse return `null` → callers silently
// fall back to the Tier-1 proportional split. It NEVER throws on schema drift.
// ===========================================================================

/**
 * Master flag for Tier-2 real-breakdown extraction. DEFAULT FALSE. Do NOT flip
 * this on until the 2026 REBUILT `score_breakdown` keys are validated against a
 * real played event (plan §4/§11). With it off, `parseRebuiltBreakdown` returns
 * `null` regardless of input so no code path depends on the unconfirmed schema.
 */
export const ENABLE_TBA_BREAKDOWN = false;

/** Per-alliance component scores extracted from a single match's score_breakdown. */
export interface RebuiltBreakdown {
  red: { auto: number; fuelTeleop: number; climb: number };
  blue: { auto: number; fuelTeleop: number; climb: number };
}

/** Inferred 2026 REBUILT key candidates (TBA research; UNCONFIRMED). */
const AUTO_FUEL_KEYS = ['autoFuelPoints', 'autoPoints'];
const TELEOP_FUEL_KEYS = ['teleopFuelPoints', 'teleopPoints'];
const CLIMB_KEYS = ['endgameClimbPoints', 'endgamePoints'];

function firstFiniteKey(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = finiteOrNull(obj[k]);
    if (v != null) return v;
  }
  return null;
}

function parseAlliance(
  raw: unknown,
): { auto: number; fuelTeleop: number; climb: number } | null {
  if (!isObject(raw)) return null;
  const auto = firstFiniteKey(raw, AUTO_FUEL_KEYS);
  const fuelTeleop = firstFiniteKey(raw, TELEOP_FUEL_KEYS);
  const climb = firstFiniteKey(raw, CLIMB_KEYS);
  if (auto == null || fuelTeleop == null || climb == null) return null;
  return { auto, fuelTeleop, climb };
}

/**
 * Read per-alliance auto / teleop-fuel / climb points off ONE raw TBA match's
 * `score_breakdown`. Returns `null` when the flag is off, the input is not a
 * usable object, or ANY expected key is missing/renamed (schema drift) — callers
 * fall back to the Tier-1 split. Pure; never throws. Plan §3B/§4.
 */
export function parseRebuiltBreakdown(rawMatch: unknown): RebuiltBreakdown | null {
  if (!ENABLE_TBA_BREAKDOWN) return null;
  if (!isObject(rawMatch)) return null;
  const sb = rawMatch.score_breakdown;
  if (!isObject(sb)) return null;
  const red = parseAlliance(sb.red);
  const blue = parseAlliance(sb.blue);
  if (!red || !blue) return null;
  return { red, blue };
}
