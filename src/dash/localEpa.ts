// src/dash/localEpa.ts
// A point-unit "overall EPA" computed from played match results (actual scores +
// alliance rosters). Used as a fallback when Statbotics is offline so the
// next-match prediction and Total-EPA tile still have a baseline.
//
// This ports the SCALAR (overall, index-0) recurrence from the live Statbotics
// source (github.com/avgupta456/statbotics, backend/src/models/epa/*) for modern
// games (>= 2016). It deliberately does NOT replicate the full multi-dimensional
// component model (auto/teleop/endgame/RP + per-year score-breakdown logic + the
// MLE-fit year-normalized distributions), which needs year-wide stats and TBA
// score breakdowns that aren't available client-side. The overall EPA is what we
// display and what predicts alliance score, so the scalar port is the right scope.
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

/**
 * Compute a local EPA (total points) per team from played matches.
 * Returns an empty map when there are no played matches.
 */
export function computeLocalEpa(matches: MatchRow[]): Map<number, number> {
  const played = matches
    .filter(isPlayed)
    .slice()
    .sort((a, b) => a.match_number - b.match_number);

  const epa = new Map<number, number>();
  if (played.length === 0) return epa;

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

  for (const m of played) {
    const reds = redOf(m).filter((t): t is number => t != null);
    const blues = blueOf(m).filter((t): t is number => t != null);
    for (const t of [...reds, ...blues]) ensure(t);

    const redScore = m.actual_red_score as number;
    const blueScore = m.actual_blue_score as number;
    const elim = m.comp_level !== 'qm';
    const weight = elim ? ELIM_WEIGHT : 1;

    // Pre-match snapshot of predicted alliance scores (sum of team EPAs), used
    // for ALL six updates so they don't see each other within the match.
    const redEPA = reds.reduce((s, t) => s + (epa.get(t) as number), 0);
    const blueEPA = blues.reduce((s, t) => s + (epa.get(t) as number), 0);

    // Per-team Δ, ported from main.py (attribute_match + math.py add_obs, MARGIN=0):
    //   err  = (ownScore - ownEPA) - MARGIN*(oppScore - oppEPA)   (MARGIN=0)
    //   ΔEPA = weight * percent(N) * err / NUM_TEAMS
    const deltas: Array<[number, number]> = [];
    const redErr = redScore - redEPA - MARGIN * (blueScore - blueEPA);
    const blueErr = blueScore - blueEPA - MARGIN * (redScore - redEPA);

    for (const t of reds) {
      const p = percentOf(nByTeam.get(t) as number);
      deltas.push([t, (weight * p * redErr) / NUM_TEAMS]);
    }
    for (const t of blues) {
      const p = percentOf(nByTeam.get(t) as number);
      deltas.push([t, (weight * p * blueErr) / NUM_TEAMS]);
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
  }

  return epa;
}
