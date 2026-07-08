// src/dash/strategy/__tests__/redFlags.test.ts
import { describe, it, expect } from 'vitest';
import { teamRedFlags } from '@/dash/strategy/redFlags';
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
