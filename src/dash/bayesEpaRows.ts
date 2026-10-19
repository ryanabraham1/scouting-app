// src/dash/bayesEpaRows.ts
// MatchRow (TBA-derived, see localEpa.tbaMatchesToRows) -> Bayesian EPA inputs,
// plus the one-team season replay the dashboard caches per team.

import type { MatchRow } from '@/dash/useEventData';
import type { LocalEpaMatchRow } from '@/dash/localEpa';
import {
  BayesEpaModel,
  type BayesMatch,
  type PriorZ,
  type SeasonScale,
} from '@/dash/bayesEpa';

function finite(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function noFoul(m: LocalEpaMatchRow, side: 'red' | 'blue'): number | null {
  const nf = side === 'red' ? m.local_epa_red_score : m.local_epa_blue_score;
  return finite(nf) ?? finite(side === 'red' ? m.actual_red_score : m.actual_blue_score);
}

/** Played 3v3 matches in the rows' (chronological) order. Malformed rows are skipped. */
export function bayesMatchesFromRows(rows: readonly MatchRow[]): BayesMatch[] {
  const out: BayesMatch[] = [];
  for (const row of rows) {
    const m = row as LocalEpaMatchRow;
    const red = [m.red1, m.red2, m.red3];
    const blue = [m.blue1, m.blue2, m.blue3];
    if (red.some((t) => t == null) || blue.some((t) => t == null)) continue;
    const rs = noFoul(m, 'red');
    const bs = noFoul(m, 'blue');
    const ra = finite(m.actual_red_score);
    const ba = finite(m.actual_blue_score);
    if (rs == null || bs == null || ra == null || ba == null) continue;
    const result =
      m.winner === 'red' ? 1 : m.winner === 'blue' ? 0 : ra > ba ? 1 : ba > ra ? 0 : 0.5;
    out.push({
      eventKey: m.event_key,
      elim: m.comp_level !== 'qm',
      time: finite(m.local_epa_time) ?? 0,
      red: red as number[],
      blue: blue as number[],
      redScore: rs,
      blueScore: bs,
      result,
    });
  }
  return out;
}

/** Mean no-foul alliance score and sample SD of official alliance scores. */
export function seasonScaleFromRows(rows: readonly MatchRow[]): SeasonScale {
  const nf: number[] = [];
  const official: number[] = [];
  for (const row of rows) {
    const m = row as LocalEpaMatchRow;
    for (const side of ['red', 'blue'] as const) {
      const o = finite(side === 'red' ? m.actual_red_score : m.actual_blue_score);
      const n = noFoul(m, side);
      if (o != null && n != null) {
        official.push(o);
        nf.push(n);
      }
    }
  }
  if (official.length < 2) return { mean: 0, sd: 1 };
  const mean = nf.reduce((s, x) => s + x, 0) / nf.length;
  const om = official.reduce((s, x) => s + x, 0) / official.length;
  const sd = Math.sqrt(official.reduce((s, x) => s + (x - om) ** 2, 0) / (official.length - 1));
  return { mean, sd: sd > 0 ? sd : 1 };
}

/** Win-probability calibration a consumer needs alongside team means/variances. */
export interface BayesCal {
  c: number;
  mean: number;
  sd: number;
}

export interface BayesTeamSeason {
  mean: number;
  variance: number;
  cal: BayesCal;
  /** The team's mean after each of its played matches, in order (last = current estimate). */
  history: Array<{ matchKey: string; eventKey: string; compLevel: string; matchNumber: number; value: number }>;
}

/**
 * Replay a season closure (complete events, chronological) and return one
 * team's posterior. Null when the team never played a usable match.
 */
export function bayesTeamSeason(
  rows: readonly MatchRow[],
  team: number,
  priors: ReadonlyMap<number, PriorZ>,
  withHistory = false,
): BayesTeamSeason | null {
  const scale = seasonScaleFromRows(rows);
  if (!(scale.mean > 0)) return null;
  // Refit once at the end: the in-replay refit cadence only matters for
  // pre-match backtests, and skipping it keeps a replay O(matches).
  const model = new BayesEpaModel(scale, priors, undefined, 0);
  const history: BayesTeamSeason['history'] = [];
  let played = false;
  for (const r of rows) {
    const m = bayesMatchesFromRows([r])[0];
    if (!m) continue;
    model.predict(m);
    model.update(m);
    if (m.red.includes(team) || m.blue.includes(team)) {
      played = true;
      if (withHistory) {
        history.push({
          matchKey: r.match_key,
          eventKey: r.event_key,
          compLevel: r.comp_level,
          matchNumber: r.match_number,
          value: model.team(team).mean,
        });
      }
    }
  }
  if (!played) return null;
  const { mean, variance } = model.team(team);
  // Partners' later matches keep refining a team's estimate after its own last
  // match (full covariance), so the newest point shows the current estimate:
  // the chart's last point always equals the headline EPA.
  const last = history.at(-1);
  if (last) last.value = mean;
  return { mean, variance, cal: { c: model.refit(), mean: scale.mean, sd: scale.sd }, history };
}
