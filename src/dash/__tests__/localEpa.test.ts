// src/dash/__tests__/localEpa.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeLocalEpa,
  computeLocalEpaComponents,
  computeLocalEpaHistory,
  tbaMatchesToRows,
} from '@/dash/localEpa';
import type { LocalEpaMatchRow } from '@/dash/localEpa';
import { EPA_GAIN } from '@/dash/constants';
import type { MatchRow } from '@/dash/useEventData';

let seq = 0;
function match(o: Partial<MatchRow>): MatchRow {
  seq += 1;
  return {
    match_key: `2026evt_qm${o.match_number ?? seq}`,
    event_key: '2026evt',
    comp_level: 'qm',
    match_number: o.match_number ?? seq,
    scheduled_time: null,
    red1: null,
    red2: null,
    red3: null,
    blue1: null,
    blue2: null,
    blue3: null,
    actual_red_score: null,
    actual_blue_score: null,
    winner: null,
    result_synced_at: null,
    ...o,
  };
}

describe('computeLocalEpa', () => {
  it('returns an empty map when there are no played matches', () => {
    const matches = [
      match({ match_number: 1, red1: 1, red2: 2, red3: 3, blue1: 4, blue2: 5, blue3: 6 }),
    ];
    expect(computeLocalEpa(matches).size).toBe(0);
  });

  it('returns an empty map for an empty input', () => {
    expect(computeLocalEpa([]).size).toBe(0);
  });

  it('captures one connected-history point after every match the team played', () => {
    const matches = [
      match({
        match_key: '2026first_qm1',
        event_key: '2026first',
        match_number: 1,
        red1: 1,
        red2: 2,
        red3: 3,
        blue1: 4,
        blue2: 5,
        blue3: 6,
        actual_red_score: 120,
        actual_blue_score: 90,
      }),
      match({
        match_key: '2026first_qm2',
        event_key: '2026first',
        match_number: 2,
        red1: 7,
        red2: 8,
        red3: 9,
        blue1: 4,
        blue2: 5,
        blue3: 6,
        actual_red_score: 80,
        actual_blue_score: 100,
      }),
      match({
        match_key: '2026second_qm1',
        event_key: '2026second',
        match_number: 3,
        red1: 1,
        red2: 7,
        red3: 8,
        blue1: 4,
        blue2: 5,
        blue3: 6,
        actual_red_score: 70,
        actual_blue_score: 130,
      }),
    ];
    const options = { recencyBoost: 0.5 };
    const history = computeLocalEpaHistory(matches, 1, options);

    expect(history.map((point) => point.matchKey)).toEqual([
      '2026first_qm1',
      '2026second_qm1',
    ]);
    expect(history.map((point) => point.eventKey)).toEqual(['2026first', '2026second']);
    expect(history[0]?.value).not.toBe(history[1]?.value);
    expect(history.at(-1)?.value).toBeCloseTo(computeLocalEpa(matches, options).get(1) as number, 10);
  });

  it('recencyBoost 0 reproduces the exact (un-tilted) Statbotics port', () => {
    const ms = [
      match({
        match_number: 1,
        red1: 1,
        red2: 2,
        red3: 3,
        blue1: 4,
        blue2: 5,
        blue3: 6,
        actual_red_score: 90,
        actual_blue_score: 60,
      }),
    ];
    expect(computeLocalEpa(ms, { recencyBoost: 0 }).get(1)).toBe(computeLocalEpa(ms).get(1));
  });

  it('recency weighting tilts EPA toward recent performance', () => {
    // Team 1 (fixed partners 2,3 vs 4,5,6) scores LOW early and HIGH late. With a
    // recency tilt the recent strong matches weigh more, so the EPA ends higher.
    const ms: MatchRow[] = [];
    [60, 60, 60, 60, 200, 200, 200, 200].forEach((s, i) =>
      ms.push(
        match({
          match_number: i + 1,
          red1: 1,
          red2: 2,
          red3: 3,
          blue1: 4,
          blue2: 5,
          blue3: 6,
          actual_red_score: s,
          actual_blue_score: 90,
        }),
      ),
    );
    const base = computeLocalEpa(ms).get(1) as number;
    const tilted = computeLocalEpa(ms, { recencyBoost: 1 }).get(1) as number;
    expect(tilted).toBeGreaterThan(base);
  });

  it('initializes and updates per the Statbotics scalar recurrence (gain 1)', () => {
    // One played match: red 90, blue 60. Alliance scores = [90, 60].
    //   mean = 75, population sd = 15.
    //   init = max(0, mean/3 - 0.2*sd) = max(0, 25 - 3) = 22.
    const matches = [
      match({
        match_number: 1,
        red1: 1,
        red2: 2,
        red3: 3,
        blue1: 4,
        blue2: 5,
        blue3: 6,
        actual_red_score: 90,
        actual_blue_score: 60,
      }),
    ];
    const epa = computeLocalEpa(matches, { gain: 1 });
    for (const t of [1, 2, 3, 4, 5, 6]) {
      expect(Number.isFinite(epa.get(t) as number)).toBe(true);
    }
    // N=0 -> percent = (2/3)*clamp(0.5-(0-6)/30,0.3,0.5) = (2/3)*0.5 = 1/3.
    // Pre-match alliance EPA = 3*22 = 66.
    //   red  Δ = 1 * (1/3) * (90-66)/3 = (1/3)*8  =  8/3  -> 22 + 8/3 = 74/3 ≈ 24.6667
    //   blue Δ = 1 * (1/3) * (60-66)/3 = (1/3)*-2 = -2/3  -> 22 - 2/3 = 64/3 ≈ 21.3333
    expect(epa.get(1)).toBeCloseTo(74 / 3, 6);
    expect(epa.get(4)).toBeCloseTo(64 / 3, 6);
  });

  it('scales every update by EPA_GAIN by default', () => {
    const matches = [
      match({
        match_number: 1,
        red1: 1, red2: 2, red3: 3,
        blue1: 4, blue2: 5, blue3: 6,
        actual_red_score: 90,
        actual_blue_score: 60,
      }),
    ];
    const init = 22;
    const unit = (computeLocalEpa(matches, { gain: 1 }).get(1) as number) - init;
    const dflt = (computeLocalEpa(matches).get(1) as number) - init;
    expect(dflt).toBeCloseTo(unit * EPA_GAIN, 10);
    expect(EPA_GAIN).toBeGreaterThan(1);
  });

  it('a team that consistently outscores rises above one that consistently loses', () => {
    // Team 1 always on the winning red alliance; team 4 always on the losing blue.
    const matches: MatchRow[] = [];
    for (let i = 1; i <= 8; i += 1) {
      matches.push(
        match({
          match_number: i,
          red1: 1,
          red2: 10 + i, // filler teammates vary so they don't anchor
          red3: 20 + i,
          blue1: 4,
          blue2: 30 + i,
          blue3: 40 + i,
          actual_red_score: 120,
          actual_blue_score: 40,
        }),
      );
    }
    const epa = computeLocalEpa(matches);
    expect(epa.get(1) as number).toBeGreaterThan(epa.get(4) as number);
    // The consistent winner should sit clearly above the init baseline.
    expect(epa.get(1) as number).toBeGreaterThan(40);
  });

  it('ignores null roster slots without throwing', () => {
    const matches = [
      match({
        match_number: 1,
        red1: 1,
        red2: null,
        red3: 3,
        blue1: 4,
        blue2: 5,
        blue3: null,
        actual_red_score: 50,
        actual_blue_score: 50,
      }),
    ];
    const epa = computeLocalEpa(matches);
    expect(epa.has(1)).toBe(true);
    expect(epa.has(3)).toBe(true);
    expect(epa.has(4)).toBe(true);
    // No NaN leaked from the null slots.
    for (const v of epa.values()) expect(Number.isNaN(v)).toBe(false);
  });

  it('weights playoff (elim) matches at 1/3 of a qual update', () => {
    // Identical score (red 90, blue 60) in a qual vs a semifinal. Both single
    // matches share init = 22, so the elim team should move exactly 1/3 as far.
    const qual = match({
      match_number: 1,
      comp_level: 'qm',
      red1: 1, red2: 2, red3: 3,
      blue1: 4, blue2: 5, blue3: 6,
      actual_red_score: 90,
      actual_blue_score: 60,
    });
    const elim = match({
      match_number: 1,
      comp_level: 'sf',
      match_key: '2026evt_sf1',
      red1: 11, red2: 12, red3: 13,
      blue1: 14, blue2: 15, blue3: 16,
      actual_red_score: 90,
      actual_blue_score: 60,
    });
    const init = 22;
    const qDelta = (computeLocalEpa([qual]).get(1) as number) - init;
    const eDelta = (computeLocalEpa([elim]).get(11) as number) - init;
    expect(eDelta).toBeCloseTo(qDelta / 3, 6);
  });

  it('processes matches in match_number order regardless of input order', () => {
    const a = match({
      match_number: 2,
      red1: 1,
      red2: 2,
      red3: 3,
      blue1: 4,
      blue2: 5,
      blue3: 6,
      actual_red_score: 100,
      actual_blue_score: 50,
    });
    const b = match({
      match_number: 1,
      red1: 1,
      red2: 2,
      red3: 3,
      blue1: 4,
      blue2: 5,
      blue3: 6,
      actual_red_score: 100,
      actual_blue_score: 50,
    });
    const out1 = computeLocalEpa([a, b]);
    const out2 = computeLocalEpa([b, a]);
    expect(out1.get(1)).toBeCloseTo(out2.get(1) as number, 10);
  });
});

describe('computeLocalEpaComponents', () => {
  const withComponents = (
    over: Partial<LocalEpaMatchRow>,
    red: { auto: number; teleop: number; endgame: number },
    blue: { auto: number; teleop: number; endgame: number },
  ): LocalEpaMatchRow => ({
    ...match({
      red1: 1, red2: 2, red3: 3,
      blue1: 4, blue2: 5, blue3: 6,
      actual_red_score: red.auto + red.teleop + red.endgame,
      actual_blue_score: blue.auto + blue.teleop + blue.endgame,
      ...over,
    }),
    local_epa_red_components: red,
    local_epa_blue_components: blue,
  });

  it('is empty when no played match carries components', () => {
    const ms = [match({ match_number: 1, red1: 1, red2: 2, red3: 3, blue1: 4, blue2: 5, blue3: 6, actual_red_score: 90, actual_blue_score: 60 })];
    expect(computeLocalEpaComponents(ms).size).toBe(0);
  });

  it('component streams sum to the total EPA for every team', () => {
    const ms: LocalEpaMatchRow[] = [
      withComponents({ match_number: 1 }, { auto: 30, teleop: 50, endgame: 10 }, { auto: 10, teleop: 40, endgame: 10 }),
      withComponents({ match_number: 2, match_key: 'k2', red1: 4, red2: 5, red3: 6, blue1: 1, blue2: 2, blue3: 3 }, { auto: 5, teleop: 60, endgame: 0 }, { auto: 40, teleop: 100, endgame: 20 }),
      withComponents({ match_number: 3, match_key: 'k3', comp_level: 'sf' }, { auto: 20, teleop: 80, endgame: 0 }, { auto: 20, teleop: 20, endgame: 20 }),
    ];
    const total = computeLocalEpa(ms);
    const comp = computeLocalEpaComponents(ms);
    for (const t of [1, 2, 3, 4, 5, 6]) {
      const c = comp.get(t)!;
      expect(c.auto + c.teleop + c.endgame).toBeCloseTo(total.get(t) as number, 9);
    }
    // Team 1's alliance out-scored its prediction in auto by more than teams 4-6's did.
    expect(comp.get(1)!.auto).toBeGreaterThan(comp.get(4)!.auto);
  });

  it('a match without components apportions the total delta by current shares (sum still holds)', () => {
    const ms: LocalEpaMatchRow[] = [
      withComponents({ match_number: 1 }, { auto: 30, teleop: 50, endgame: 10 }, { auto: 10, teleop: 40, endgame: 10 }),
      match({ match_number: 2, match_key: 'k2', red1: 1, red2: 2, red3: 3, blue1: 4, blue2: 5, blue3: 6, actual_red_score: 200, actual_blue_score: 20 }),
    ];
    const total = computeLocalEpa(ms);
    const comp = computeLocalEpaComponents(ms);
    for (const t of [1, 2, 3, 4, 5, 6]) {
      const c = comp.get(t)!;
      expect(c.auto + c.teleop + c.endgame).toBeCloseTo(total.get(t) as number, 9);
    }
  });
});

describe('tbaMatchesToRows', () => {
  const tbaMatch = (o: Record<string, unknown>) => ({
    key: 'k',
    event_key: '2026evt',
    comp_level: 'qm',
    match_number: 1,
    alliances: {
      red: { team_keys: ['frc1', 'frc2', 'frc3'], score: 90 },
      blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: 60 },
    },
    winning_alliance: 'red',
    ...o,
  });

  it('parses a TBA match into the MatchRow shape', () => {
    const [row] = tbaMatchesToRows([tbaMatch({ actual_time: 100 })]);
    expect(row.red1).toBe(1);
    expect(row.blue3).toBe(6);
    expect(row.actual_red_score).toBe(90);
    expect(row.actual_blue_score).toBe(60);
    expect(row.winner).toBe('red');
  });

  it('uses no-foul scores for EPA while retaining different official scores', () => {
    const withFouls = (redScore: number, redFouls: number, blueScore: number, blueFouls: number) =>
      tbaMatch({
        alliances: {
          red: { team_keys: ['frc1', 'frc2', 'frc3'], score: redScore },
          blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: blueScore },
        },
        score_breakdown: {
          red: { foulPoints: redFouls, adjustPoints: 0 },
          blue: { foulPoints: blueFouls, adjustPoints: 0 },
        },
      });

    // Both matches represent the same 80-60 robot output. Only awarded foul
    // points (and therefore the displayed official scores) differ.
    const [lowerFouls] = tbaMatchesToRows([withFouls(90, 10, 65, 5)]);
    const [higherFouls] = tbaMatchesToRows([withFouls(120, 40, 85, 25)]);

    expect(lowerFouls.actual_red_score).toBe(90);
    expect(higherFouls.actual_red_score).toBe(120);
    expect(computeLocalEpa([lowerFouls])).toEqual(computeLocalEpa([higherFouls]));
  });

  it('attaches 2026 breakdown components (and omits them when the keys are absent)', () => {
    const full = tbaMatch({
      alliances: {
        red: { team_keys: ['frc1', 'frc2', 'frc3'], score: 446 },
        blue: { team_keys: ['frc4', 'frc5', 'frc6'], score: 100 },
      },
      score_breakdown: {
        red: {
          totalAutoPoints: 57, autoTowerPoints: 15, totalTeleopPoints: 389, endGameTowerPoints: 30,
          totalTowerPoints: 45, totalPoints: 446, foulPoints: 0, adjustPoints: 0,
        },
        blue: {
          totalAutoPoints: 20, autoTowerPoints: 0, totalTeleopPoints: 80, endGameTowerPoints: 0,
          totalTowerPoints: 0, totalPoints: 100, foulPoints: 0, adjustPoints: 0,
        },
      },
    });
    const [row] = tbaMatchesToRows([full]) as LocalEpaMatchRow[];
    expect(row.local_epa_red_components).toEqual({ auto: 42, teleop: 359, endgame: 45 });
    expect(row.local_epa_blue_components).toEqual({ auto: 20, teleop: 80, endgame: 0 });
    const [legacy] = tbaMatchesToRows([tbaMatch({
      score_breakdown: { red: { foulPoints: 0, adjustPoints: 0 }, blue: { foulPoints: 0, adjustPoints: 0 } },
    })]) as LocalEpaMatchRow[];
    expect(legacy.local_epa_red_components).toBeUndefined();
  });

  it('falls back to official scores when score_breakdown is missing or malformed', () => {
    const [missing] = tbaMatchesToRows([tbaMatch({})]);
    const [malformed] = tbaMatchesToRows([
      tbaMatch({
        score_breakdown: {
          red: { foulPoints: 'ten' },
          blue: { foulPoints: Number.NaN },
        },
      }),
    ]);

    expect(computeLocalEpa([missing])).toEqual(computeLocalEpa([malformed]));
  });

  it('treats unplayed matches (score -1) as null so the EPA model skips them', () => {
    const [row] = tbaMatchesToRows([
      tbaMatch({
        alliances: {
          red: { team_keys: ['frc1'], score: -1 },
          blue: { team_keys: ['frc4'], score: -1 },
        },
        winning_alliance: '',
      }),
    ]);
    expect(row.actual_red_score).toBeNull();
    expect(row.actual_blue_score).toBeNull();
  });

  it('orders chronologically and assigns a monotonic match_number', () => {
    const rows = tbaMatchesToRows([
      tbaMatch({ key: 'late', match_number: 5, actual_time: 500 }),
      tbaMatch({ key: 'early', match_number: 2, actual_time: 100 }),
    ]);
    expect(rows.map((r) => r.match_key)).toEqual(['early', 'late']);
    expect(rows.map((r) => r.match_number)).toEqual([1, 2]);
  });

  it('returns [] for non-array or malformed input', () => {
    expect(tbaMatchesToRows(null)).toEqual([]);
    expect(tbaMatchesToRows('nope')).toEqual([]);
    expect(tbaMatchesToRows([{}, { alliances: {} }])).toEqual([]);
  });
});
