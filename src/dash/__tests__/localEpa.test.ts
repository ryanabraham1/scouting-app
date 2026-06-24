// src/dash/__tests__/localEpa.test.ts
import { describe, it, expect } from 'vitest';
import { computeLocalEpa, tbaMatchesToRows } from '@/dash/localEpa';
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

  it('initializes and updates per the Statbotics scalar recurrence', () => {
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
    const epa = computeLocalEpa(matches);
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
