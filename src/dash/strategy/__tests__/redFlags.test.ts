// src/dash/strategy/__tests__/redFlags.test.ts
import { describe, it, expect } from 'vitest';
import {
  teamRedFlags,
  evaluateEpaDrop,
  defenseTimeShare,
  EPA_DROP_MED,
  EPA_DROP_HIGH,
} from '@/dash/strategy/redFlags';
import { aggregateTeam } from '@/dash/aggregate';
import type { MsrRow } from '@/dash/types';

function row(overrides: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 100,
    match_key: '2026evt_qm1',
    alliance_color: 'red',
    station: 1,
    auto_fuel: 0,
    teleop_fuel_active: 0,
    teleop_fuel_inactive: 0,
    endgame_fuel: 0,
    fuel_points: 10,
    fuel_estimate_confidence: 0.8,
    fuel_by_shift: [0, 0, 0, 0],
    climb_level: 0,
    climb_attempted: false,
    climb_success: false,
    auto_left_starting_line: true,
    auto_climb_level1: false,
    defense_rating: 0,
    pins: 0,
    no_show: false,
    died: false,
    tipped: false,
    dropped_fuel: false,
    fed_corral: false,
    auto_start_position: null,
    auto_path: null,
    server_received_at: '2026-06-23T00:00:00Z',
    deleted: false,
    ...overrides,
  };
}

function kinds(reports: MsrRow[]): string[] {
  return teamRedFlags(reports).map((f) => f.kind);
}

describe('teamRedFlags', () => {
  it('returns nothing for an unscouted team or a clean record', () => {
    expect(teamRedFlags([])).toEqual([]);
    expect(teamRedFlags([row({}), row({ match_key: 'qm2' })])).toEqual([]);
  });

  it('flags died with counts; repeat deaths escalate to high', () => {
    const one = teamRedFlags([row({ died: true }), row({}), row({}), row({})]);
    expect(one[0].kind).toBe('died');
    expect(one[0].severity).toBe('med');
    expect(one[0].text).toContain('1 of 4');

    const two = teamRedFlags([row({ died: true }), row({ died: true }), row({})]);
    expect(two[0].severity).toBe('high');
  });

  it('flags no-shows as high severity', () => {
    const flags = teamRedFlags([row({ no_show: true }), row({})]);
    expect(flags[0].kind).toBe('no-show');
    expect(flags[0].severity).toBe('high');
  });

  it('flags tip-overs; repeats escalate', () => {
    expect(kinds([row({ tipped: true }), row({})])).toContain('tipped');
    const two = teamRedFlags([row({ tipped: true }), row({ tipped: true })]);
    expect(two.find((f) => f.kind === 'tipped')?.severity).toBe('high');
  });

  it('flags a ≥50% climb failure rate (needs ≥2 attempts); all-fail is high', () => {
    // 1 attempt, failed → no flag (too little signal).
    expect(kinds([row({ climb_attempted: true })])).not.toContain('climb-fails');
    // 2 attempts, 1 fail → med.
    const half = teamRedFlags([
      row({ climb_attempted: true }),
      row({ climb_attempted: true, climb_success: true }),
    ]);
    expect(half.find((f) => f.kind === 'climb-fails')?.severity).toBe('med');
    // 2 attempts, both fail → high.
    const all = teamRedFlags([row({ climb_attempted: true }), row({ climb_attempted: true })]);
    expect(all.find((f) => f.kind === 'climb-fails')?.severity).toBe('high');
  });

  it('flags major fouls (high) and a minor-foul habit (med, rate-based)', () => {
    const majors = teamRedFlags([row({ fouls_major: 1 }), row({})]);
    expect(majors.find((f) => f.kind === 'major-fouls')?.severity).toBe('high');

    // 4 minors over 2 matches = 2/match → flagged; 1 over 2 → not.
    expect(kinds([row({ fouls_minor: 3 }), row({ fouls_minor: 1 })])).toContain('foul-prone');
    expect(kinds([row({ fouls_minor: 1 }), row({})])).not.toContain('foul-prone');
  });

  it('reads timed defense share: primary vs regular wording', () => {
    // 70s of defense per 135s teleop across every match → primary (~52%).
    const primary = teamRedFlags([
      row({ defense_duration_ms: 70_000 }),
      row({ defense_duration_ms: 70_000 }),
    ]);
    const p = primary.find((f) => f.kind === 'defense-specialist');
    expect(p?.text).toMatch(/Primarily a defense bot/);

    // ~20% of teleop → regular.
    const regular = teamRedFlags([
      row({ defense_duration_ms: 27_000 }),
      row({ defense_duration_ms: 27_000 }),
    ]);
    expect(regular.find((f) => f.kind === 'defense-specialist')?.text).toMatch(/regular defense/);

    // ~5% → no flag.
    expect(kinds([row({ defense_duration_ms: 7_000 })])).not.toContain('defense-specialist');
  });

  it('falls back to the defense rating when no durations were captured', () => {
    const flags = teamRedFlags([
      row({ defense_rating: 2 }),
      row({ defense_rating: 3 }),
      row({}),
    ]);
    expect(flags.find((f) => f.kind === 'defense-specialist')?.text).toMatch(/2 of 3/);
  });

  it('flags chronic fuel dropping only on repeats', () => {
    expect(kinds([row({ dropped_fuel: true }), row({})])).not.toContain('drops-fuel');
    expect(kinds([row({ dropped_fuel: true }), row({ dropped_fuel: true })])).toContain(
      'drops-fuel',
    );
  });

  it('orders high-severity flags first', () => {
    const flags = teamRedFlags([
      row({ dropped_fuel: true, fouls_major: 1 }),
      row({ dropped_fuel: true }),
    ]);
    expect(flags[0].severity).toBe('high');
  });
});

describe('scoring trend + role switch', () => {
  const fuelSeries = (vals: number[]): MsrRow[] =>
    vals.map((fp, i) =>
      row({
        match_key: `2026evt_qm${i + 1}`,
        fuel_points: fp,
        server_received_at: `2026-06-23T00:0${i}:00Z`,
      }),
    );

  it('flags a significant scouted scoring decline via TeamAgg recent form', () => {
    // Overall mean 20, last-3 mean 10 → −50% and −10 pts → high.
    const reports = fuelSeries([30, 30, 30, 10, 10, 10]);
    const agg = aggregateTeam(100, reports);
    const flags = teamRedFlags(reports, agg);
    const f = flags.find((x) => x.kind === 'scoring-decline');
    expect(f).toBeTruthy();
    expect(f?.severity).toBe('high');
    expect(f?.text).toMatch(/trending down/i);
  });

  it('stays quiet for stable or improving scoring', () => {
    const stable = fuelSeries([20, 21, 19, 20, 21, 20]);
    expect(
      teamRedFlags(stable, aggregateTeam(100, stable)).find((x) => x.kind === 'scoring-decline'),
    ).toBeUndefined();
    const improving = fuelSeries([10, 10, 10, 30, 30, 30]);
    expect(
      teamRedFlags(improving, aggregateTeam(100, improving)).find(
        (x) => x.kind === 'scoring-decline',
      ),
    ).toBeUndefined();
  });

  it('flags a scorer who played real defense in their LATEST match', () => {
    const reports = [
      row({ match_key: '2026evt_qm1', fuel_points: 25, defense_duration_ms: 0 }),
      row({ match_key: '2026evt_qm2', fuel_points: 28, defense_duration_ms: 0 }),
      row({ match_key: '2026evt_qm3', fuel_points: 26, defense_duration_ms: 0 }),
      // Latest: ~33% of teleop on defense.
      row({ match_key: '2026evt_qm4', fuel_points: 4, defense_duration_ms: 45_000 }),
    ];
    const f = teamRedFlags(reports).find((x) => x.kind === 'role-switch');
    expect(f).toBeTruthy();
    expect(f?.text).toMatch(/usually scores/i);
    expect(f?.text).toMatch(/defense/i);
  });

  it('does NOT call a role switch for habitual defenders or low scorers', () => {
    // Habitual defender: defense every match → baseline share too high.
    const defender = [1, 2, 3, 4].map((i) =>
      row({ match_key: `2026evt_qm${i}`, fuel_points: 20, defense_duration_ms: 40_000 }),
    );
    expect(teamRedFlags(defender).find((x) => x.kind === 'role-switch')).toBeUndefined();
    // Low scorer switching to defense: not a "scorer" baseline.
    const lowScorer = [
      row({ match_key: '2026evt_qm1', fuel_points: 3 }),
      row({ match_key: '2026evt_qm2', fuel_points: 4 }),
      row({ match_key: '2026evt_qm3', fuel_points: 2, defense_duration_ms: 45_000 }),
    ];
    expect(teamRedFlags(lowScorer).find((x) => x.kind === 'role-switch')).toBeUndefined();
  });
});

describe('defenseTimeShare', () => {
  it('null for unscouted teams and for reports with no timed defense data', () => {
    expect(defenseTimeShare([])).toBeNull();
    expect(defenseTimeShare([row({}), row({ defense_rating: 3 })])).toBeNull();
  });

  it('pools duration over ALL scouted matches (~135s teleop each)', () => {
    // 27s of defense in one of two matches → 27/(2*135) = 10%.
    const share = defenseTimeShare([row({ defense_duration_ms: 27_000 }), row({})]);
    expect(share).toBeCloseTo(0.1, 3);
  });
});

describe('evaluateEpaDrop', () => {
  it('null for missing/zero baselines and insignificant changes', () => {
    expect(evaluateEpaDrop(null, 100)).toBeNull();
    expect(evaluateEpaDrop(100, null)).toBeNull();
    expect(evaluateEpaDrop(0, 0)).toBeNull();
    expect(evaluateEpaDrop(100, 98)).toBeNull(); // −2%
    expect(evaluateEpaDrop(100, 110)).toBeNull(); // improving
  });

  it('med at the med cutoffs, high at the high cutoffs', () => {
    // −15% and −15 pts from 100 → med (below the −22% high fraction).
    const med = evaluateEpaDrop(100, 85);
    expect(med?.kind).toBe('epa-drop');
    expect(med?.severity).toBe('med');
    // −30% and −45 pts from 150 → high.
    const high = evaluateEpaDrop(150, 105);
    expect(high?.severity).toBe('high');
    expect(high?.text).toMatch(/105 now vs 150/);
  });

  it('requires BOTH the absolute and fractional thresholds', () => {
    // Big fraction, tiny absolute (low-EPA team): 20 → 15 is −25% but only −5 pts.
    expect(EPA_DROP_MED.abs).toBeGreaterThan(5);
    expect(evaluateEpaDrop(20, 15)).toBeNull();
    // Big absolute, small fraction: 400 → 385 is −15 pts but only ~−4%.
    expect(EPA_DROP_HIGH.frac).toBeGreaterThan(0.04);
    expect(evaluateEpaDrop(400, 385)).toBeNull();
  });
});
