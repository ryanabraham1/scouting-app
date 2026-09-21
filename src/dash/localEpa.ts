// src/dash/localEpa.ts
// A point-unit "overall EPA" computed from played match results (no-foul scores
// + alliance rosters). This is the dashboard's primary live EPA; Statbotics is
// retained only as a fallback when TBA match results are unavailable.
//
// This ports the SCALAR (overall, index-0) recurrence from the live Statbotics
// source (github.com/avgupta456/statbotics, backend/src/models/epa/*) for modern
// games (>= 2016). It deliberately does NOT replicate the full multi-dimensional
// component model (auto/teleop/endgame/RP + per-year score-breakdown logic + the
// MLE-fit year-normalized distributions), which needs year-wide stats. The
// overall EPA is what we display and what predicts alliance score, so the scalar
// port is the right scope.
//
// Component EPAs (auto / teleop / endgame) run alongside the total as three
// sibling streams of the SAME recurrence, each on its own alliance residual
// read off the TBA `score_breakdown` (`parseRebuiltBreakdown`, 2026 REBUILT keys
// verified live 2026-09-21). Because the recurrence is linear and the three
// component scores sum exactly to the no-foul score, the component streams sum
// to the total stream — the total EPA every screen shows is unchanged by this;
// the split just becomes real per-team data instead of a fitted fraction.
//
// Algorithm (per played match, chronological by match_number):
//   * Init each team's EPA = max(0, mean/NUM_TEAMS - 0.2*sd)  (init.py, no history),
//     mean/sd = mean & population std of this dataset's alliance scores.
//   * Snapshot predicted alliance score = sum of its teams' EPAs (pre-update).
//   * For each team, with N = quals it has played so far (pre-match):
//       percent = (2/3) * clamp(0.5 - (1/30)*(N-6), 0.3, 0.5)   (percent_func)
//       ΔEPA    = weight * percent * (ownScore - ownEPA) / NUM_TEAMS
//     where weight = 1 for quals, 1/3 for playoffs (ELIM_WEIGHT). MARGIN is 0 for
//     modern games, so there is no opponent term. The whole update is scaled by
//     EPA_GAIN (backtested; see constants.ts) — `gain: 1` is the exact port. All six updates use the SAME
//     pre-match snapshot; apply, then increment N for QUAL matches only. Null
//     roster slots are skipped.

import type { MatchRow } from '@/dash/useEventData';
import { EPA_GAIN } from '@/dash/constants';

/**
 * TBA-backed rows retain the official score for display/result consumers while
 * carrying Statbotics' no-foul score separately for the local EPA recurrence.
 * The fields are optional so persisted/schedule-only MatchRows remain compatible.
 */
export interface LocalEpaMatchRow extends MatchRow {
  local_epa_red_score?: number;
  local_epa_blue_score?: number;
  /** Per-alliance component scores off the breakdown (2026); absent when unavailable. */
  local_epa_red_components?: LocalEpaComponents;
  local_epa_blue_components?: LocalEpaComponents;
}

/** Additive point components of an alliance score / a team's EPA. */
export interface LocalEpaComponents {
  /** Autonomous hub fuel (auto tower excluded — that is endgame). */
  auto: number;
  /** Every teleop-period hub point: transition, all four shifts, endgame-period fuel. */
  teleop: number;
  /** Tower points (auto + endgame). */
  endgame: number;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function finiteOrNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** Missing point fields mean zero (as in Statbotics); malformed fields reject the breakdown. */
function optionalPointField(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return value == null ? 0 : finiteOrNull(value);
}

/**
 * Statbotics' modern-game scoring input is the official alliance score less
 * foul and adjustment points awarded to that alliance. A missing/malformed
 * breakdown returns null so callers can preserve the legacy official-score
 * fallback rather than contaminating the model with NaN.
 */
function noFoulScore(
  scoreBreakdown: unknown,
  alliance: 'red' | 'blue',
  officialScore: number,
): number | null {
  if (!isObject(scoreBreakdown) || !isObject(scoreBreakdown[alliance])) return null;
  const allianceBreakdown = scoreBreakdown[alliance];
  const foulPoints = optionalPointField(allianceBreakdown, 'foulPoints');
  const adjustPoints = optionalPointField(allianceBreakdown, 'adjustPoints');
  if (foulPoints == null || adjustPoints == null) return null;
  return officialScore - foulPoints - adjustPoints;
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
export function tbaMatchesToRows(json: unknown): LocalEpaMatchRow[] {
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
    const redEpaScore = played ? noFoulScore(m.score_breakdown, 'red', redScore) : null;
    const blueEpaScore = played ? noFoulScore(m.score_breakdown, 'blue', blueScore) : null;
    const components = played ? parseRebuiltBreakdown(m) : null;

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
        ...(redEpaScore != null ? { local_epa_red_score: redEpaScore } : {}),
        ...(blueEpaScore != null ? { local_epa_blue_score: blueEpaScore } : {}),
        ...(components
          ? { local_epa_red_components: components.red, local_epa_blue_components: components.blue }
          : {}),
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

function scoreForLocalEpa(m: MatchRow, alliance: 'red' | 'blue'): number {
  const local = m as LocalEpaMatchRow;
  const noFoul =
    alliance === 'red' ? local.local_epa_red_score : local.local_epa_blue_score;
  const official = alliance === 'red' ? m.actual_red_score : m.actual_blue_score;
  return finiteOrNull(noFoul) ?? (official as number);
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
  /** Learning-rate multiplier on every update (default EPA_GAIN; 1 = exact Statbotics port). */
  gain?: number;
}

/** EPA immediately after one of the selected team's played matches. */
export interface LocalEpaHistoryPoint {
  matchKey: string;
  eventKey: string;
  compLevel: string;
  matchNumber: number;
  value: number;
}

function runLocalEpa(
  matches: MatchRow[],
  options: LocalEpaOptions,
  historyTeam?: number,
): {
  epa: Map<number, number>;
  components: Map<number, LocalEpaComponents>;
  history: LocalEpaHistoryPoint[];
} {
  const history: LocalEpaHistoryPoint[] = [];
  const recencyBoost = options.recencyBoost ?? 0;
  const gain = options.gain ?? EPA_GAIN;
  const played = matches
    .filter(isPlayed)
    .slice()
    .sort((a, b) => a.match_number - b.match_number);

  const epa = new Map<number, number>();
  const components = new Map<number, LocalEpaComponents>();
  if (played.length === 0) return { epa, components, history };

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
    allianceScores.push(scoreForLocalEpa(m, 'red'), scoreForLocalEpa(m, 'blue'));
  }
  const yearMean = allianceScores.reduce((s, x) => s + x, 0) / allianceScores.length;
  const yearVar =
    allianceScores.reduce((s, x) => s + (x - yearMean) ** 2, 0) / allianceScores.length;
  const yearSd = Math.sqrt(yearVar);
  const init = Math.max(0, yearMean / NUM_TEAMS - INIT_PENALTY * yearSd);

  // Component streams exist when ANY played match carries breakdown components.
  // Each team's components start as `init` split by the dataset's mean component
  // shares (so they sum to `init`, like the total).
  const compMean: LocalEpaComponents = { auto: 0, teleop: 0, endgame: 0 };
  let compRows = 0;
  for (const m of played) {
    const c = componentsOf(m);
    if (!c) continue;
    for (const side of [c.red, c.blue]) {
      compMean.auto += side.auto;
      compMean.teleop += side.teleop;
      compMean.endgame += side.endgame;
      compRows += 1;
    }
  }
  const hasComponents = compRows > 0;
  const initComponents = (): LocalEpaComponents => {
    const total = compMean.auto + compMean.teleop + compMean.endgame;
    if (!(total > 0)) return { auto: 0, teleop: init, endgame: 0 };
    return {
      auto: (init * compMean.auto) / total,
      teleop: (init * compMean.teleop) / total,
      endgame: (init * compMean.endgame) / total,
    };
  };

  const nByTeam = new Map<number, number>();
  const ensure = (team: number): void => {
    if (!epa.has(team)) {
      epa.set(team, init);
      nByTeam.set(team, 0);
      if (hasComponents) components.set(team, initComponents());
    }
  };

  played.forEach((m, i) => {
    const reds = redOf(m).filter((t): t is number => t != null);
    const blues = blueOf(m).filter((t): t is number => t != null);
    for (const t of [...reds, ...blues]) ensure(t);

    const redScore = scoreForLocalEpa(m, 'red');
    const blueScore = scoreForLocalEpa(m, 'blue');
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
      deltas.push([t, (weight * rec * gain * p * redErr) / NUM_TEAMS]);
    }
    for (const t of blues) {
      const p = percentOf(nByTeam.get(t) as number);
      deltas.push([t, (weight * rec * gain * p * blueErr) / NUM_TEAMS]);
    }

    // Component streams: the same recurrence on each component's own alliance
    // residual (pre-match snapshot, like the total). A match without breakdown
    // components apportions the team's TOTAL delta by its current component
    // shares so the components keep summing to the total.
    const compDeltas: Array<[number, LocalEpaComponents]> = [];
    if (hasComponents) {
      const c = componentsOf(m);
      const sumComp = (teams: number[]): LocalEpaComponents =>
        teams.reduce<LocalEpaComponents>(
          (acc, t) => {
            const q = components.get(t) as LocalEpaComponents;
            acc.auto += q.auto;
            acc.teleop += q.teleop;
            acc.endgame += q.endgame;
            return acc;
          },
          { auto: 0, teleop: 0, endgame: 0 },
        );
      const side = (teams: number[], actual: LocalEpaComponents | null, totalErr: number): void => {
        const pred = actual ? sumComp(teams) : null;
        for (const t of teams) {
          const p = percentOf(nByTeam.get(t) as number);
          const k = (weight * rec * gain * p) / NUM_TEAMS;
          if (actual && pred) {
            compDeltas.push([
              t,
              {
                auto: k * (actual.auto - pred.auto),
                teleop: k * (actual.teleop - pred.teleop),
                endgame: k * (actual.endgame - pred.endgame),
              },
            ]);
          } else {
            const q = components.get(t) as LocalEpaComponents;
            const total = q.auto + q.teleop + q.endgame;
            const share = total > 0 ? q : initComponents();
            const shareTotal = share.auto + share.teleop + share.endgame || 1;
            const d = k * totalErr;
            compDeltas.push([
              t,
              {
                auto: (d * share.auto) / shareTotal,
                teleop: (d * share.teleop) / shareTotal,
                endgame: (d * share.endgame) / shareTotal,
              },
            ]);
          }
        }
      };
      side(reds, c?.red ?? null, redErr);
      side(blues, c?.blue ?? null, blueErr);
    }

    // Apply all deltas (from the snapshot), then bump N for QUALS only.
    for (const [t, delta] of deltas) {
      epa.set(t, (epa.get(t) as number) + delta);
    }
    for (const [t, d] of compDeltas) {
      const q = components.get(t) as LocalEpaComponents;
      q.auto += d.auto;
      q.teleop += d.teleop;
      q.endgame += d.endgame;
    }
    if (!elim) {
      for (const t of [...reds, ...blues]) {
        nByTeam.set(t, (nByTeam.get(t) as number) + 1);
      }
    }

    if (historyTeam != null && (reds.includes(historyTeam) || blues.includes(historyTeam))) {
      history.push({
        matchKey: m.match_key,
        eventKey: m.event_key,
        compLevel: m.comp_level,
        matchNumber: m.match_number,
        value: epa.get(historyTeam) as number,
      });
    }
  });

  return { epa, components, history };
}

/** Both alliances' breakdown components for a row, or null when either is missing. */
function componentsOf(m: MatchRow): { red: LocalEpaComponents; blue: LocalEpaComponents } | null {
  const local = m as LocalEpaMatchRow;
  const red = local.local_epa_red_components;
  const blue = local.local_epa_blue_components;
  return red && blue ? { red, blue } : null;
}

/**
 * Compute a local EPA (total points) per team from played matches.
 * Returns an empty map when there are no played matches.
 */
export function computeLocalEpa(
  matches: MatchRow[],
  options: LocalEpaOptions = {},
): Map<number, number> {
  return runLocalEpa(matches, options).epa;
}

/**
 * Replay the same model once and capture the selected team's EPA after every
 * match it played. The final point is guaranteed to equal computeLocalEpa for
 * the same full match set and options.
 */
export function computeLocalEpaHistory(
  matches: MatchRow[],
  team: number,
  options: LocalEpaOptions = {},
): LocalEpaHistoryPoint[] {
  return runLocalEpa(matches, options, team).history;
}

/**
 * Component EPAs (auto / teleop / endgame) per team from the same replay as
 * {@link computeLocalEpa}; for every team `auto + teleop + endgame` equals its
 * total EPA (up to floating point). Empty when no played match carries
 * breakdown components (pre-2026 data or a breakdown-less feed).
 */
export function computeLocalEpaComponents(
  matches: MatchRow[],
  options: LocalEpaOptions = {},
): Map<number, LocalEpaComponents> {
  return runLocalEpa(matches, options).components;
}

// ===========================================================================
// TBA `score_breakdown` → per-alliance components (2026 REBUILT).
//
// Field names verified against live TBA data (2026casnv_qm1 via tba-proxy,
// 2026-09-21) and checked on all 36,582 alliance results of the 2026 season:
//   auto    = totalAutoPoints   - autoTowerPoints     (== hubScore.autoPoints)
//   teleop  = totalTeleopPoints - endGameTowerPoints  (== hubScore.teleopPoints)
//   endgame = totalTowerPoints
// and auto + teleop + endgame == totalPoints - foulPoints - adjustPoints on every
// one of them, which is what lets the component EPA streams sum to the total.
// Defensive: any missing/malformed key makes the whole parse return `null`
// (callers keep the total-only model). Never throws on schema drift.
// ===========================================================================

/** Per-alliance component scores extracted from a single match's score_breakdown. */
export interface RebuiltBreakdown {
  red: LocalEpaComponents;
  blue: LocalEpaComponents;
}

function parseAlliance(raw: unknown): LocalEpaComponents | null {
  if (!isObject(raw)) return null;
  const totalAuto = finiteOrNull(raw.totalAutoPoints);
  const totalTeleop = finiteOrNull(raw.totalTeleopPoints);
  const totalTower = finiteOrNull(raw.totalTowerPoints);
  if (totalAuto == null || totalTeleop == null || totalTower == null) return null;
  // Tower fields are 0 when absent (a match with no tower play) — same
  // missing-means-zero rule as foul/adjust points above.
  const autoTower = optionalPointField(raw, 'autoTowerPoints');
  const endgameTower = optionalPointField(raw, 'endGameTowerPoints');
  if (autoTower == null || endgameTower == null) return null;
  return {
    auto: totalAuto - autoTower,
    teleop: totalTeleop - endgameTower,
    endgame: totalTower,
  };
}

/**
 * Read per-alliance auto / teleop / endgame points off ONE raw TBA match's
 * `score_breakdown`. Returns `null` when the input is not a usable object or
 * ANY expected key is missing/renamed (schema drift). Pure; never throws.
 */
export function parseRebuiltBreakdown(rawMatch: unknown): RebuiltBreakdown | null {
  if (!isObject(rawMatch)) return null;
  const sb = rawMatch.score_breakdown;
  if (!isObject(sb)) return null;
  const red = parseAlliance(sb.red);
  const blue = parseAlliance(sb.blue);
  if (!red || !blue) return null;
  return { red, blue };
}
