import { describe, expect, it } from 'vitest';
import {
  BAYES_EPA_PARAMS,
  BayesEpaModel,
  bayesWinProb,
  fitCalibration,
  normCdf,
  type BayesMatch,
} from '@/dash/bayesEpa';
import { bayesMatchesFromRows, bayesTeamSeason, seasonScaleFromRows } from '@/dash/bayesEpaRows';
import { predictMatch } from '@/dash/predict';
import type { MatchRow } from '@/dash/useEventData';

const scale = { mean: 60, sd: 20 };

function match(red: number[], blue: number[], rs: number, bs: number, i = 0, ev = 'e1'): BayesMatch {
  return {
    eventKey: ev,
    elim: false,
    time: 1_700_000_000 + i * 600,
    red,
    blue,
    redScore: rs,
    blueScore: bs,
    result: rs > bs ? 1 : bs > rs ? 0 : 0.5,
  };
}

function row(i: number, red: number[], blue: number[], rs: number, bs: number): MatchRow {
  return {
    match_key: `2026x_qm${i}`,
    event_key: '2026x',
    comp_level: 'qm',
    match_number: i,
    scheduled_time: null,
    red1: red[0],
    red2: red[1],
    red3: red[2],
    blue1: blue[0],
    blue2: blue[1],
    blue3: blue[2],
    actual_red_score: rs,
    actual_blue_score: bs,
    winner: rs > bs ? 'red' : bs > rs ? 'blue' : '',
    result_synced_at: null,
  } as MatchRow;
}

describe('normCdf', () => {
  it('matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1)).toBeCloseTo(0.1587, 3);
  });
});

describe('BayesEpaModel', () => {
  it('gives an even match between identical unknown teams 50%', () => {
    const m = new BayesEpaModel(scale);
    expect(m.predict(match([1, 2, 3], [4, 5, 6], 0, 0)).redWinProb).toBeCloseTo(0.5, 9);
  });

  it('starts teams from their carried-over strength', () => {
    const m = new BayesEpaModel(scale, new Map([[1, [2, 2, 2] as const], [4, [-1, -1, -1] as const]]));
    expect(m.team(1).mean).toBeGreaterThan(m.team(2).mean);
    expect(m.team(4).mean).toBeLessThan(m.team(1).mean);
    expect(m.team(1).variance).toBeLessThan(m.team(2).variance); // veterans are better known
    expect(m.predict(match([1, 2, 3], [4, 5, 6], 0, 0)).redWinProb).toBeGreaterThan(0.6);
  });

  it('learns from results and shrinks uncertainty', () => {
    const m = new BayesEpaModel(scale);
    const v0 = m.team(1).variance;
    for (let i = 0; i < 6; i++) {
      const x = match([1, 2 + i * 2, 3 + i * 2], [20 + i, 30 + i, 40 + i], 120, 40, i);
      m.predict(x);
      m.update(x);
    }
    expect(m.team(1).mean).toBeGreaterThan(m.team(30).mean);
    expect(m.team(1).variance).toBeLessThan(v0);
  });

  it('shares credit with a partner later revealed to be strong (full covariance)', () => {
    // Teams 1 and 2 win together; later team 2 keeps winning without 1.
    const m = new BayesEpaModel(scale);
    const first = match([1, 2, 3], [4, 5, 6], 140, 40, 0);
    m.predict(first);
    m.update(first);
    const after1 = m.team(1).mean;
    for (let i = 1; i < 6; i++) {
      const x = match([2, 10 + i, 20 + i], [30 + i, 40 + i, 50 + i], 140, 40, i);
      m.predict(x);
      m.update(x);
    }
    // Team 1 never played again, yet its rating fell as team 2 absorbed the credit.
    expect(m.team(1).mean).toBeLessThan(after1);
    expect(m.team(2).mean).toBeGreaterThan(m.team(1).mean);
  });

  it('is symmetric in red/blue', () => {
    const a = new BayesEpaModel(scale);
    const b = new BayesEpaModel(scale);
    const pa = a.predict(match([1, 2, 3], [4, 5, 6], 0, 0)).redWinProb;
    const pb = b.predict(match([4, 5, 6], [1, 2, 3], 0, 0)).redWinProb;
    expect(pa + pb).toBeCloseTo(1, 9);
  });

  it('agrees with bayesWinProb on fresh teams (no cross-covariance yet)', () => {
    const priors = new Map([[1, [1.5, 1, 0.5] as const]]);
    const m = new BayesEpaModel(scale, priors);
    const p = m.predict(match([1, 2, 3], [4, 5, 6], 0, 0)).redWinProb;
    const t = (n: number) => m.team(n);
    const q = bayesWinProb([t(1), t(2), t(3)], [t(4), t(5), t(6)], scale, m.c).redWinProb;
    expect(q).toBeCloseTo(p, 9);
  });

  it('standardizes season strength for the next season', () => {
    const m = new BayesEpaModel(scale);
    const x = match([1, 2, 3], [4, 5, 6], 100, 20);
    m.predict(x);
    m.update(x);
    const z = m.seasonZ();
    const vals = [...z.values()];
    expect(vals.reduce((s, v) => s + v, 0)).toBeCloseTo(0, 9);
    expect((z.get(1) as number) > (z.get(4) as number)).toBe(true);
  });
});

describe('fitCalibration', () => {
  it('recovers the probit slope from data and shrinks toward the prior when data is thin', () => {
    // Deterministic synthetic set: outcomes drawn at exactly Phi(1.6 z) frequencies.
    const zs: number[] = [];
    const ys: number[] = [];
    for (let k = -30; k <= 30; k++) {
      const z = k / 15;
      const p = normCdf(1.6 * z);
      for (let j = 0; j < 100; j++) {
        zs.push(z);
        ys.push(j < Math.round(100 * p) ? 1 : 0);
      }
    }
    expect(fitCalibration(zs, ys, 1.25, 100)).toBeCloseTo(1.6, 1);
    expect(fitCalibration(zs.slice(0, 3), ys.slice(0, 3), 1.25, 100)).toBeCloseTo(1.25, 1);
  });
});

describe('bayesEpaRows', () => {
  const rows = [
    row(1, [1, 2, 3], [4, 5, 6], 80, 40),
    row(2, [1, 7, 8], [9, 10, 11], 90, 50),
    row(3, [2, 4, 9], [3, 5, 10], 60, 60),
    { ...row(4, [1, 2, 3], [4, 5, 6], 0, 0), actual_red_score: null, actual_blue_score: null } as MatchRow,
  ];

  it('keeps only played 3v3 matches and reads results', () => {
    const ms = bayesMatchesFromRows(rows);
    expect(ms).toHaveLength(3);
    expect(ms.map((m) => m.result)).toEqual([1, 1, 0.5]);
  });

  it('computes the season scale from played rows', () => {
    const s = seasonScaleFromRows(rows);
    expect(s.mean).toBeCloseTo((80 + 40 + 90 + 50 + 60 + 60) / 6, 9);
    expect(s.sd).toBeGreaterThan(0);
  });

  it('replays one team and returns its posterior and history', () => {
    const r = bayesTeamSeason(rows, 1, new Map(), true);
    expect(r).not.toBeNull();
    expect(r?.history.map((h) => h.matchNumber)).toEqual([1, 2]);
    expect(r?.history.at(-1)?.value).toBeCloseTo(r?.mean as number, 9);
    expect(r?.variance).toBeGreaterThan(0);
    expect(bayesTeamSeason(rows, 999, new Map())).toBeNull();
  });
});

describe('predictMatch with Bayesian uncertainty', () => {
  const epaByTeam = new Map([1, 2, 3, 4, 5, 6].map((t) => [t, t <= 3 ? 30 : 20] as [number, number]));
  const base = {
    redTeams: [1, 2, 3],
    blueTeams: [4, 5, 6],
    agg: new Map(),
    epaByTeam,
    statboticsAvailable: true,
  };
  const cal = { c: BAYES_EPA_PARAMS.c, mean: 75, sd: 25 };

  it('uses the Bayesian win prob when all six teams have a variance', () => {
    const varianceByTeam = new Map([1, 2, 3, 4, 5, 6].map((t) => [t, 40] as [number, number]));
    const pred = predictMatch({ ...base, bayes: { varianceByTeam, bayesCal: cal } });
    const expected = bayesWinProb(
      [1, 2, 3].map(() => ({ mean: 30, variance: 40 })),
      [4, 5, 6].map(() => ({ mean: 20, variance: 40 })),
      cal,
      cal.c,
    ).redWinProb;
    expect(pred.redWinProb).toBeCloseTo(expected, 12);
    expect(pred.red.score).toBe(90);
  });

  it('falls back to the legacy formula when any team lacks a variance', () => {
    const varianceByTeam = new Map<number, number | null>([[1, 40], [2, 40], [3, 40], [4, 40], [5, 40], [6, null]]);
    const legacy = predictMatch(base).redWinProb;
    expect(predictMatch({ ...base, bayes: { varianceByTeam, bayesCal: cal } }).redWinProb).toBe(legacy);
    expect(predictMatch({ ...base, bayes: { varianceByTeam, bayesCal: null } }).redWinProb).toBe(legacy);
  });
});
