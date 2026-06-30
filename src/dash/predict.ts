// src/dash/predict.ts
// Pure confidence-weighted next-match prediction (contracts §3).
// Blends OUR scouting expectation with Statbotics EPA, degrading gracefully
// when Statbotics is down or a team is unknown. Never throws on missing data.

import {
  CONFIDENCE_N,
  WINPROB_SIGMA_FRACTION,
  WINPROB_SIGMA_FLOOR,
  WINPROB_LOGIT_SCALE,
  MIN_EPA_MATCHES,
  APPLY_DEFENSE_TO_PREDICTION,
} from './constants';
import type { TeamAgg, ComponentFraction } from './aggregate';
import {
  aggregateTeamComponentSplit,
  aggregateTeamDefensePts,
  F_DEFAULT,
} from './aggregate';

/**
 * Presentational decomposition of a team's blended `expected` into additive
 * auto / teleop-fuel / climb points, plus a scouting-only defense figure. NOT a
 * new prediction so it can never disagree with the score the dashboard shows.
 *
 * `climb` comes ONLY from real scouting — we never invent it from a fitted
 * fraction (most teams climb ~0, so a fabricated ~30% climb is misleading):
 *  - SCOUTED branch: `climb` is the team's real (k-rescaled) scouted climb, and
 *    `auto + fuel + climb === expected` (unrounded; plan §8).
 *  - EPA (unscouted) branch: `climb` is `null` (renders "—"); `auto + fuel`
 *    carry the full `expected` (climb is folded into the fuel/auto estimate).
 *  - NONE branch: all zero, `climb` null.
 *
 * `defense` is the points this team removes from the OPPOSING alliance (a
 * subtraction, NOT added to its own components); `null` when unscouted. §6/§7.
 */
export interface ComponentBreakdown {
  auto: number;
  fuel: number;
  /** Real scouted climb points; `null`/`—` for unscouted teams (never fabricated). */
  climb: number | null;
  /** Points removed from the OPPOSING alliance (>=0); null/`—` when unknown. */
  defense: number | null;
  source: 'scouting' | 'epa' | 'none';
  /** True when surfaced from a low-sample event-wide estimate (EPA branch). */
  provisional: boolean;
}

export interface TeamPrediction {
  teamNumber: number;
  expected: number;
  w: number;
  source: 'blend' | 'scouting' | 'epa' | 'none';
  /**
   * OPTIONAL additive auto/fuel/climb decomposition of `expected` (+ scouting
   * defense). Present only when `predictMatch` is given a `fraction`; absent
   * means byte-identical legacy behavior. Sums to `expected` on unrounded floats.
   */
  components?: ComponentBreakdown;
}

export interface MatchPrediction {
  red: { teams: TeamPrediction[]; score: number };
  blue: { teams: TeamPrediction[]; score: number };
  /** logistic(WINPROB_LOGIT_SCALE * (redScore - blueScore) / sigma), 0..1 */
  redWinProb: number;
  /** 0..1: mean team w, knocked down when Statbotics unavailable */
  confidence: number;
}

export interface PredictInput {
  redTeams: number[];
  blueTeams: number[];
  agg: Map<number, TeamAgg>;
  /** Statbotics EPA per team (null = unknown) */
  epaByTeam: Map<number, number | null>;
  statboticsAvailable: boolean;
  /**
   * OPTIONAL fitted component fraction (from `fitComponentFraction`) for the
   * no-scouting (EPA) split branch. When provided, each `TeamPrediction` gets a
   * `components` breakdown attached. When omitted, behavior is byte-identical to
   * before (no `components`, scores unchanged). Plan §8.
   */
  fraction?: ComponentFraction;
  /**
   * OPTIONAL count of played matches at the event — gates the EPA-source split
   * (an unscouted team gets `none`/`—` below `MIN_EPA_MATCHES`). Defaults to a
   * value high enough to surface estimates when a `fraction` is supplied.
   */
  playedMatches?: number;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function predictTeam(
  teamNumber: number,
  agg: Map<number, TeamAgg>,
  epaByTeam: Map<number, number | null>,
  statboticsAvailable: boolean,
): TeamPrediction {
  const teamAgg = agg.get(teamNumber);
  const scouting = teamAgg?.scoutingExpectedPoints;
  const m = teamAgg?.matchesScouted ?? 0;
  // Statbotics down -> EPA treated as null everywhere.
  const epa = statboticsAvailable ? epaByTeam.get(teamNumber) ?? null : null;

  const hasScouting = scouting !== undefined && m > 0;
  const hasEpa = epa !== null;

  if (hasScouting && hasEpa) {
    const w = Math.min(1, m / CONFIDENCE_N);
    return {
      teamNumber,
      expected: w * scouting + (1 - w) * epa,
      w,
      source: 'blend',
    };
  }
  if (hasScouting) {
    // scouting only (no usable EPA)
    return { teamNumber, expected: scouting, w: 1, source: 'scouting' };
  }
  if (hasEpa) {
    // EPA only (unscouted team, m=0)
    return { teamNumber, expected: epa, w: 0, source: 'epa' };
  }
  // neither
  return { teamNumber, expected: 0, w: 0, source: 'none' };
}

/**
 * Coerce `epaByTeam` to a real Map. A persisted React Query cache from before
 * Map serialization was handled can rehydrate this as a plain object (or even
 * `{}`), which lacks `.get`. Tolerate that rather than throwing.
 */
function asEpaMap(epaByTeam: PredictInput['epaByTeam']): Map<number, number | null> {
  if (epaByTeam instanceof Map) return epaByTeam;
  const m = new Map<number, number | null>();
  if (epaByTeam && typeof epaByTeam === 'object') {
    for (const [k, v] of Object.entries(epaByTeam as Record<string, number | null>)) {
      const team = Number(k);
      if (Number.isFinite(team)) m.set(team, v);
    }
  }
  return m;
}

/**
 * Decompose a team's blended `expected` into additive auto/fuel (+ a real
 * scouted climb and a scouting-only defense figure). PURE. Never throws; never
 * mutates inputs. Plan §6/§7.
 *
 * CLIMB HONESTY: climb is surfaced ONLY from real scouting. We never invent it
 * from the fitted `fraction` — most teams climb ~0, so a fabricated ~30% climb
 * (the old `f.fClimb * expected`) is misleading.
 *
 * Branches:
 *  - SCOUTING (this team has reports): split from its own means, rescaled to
 *    `expected`. Invariant: `auto + fuel + climb === expected` (unrounded).
 *  - EPA (unscouted): `climb = null` ("—"); `auto + fuel` carry the FULL
 *    `expected` (the auto/fuel fraction re-normalized to drop climb), so the
 *    alliance score is still fully decomposed without inventing climb.
 *  - NONE: all zero, climb null.
 *
 * Defense is orthogonal and never enters the auto/fuel/climb sum.
 */
export function resolveComponentBreakdown(
  _teamNumber: number,
  agg: TeamAgg | undefined,
  expected: number,
  fraction: ComponentFraction,
  predictionSource: TeamPrediction['source'],
  playedMatches: number,
): ComponentBreakdown {
  const f = fraction ?? F_DEFAULT;

  // 1. SCOUTING: split from this team's own means, rescaled to `expected`. Climb
  // is REAL here (the k-rescaled scouted climb — near 0 for non-climbers).
  if (agg && agg.matchesScouted > 0) {
    const split = aggregateTeamComponentSplit(agg);
    const s = split.auto + split.fuel + split.climb;
    let auto: number;
    let fuel: number;
    let climb: number;
    if (s > 0 && expected > 0) {
      const k = expected / s;
      auto = split.auto * k;
      fuel = split.fuel * k;
      climb = split.climb * k;
    } else {
      // Degenerate scouted split (all-zero) or non-positive expected: route the
      // whole estimate through auto/fuel (no fabricated climb), preserving the
      // auto:fuel ratio of the fitted fraction so the sum invariant still holds.
      const base = Math.max(0, expected);
      const af = f.fAuto + f.fFuel;
      auto = af > 0 ? (f.fAuto / af) * base : 0;
      fuel = af > 0 ? (f.fFuel / af) * base : base;
      climb = 0;
    }
    return {
      auto,
      fuel,
      climb,
      defense: aggregateTeamDefensePts(agg),
      source: 'scouting',
      provisional: false,
    };
  }

  // 2. EPA (unscouted): we have NO climb signal, so climb is null ("—"). Split
  // the full `expected` across auto/fuel only, re-normalizing the fitted
  // auto:fuel ratio so the alliance score is still fully decomposed — but we
  // never invent a climb number from `f.fClimb`.
  if (
    predictionSource !== 'none' &&
    expected > 0 &&
    playedMatches >= MIN_EPA_MATCHES
  ) {
    const af = f.fAuto + f.fFuel;
    return {
      auto: af > 0 ? (f.fAuto / af) * expected : 0,
      fuel: af > 0 ? (f.fFuel / af) * expected : expected,
      climb: null,
      defense: null,
      source: 'epa',
      provisional: true,
    };
  }

  // 3. NONE: nothing to surface.
  return { auto: 0, fuel: 0, climb: null, defense: null, source: 'none', provisional: false };
}

export function predictMatch(input: PredictInput): MatchPrediction {
  const { redTeams, blueTeams, agg, statboticsAvailable } = input;
  const epaByTeam = asEpaMap(input.epaByTeam);

  const redPreds = redTeams.map((t) => predictTeam(t, agg, epaByTeam, statboticsAvailable));
  const bluePreds = blueTeams.map((t) => predictTeam(t, agg, epaByTeam, statboticsAvailable));

  // Optional component decomposition — attached only when a `fraction` is given,
  // so omitting it keeps the output byte-identical to legacy callers (plan §8).
  if (input.fraction) {
    const fraction = input.fraction;
    // When a fraction is supplied we surface estimates; default playedMatches high
    // enough to clear MIN_EPA_MATCHES unless the caller passes a real (lower) count.
    const played = input.playedMatches ?? MIN_EPA_MATCHES;
    const attach = (p: TeamPrediction): void => {
      p.components = resolveComponentBreakdown(
        p.teamNumber,
        agg.get(p.teamNumber),
        p.expected,
        fraction,
        p.source,
        played,
      );
    };
    redPreds.forEach(attach);
    bluePreds.forEach(attach);
  }

  let redScore = redPreds.reduce((s, p) => s + p.expected, 0);
  let blueScore = bluePreds.reduce((s, p) => s + p.expected, 0);

  // Conservative, OPT-IN defense application (plan §8). DEFAULT OFF, so the
  // visible prediction math is unchanged on first ship — components are a pure
  // additive decomposition of the totals above. When (someday) enabled, each
  // alliance's scouted member-defense subtracts from the OPPOSING score. Because
  // v1 defense is scouting-only, this would only ever move events with scouted
  // defense data. Left here as the validated-follow-up seam.
  if (APPLY_DEFENSE_TO_PREDICTION) {
    const sumDef = (preds: TeamPrediction[]): number =>
      preds.reduce((s, p) => s + (p.components?.defense ?? 0), 0);
    const redDef = sumDef(redPreds);
    const blueDef = sumDef(bluePreds);
    redScore = Math.max(0, redScore - blueDef);
    blueScore = Math.max(0, blueScore - redDef);
  }

  // Scale the margin by an estimated match-margin SD that grows with the total
  // predicted score, so a given point edge means less in a high-scoring game.
  const sigma = Math.max(WINPROB_SIGMA_FLOOR, WINPROB_SIGMA_FRACTION * (redScore + blueScore));
  const z = (WINPROB_LOGIT_SCALE * (redScore - blueScore)) / sigma;
  const redWinProb = 1 / (1 + Math.exp(-z));

  const allPreds = [...redPreds, ...bluePreds];
  const meanW =
    allPreds.length === 0
      ? 0
      : allPreds.reduce((s, p) => s + p.w, 0) / allPreds.length;
  const confidence = clamp01(meanW * (statboticsAvailable ? 1 : 0.85));

  return {
    red: { teams: redPreds, score: redScore },
    blue: { teams: bluePreds, score: blueScore },
    redWinProb,
    confidence,
  };
}
