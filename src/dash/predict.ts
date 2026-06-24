// src/dash/predict.ts
// Pure confidence-weighted next-match prediction (contracts §3).
// Blends OUR scouting expectation with Statbotics EPA, degrading gracefully
// when Statbotics is down or a team is unknown. Never throws on missing data.

import { CONFIDENCE_N, WINPROB_K } from './constants';
import type { TeamAgg } from './aggregate';

export interface TeamPrediction {
  teamNumber: number;
  expected: number;
  w: number;
  source: 'blend' | 'scouting' | 'epa' | 'none';
}

export interface MatchPrediction {
  red: { teams: TeamPrediction[]; score: number };
  blue: { teams: TeamPrediction[]; score: number };
  /** logistic(WINPROB_K * (redScore - blueScore)), 0..1 */
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

export function predictMatch(input: PredictInput): MatchPrediction {
  const { redTeams, blueTeams, agg, epaByTeam, statboticsAvailable } = input;

  const redPreds = redTeams.map((t) => predictTeam(t, agg, epaByTeam, statboticsAvailable));
  const bluePreds = blueTeams.map((t) => predictTeam(t, agg, epaByTeam, statboticsAvailable));

  const redScore = redPreds.reduce((s, p) => s + p.expected, 0);
  const blueScore = bluePreds.reduce((s, p) => s + p.expected, 0);

  const redWinProb = 1 / (1 + Math.exp(-WINPROB_K * (redScore - blueScore)));

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
