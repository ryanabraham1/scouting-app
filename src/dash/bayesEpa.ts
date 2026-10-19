// src/dash/bayesEpa.ts
//
// Bayesian EPA: the dashboard's primary team-strength / win-probability model.
//
// Backtested on every 2016-2026 official match (151k matches, strictly
// pre-match, parameters tuned on 2016-2022 only). On the 2023-2026 holdout it
// calls 78.9% of winners (Statbotics EPA 77.9%, match13 78.6% per its published
// benchmark), 76.5% in each team's first two matches of an event, Brier 0.145
// (Statbotics 0.157), calibration gap ~1 pt (Statbotics ~7). Research harness:
// docs/plans/2026-10-18-bayes-epa.md.
//
// Model (units: no-foul alliance points):
//  * Each team has a Gaussian strength N(mu, var). An alliance's no-foul score
//    is the sum of its three teams' strengths plus noise R; red and blue noise
//    are correlated (rho) because both alliances share the field.
//  * Within an EVENT the posterior over every team at that event is kept with
//    its FULL covariance (exact Bayesian linear regression = ridge OPR with a
//    prior, solved recursively), so evidence about a partner flows back into a
//    team's rating. Between events a team's marginal carries forward with
//    extra process noise (q_event, plus q_day per idle day).
//  * Season start: prior mean from the team's last three seasons' standardized
//    end-of-season strength (shipped as a static priors file, see
//    epaPriors/), mean-reverted toward a rookie-level prior.
//  * Win prob = Phi(c * margin / sd), with the margin SD from the teams'
//    variances + match noise, and c re-fitted in-season on the matches already
//    played (game predictability differs a lot by year: c ~1.0 in 2017, ~1.7
//    in 2026).
//
// Performance: one match = two rank-1 updates of an n x n Float64Array (n =
// teams seen at that event, ~40-80), i.e. a few microseconds. No allocation in
// the hot loop.

/** Tuned parameters. Variances are fractions of the season alliance-score variance. */
export interface BayesEpaParams {
  /** Alliance-score observation noise var / sd^2. */
  R: number;
  /** Process noise per match played / sd^2. */
  q: number;
  /** Extra process noise when a team starts a new event / sd^2. */
  qEvent: number;
  /** Process noise per idle day (capped at 60 days) / sd^2. */
  qDay: number;
  /** Prior var for a team with history / sd^2. */
  p0Vet: number;
  /** Prior var for a team with no history / sd^2. */
  p0New: number;
  /** Mean reversion of the carried-over z toward `newZ`. */
  revert: number;
  /** Weight on last season vs. two seasons ago. */
  y1w: number;
  /** Weight on three seasons ago (taken from the y1/y2 mix). */
  y3w: number;
  /** Prior z for a team with no history (rookies are weak on average). */
  newZ: number;
  /** Alliance-score SDs per unit of carried-over z. */
  zScale: number;
  /** Prior win-prob sharpness (in-season fit shrinks toward this). */
  c: number;
  /** R multiplier in playoffs. */
  elimR: number;
  /** R scales with (predicted alliance score / season mean)^het. */
  het: number;
  /** Correlation of red/blue score noise within a match. */
  rho: number;
  /** In-season calibration prior strength (pseudo-matches); 0 disables the refit. */
  calN: number;
}

export const BAYES_EPA_PARAMS: BayesEpaParams = {
  R: 0.65625,
  q: 0.00025,
  qEvent: 0.01125,
  qDay: 0.00075,
  p0Vet: 0.1021875,
  p0New: 0.124375,
  revert: 0.45625,
  y1w: 0.875,
  y3w: 0.21875,
  newZ: -1.79375,
  zScale: 0.525,
  c: 1.25,
  elimR: 0.84375,
  het: 0.5625,
  rho: 0.225,
  calN: 100,
};

/** Standardized end-of-season strength for the last three seasons (null = did not play). */
export type PriorZ = readonly [number | null, number | null, number | null];

/** A played match in the model's neutral shape. */
export interface BayesMatch {
  eventKey: string;
  elim: boolean;
  /** Seconds since epoch (0 when unknown; only used for idle-day process noise). */
  time: number;
  red: readonly number[];
  blue: readonly number[];
  /** No-foul alliance scores. */
  redScore: number;
  blueScore: number;
  /** 1 red won, 0 blue won, 0.5 tie (used only for the in-season calibration fit). */
  result: number;
}

export interface BayesPrediction {
  redMean: number;
  blueMean: number;
  /** Variance of (red - blue) score margin. */
  marginVar: number;
  redWinProb: number;
}

export interface SeasonScale {
  /** Mean no-foul alliance score. */
  mean: number;
  /** SD of alliance scores. */
  sd: number;
}

class EventState {
  idx = new Map<number, number>();
  n = 0;
  cap: number;
  mu: Float64Array;
  P: Float64Array; // row-major cap x cap

  constructor(cap = 64) {
    this.cap = cap;
    this.mu = new Float64Array(cap);
    this.P = new Float64Array(cap * cap);
  }

  add(team: number, mean: number, variance: number): number {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    this.idx.set(team, i);
    this.mu[i] = mean;
    const c = this.cap;
    for (let j = 0; j < this.n; j++) {
      this.P[i * c + j] = 0;
      this.P[j * c + i] = 0;
    }
    this.P[i * c + i] = variance;
    return i;
  }

  reset(i: number, mean: number, variance: number): void {
    const c = this.cap;
    this.mu[i] = mean;
    for (let j = 0; j < this.n; j++) {
      this.P[i * c + j] = 0;
      this.P[j * c + i] = 0;
    }
    this.P[i * c + i] = variance;
  }

  private grow(): void {
    const old = this.cap;
    const cap = old * 2;
    const mu = new Float64Array(cap);
    mu.set(this.mu);
    const P = new Float64Array(cap * cap);
    for (let i = 0; i < this.n; i++) P.set(this.P.subarray(i * old, i * old + this.n), i * cap);
    this.cap = cap;
    this.mu = mu;
    this.P = P;
  }
}

// Standard normal CDF: Hart (1968) double-precision algorithm as given by
// G. West, "Better approximations to cumulative normal functions" (2005).
// Accurate to ~1e-15 and exactly symmetric, so normCdf(0) === 0.5.
export function normCdf(z: number): number {
  const x = Math.abs(z);
  let tail: number;
  if (x > 37) {
    tail = 0;
  } else {
    const e = Math.exp(-x * x / 2);
    if (x < 7.07106781186547) {
      let n = 3.52624965998911e-2 * x + 0.700383064443688;
      n = n * x + 6.37396220353165;
      n = n * x + 33.912866078383;
      n = n * x + 112.079291497871;
      n = n * x + 221.213596169931;
      n = n * x + 220.206867912376;
      let d = 8.83883476483184e-2 * x + 1.75566716318264;
      d = d * x + 16.064177579207;
      d = d * x + 86.7807322029461;
      d = d * x + 296.564248779674;
      d = d * x + 637.333633378831;
      d = d * x + 793.826512519948;
      d = d * x + 440.413735824752;
      tail = (e * n) / d;
    } else {
      let d = x + 0.65;
      d = x + 4 / d;
      d = x + 3 / d;
      d = x + 2 / d;
      d = x + 1 / d;
      tail = e / d / 2.506628274631;
    }
  }
  return z > 0 ? 1 - tail : tail;
}
function normPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * MAP fit of the probit slope c on (z, outcome) pairs, shrunk toward `c0` with
 * strength `calN` pseudo-matches. Ties are skipped. Newton steps, clamped.
 */
export function fitCalibration(
  zs: ArrayLike<number>,
  outcomes: ArrayLike<number>,
  c0: number,
  calN: number,
  start = c0,
): number {
  const lam = calN * 0.16;
  let c = start;
  for (let it = 0; it < 20; it++) {
    let g = -lam * (c - c0);
    let h = -lam;
    for (let i = 0; i < zs.length; i++) {
      const y = outcomes[i];
      if (y === 0.5) continue;
      const z = zs[i];
      const p = Math.min(1 - 1e-9, Math.max(1e-9, normCdf(c * z)));
      const phi = normPdf(c * z);
      const w = p * (1 - p);
      g += ((y - p) * phi * z) / w;
      h -= (phi * phi * z * z) / w;
    }
    const step = g / h;
    c -= step;
    if (Math.abs(step) < 1e-5) break;
  }
  return Math.min(3, Math.max(0.5, c));
}

/** One season of the Bayesian EPA model. Feed matches in chronological order. */
export class BayesEpaModel {
  readonly p: BayesEpaParams;
  private readonly sd2: number;
  private readonly scale: SeasonScale;
  private readonly priors: ReadonlyMap<number, PriorZ>;
  private readonly events = new Map<string, EventState>();
  private readonly where = new Map<number, string>();
  private readonly lastT = new Map<number, number>();
  // in-season calibration
  private zs: number[] = [];
  private outcomes: number[] = [];
  private refitEvery: number;
  c: number;
  // scratch for the current match (set by predict, consumed by update)
  private ri = [0, 0, 0];
  private bi = [0, 0, 0];
  private Rr = 0;
  private Rb = 0;
  private lastZ = 0;
  private A = new Float64Array(64);
  private B = new Float64Array(64);

  constructor(
    scale: SeasonScale,
    priors: ReadonlyMap<number, PriorZ> = new Map(),
    params: BayesEpaParams = BAYES_EPA_PARAMS,
    /** Refit c every N matches during the replay (0 = only on demand). */
    refitEvery = 50,
  ) {
    this.p = params;
    this.scale = { mean: scale.mean, sd: scale.sd > 0 ? scale.sd : 1 };
    this.sd2 = this.scale.sd ** 2;
    this.priors = priors;
    this.c = params.c;
    this.refitEvery = refitEvery;
  }

  private prior(team: number): [number, number] {
    const p = this.p;
    const h = this.priors.get(team);
    const past = h ? h.filter((z): z is number => z != null) : [];
    let z: number;
    let v: number;
    if (past.length > 0) {
      const z1 = past[0];
      const z2 = past.length > 1 ? past[1] : p.newZ;
      const z3 = past.length > 2 ? past[2] : z2;
      const zp = (1 - p.y3w) * (p.y1w * z1 + (1 - p.y1w) * z2) + p.y3w * z3;
      z = (1 - p.revert) * zp + p.revert * p.newZ;
      v = p.p0Vet;
    } else {
      z = p.newZ;
      v = p.p0New;
    }
    return [Math.max(0, this.scale.mean / 3 + p.zScale * this.scale.sd * z), v * this.sd2];
  }

  /** Current marginal (mean, var) for a team; the prior when it has not played. */
  team(t: number): { mean: number; variance: number } {
    const ev = this.where.get(t);
    if (ev === undefined) {
      const [mean, variance] = this.prior(t);
      return { mean, variance };
    }
    const es = this.events.get(ev) as EventState;
    const i = es.idx.get(t) as number;
    return { mean: es.mu[i], variance: es.P[i * es.cap + i] };
  }

  /** Every team the model has seen this season. */
  teams(): number[] {
    return [...this.where.keys()];
  }

  private prep(t: number, ev: string, now: number): number {
    let es = this.events.get(ev);
    if (!es) {
      es = new EventState();
      this.events.set(ev, es);
    }
    let i = es.idx.get(t);
    if (i === undefined || this.where.get(t) !== ev) {
      let mean: number;
      let variance: number;
      if (this.where.has(t)) {
        ({ mean, variance } = this.team(t));
        variance += this.p.qEvent * this.sd2;
      } else {
        [mean, variance] = this.prior(t);
      }
      if (i !== undefined) es.reset(i, mean, variance);
      else i = es.add(t, mean, variance);
      this.where.set(t, ev);
    }
    const last = this.lastT.get(t);
    if (this.p.qDay && last !== undefined && now > 0 && last > 0) {
      const days = Math.max(0, (now - last) / 86400);
      es.P[i * es.cap + i] += this.p.qDay * this.sd2 * Math.min(days, 60);
    }
    this.lastT.set(t, now);
    return i;
  }

  private noise(pred: number, elim: boolean): number {
    const p = this.p;
    let R = p.R * this.sd2 * (elim ? p.elimR : 1);
    if (p.het) R *= Math.pow(Math.max(0.25, pred / this.scale.mean), p.het);
    return R;
  }

  /**
   * Pre-match prediction from the full event posterior. Also stages the match
   * for {@link update}; call predict then update for each played match.
   */
  predict(m: BayesMatch): BayesPrediction {
    const ev = m.eventKey;
    for (let k = 0; k < 3; k++) this.ri[k] = this.prep(m.red[k], ev, m.time);
    for (let k = 0; k < 3; k++) this.bi[k] = this.prep(m.blue[k], ev, m.time);
    const es = this.events.get(ev) as EventState;
    const { mu, P, cap } = es;
    const ri = this.ri;
    const bi = this.bi;
    let pr = 0;
    let pb = 0;
    let vdiff = 0;
    for (let a = 0; a < 3; a++) {
      pr += mu[ri[a]];
      pb += mu[bi[a]];
      for (let b = 0; b < 3; b++) {
        vdiff += P[ri[a] * cap + ri[b]] + P[bi[a] * cap + bi[b]] - 2 * P[ri[a] * cap + bi[b]];
      }
    }
    this.Rr = this.noise(pr, m.elim);
    this.Rb = this.noise(pb, m.elim);
    const marginVar = vdiff + this.Rr + this.Rb - 2 * this.p.rho * Math.sqrt(this.Rr * this.Rb);
    this.lastZ = (pr - pb) / Math.sqrt(marginVar);
    return { redMean: pr, blueMean: pb, marginVar, redWinProb: normCdf(this.c * this.lastZ) };
  }

  /** Apply the result of the match last passed to {@link predict}. */
  update(m: BayesMatch): void {
    const es = this.events.get(m.eventKey) as EventState;
    const { n, cap, mu, P } = es;
    const ri = this.ri;
    const bi = this.bi;
    if (this.A.length < n) {
      this.A = new Float64Array(cap);
      this.B = new Float64Array(cap);
    }
    const A = this.A; // P h_red'
    const B = this.B; // P h_blue'
    for (let j = 0; j < n; j++) {
      const row = j * cap;
      A[j] = P[row + ri[0]] + P[row + ri[1]] + P[row + ri[2]];
      B[j] = P[row + bi[0]] + P[row + bi[1]] + P[row + bi[2]];
    }
    const Crr = A[ri[0]] + A[ri[1]] + A[ri[2]] + this.Rr;
    const Cbb = B[bi[0]] + B[bi[1]] + B[bi[2]] + this.Rb;
    const Crb = A[bi[0]] + A[bi[1]] + A[bi[2]] + this.p.rho * Math.sqrt(this.Rr * this.Rb);
    const det = Crr * Cbb - Crb * Crb;
    const er = m.redScore - (mu[ri[0]] + mu[ri[1]] + mu[ri[2]]);
    const eb = m.blueScore - (mu[bi[0]] + mu[bi[1]] + mu[bi[2]]);
    const wr = (Cbb * er - Crb * eb) / det;
    const wb = (Crr * eb - Crb * er) / det;
    for (let i = 0; i < n; i++) {
      mu[i] += A[i] * wr + B[i] * wb;
      const ai = A[i];
      const bv = B[i];
      const row = i * cap;
      for (let j = 0; j < n; j++) {
        P[row + j] -= (ai * A[j] * Cbb - (ai * B[j] + bv * A[j]) * Crb + bv * B[j] * Crr) / det;
      }
    }
    const q = this.p.q * this.sd2;
    for (let k = 0; k < 6; k++) {
      const i = k < 3 ? ri[k] : bi[k - 3];
      P[i * cap + i] += q;
      if (mu[i] < 0) mu[i] = 0;
    }
    if (this.p.calN) {
      this.zs.push(this.lastZ);
      this.outcomes.push(m.result);
      if (this.refitEvery && this.zs.length % this.refitEvery === 0) this.refit();
    }
  }

  /** Re-fit the win-prob sharpness on every match seen so far this season. */
  refit(): number {
    if (this.p.calN && this.zs.length > 0) {
      this.c = fitCalibration(this.zs, this.outcomes, this.p.c, this.p.calN, this.c);
    }
    return this.c;
  }

  /** Standardized end-of-season strength per team (the next season's prior input). */
  seasonZ(): Map<number, number> {
    const out = new Map<number, number>();
    const teams = this.teams();
    if (teams.length === 0) return out;
    const vals = teams.map((t) => this.team(t).mean);
    const m0 = vals.reduce((s, x) => s + x, 0) / vals.length;
    const s0 = Math.sqrt(vals.reduce((s, x) => s + (x - m0) ** 2, 0) / vals.length) || 1;
    teams.forEach((t, k) => out.set(t, (vals[k] - m0) / s0));
    return out;
  }
}

/** Win probability for an arbitrary (possibly hypothetical) lineup from team marginals. */
export function bayesWinProb(
  red: ReadonlyArray<{ mean: number; variance: number }>,
  blue: ReadonlyArray<{ mean: number; variance: number }>,
  scale: SeasonScale,
  c: number,
  elim = false,
  params: BayesEpaParams = BAYES_EPA_PARAMS,
): BayesPrediction {
  const sd2 = (scale.sd > 0 ? scale.sd : 1) ** 2;
  const noise = (pred: number): number => {
    let R = params.R * sd2 * (elim ? params.elimR : 1);
    if (params.het && scale.mean > 0) R *= Math.pow(Math.max(0.25, pred / scale.mean), params.het);
    return R;
  };
  const pr = red.reduce((s, t) => s + t.mean, 0);
  const pb = blue.reduce((s, t) => s + t.mean, 0);
  const v = [...red, ...blue].reduce((s, t) => s + t.variance, 0);
  const Rr = noise(pr);
  const Rb = noise(pb);
  const marginVar = v + Rr + Rb - 2 * params.rho * Math.sqrt(Rr * Rb);
  return {
    redMean: pr,
    blueMean: pb,
    marginVar,
    redWinProb: normCdf((c * (pr - pb)) / Math.sqrt(marginVar)),
  };
}
