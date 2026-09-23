import { describe, expect, it } from 'vitest';
import {
  epochToIso,
  shouldWriteMatchRow,
  tbaMatchToRow,
  teamNum,
  upcomingMatchToRow,
  withoutUnplayedResult,
  type TbaMatch,
} from '../../supabase/functions/_shared/tbaMatchRow';

const NOW = new Date('2026-09-20T18:00:00.000Z');

function qm(overrides: Partial<TbaMatch> = {}): TbaMatch {
  return {
    key: '2026cc_qm12',
    event_key: '2026cc',
    comp_level: 'qm',
    match_number: 12,
    time: 1_789_000_000,
    predicted_time: 1_789_000_300,
    actual_time: null,
    alliances: {
      red: { score: 120, team_keys: ['frc254', 'frc1678', 'frc3256'] },
      blue: { score: 95, team_keys: ['frc971', 'frc604', 'frc649'] },
    },
    ...overrides,
  };
}

describe('tbaMatchToRow', () => {
  it('maps a played qual match with roster, times and result', () => {
    const mapped = tbaMatchToRow(qm(), '2026cc', { now: NOW });
    expect(mapped?.played).toBe(true);
    expect(mapped?.row).toMatchObject({
      match_key: '2026cc_qm12',
      event_key: '2026cc',
      comp_level: 'qm',
      match_number: 12,
      red1: 254,
      red3: 3256,
      blue1: 971,
      actual_red_score: 120,
      actual_blue_score: 95,
      winner: 'red',
      result_synced_at: NOW.toISOString(),
      scheduled_time: epochToIso(1_789_000_000),
      actual_time: null,
    });
  });

  it('treats -1 scores as unplayed and never stamps a result', () => {
    const mapped = tbaMatchToRow(
      qm({
        alliances: {
          red: { score: -1, team_keys: ['frc254', 'frc1678', 'frc3256'] },
          blue: { score: -1, team_keys: ['frc971', 'frc604', 'frc649'] },
        },
      }),
      '2026cc',
    );
    expect(mapped?.played).toBe(false);
    expect(mapped?.row.winner).toBeNull();
    expect(mapped?.row.result_synced_at).toBeNull();
  });

  it('omits roster columns for an alliance with no teams (never NULLs a stored roster)', () => {
    const mapped = tbaMatchToRow(
      qm({ alliances: { red: { score: 10 }, blue: { score: 5 } } }),
      '2026cc',
    );
    expect(mapped?.hasTeams).toBe(false);
    expect(mapped?.row).not.toHaveProperty('red1');
    expect(mapped?.row).not.toHaveProperty('blue1');
  });

  it('rejects unusable matches', () => {
    expect(tbaMatchToRow(qm({ key: undefined }), '2026cc')).toBeNull();
    expect(tbaMatchToRow(qm({ comp_level: 'pm' }), '2026cc')).toBeNull();
    expect(tbaMatchToRow(qm(), '')).toBeNull();
  });

  it('present-only timing omits missing times instead of writing null', () => {
    const mapped = tbaMatchToRow(qm({ predicted_time: null, actual_time: 0 }), '2026cc', {
      timing: 'present-only',
    });
    expect(mapped?.row).toHaveProperty('scheduled_time');
    expect(mapped?.row).not.toHaveProperty('predicted_time');
    expect(mapped?.row).not.toHaveProperty('actual_time');
  });

  it('webhook shape strips result columns from an unplayed notification', () => {
    const mapped = tbaMatchToRow(
      qm({ alliances: { red: { score: -1 }, blue: { score: -1 } } }),
      '2026cc',
    )!;
    const row = withoutUnplayedResult(mapped);
    expect(row).not.toHaveProperty('actual_red_score');
    expect(row).not.toHaveProperty('winner');
    expect(row).not.toHaveProperty('result_synced_at');
  });
});

describe('shouldWriteMatchRow', () => {
  const stored = (mapped: ReturnType<typeof tbaMatchToRow>) => ({ ...mapped!.row });

  it('writes a new match', () => {
    expect(shouldWriteMatchRow(undefined, tbaMatchToRow(qm(), '2026cc')!)).toBe(true);
  });

  it('skips an unchanged match', () => {
    const mapped = tbaMatchToRow(qm(), '2026cc')!;
    expect(shouldWriteMatchRow(stored(mapped), mapped)).toBe(false);
  });

  it('treats Z and +00:00 spellings of one instant as unchanged', () => {
    const mapped = tbaMatchToRow(qm(), '2026cc')!;
    const prev = {
      ...stored(mapped),
      scheduled_time: String(mapped.row.scheduled_time).replace('.000Z', '+00:00'),
    };
    expect(shouldWriteMatchRow(prev, mapped)).toBe(false);
  });

  it('never lets an unplayed-shaped payload erase a stored result', () => {
    const played = tbaMatchToRow(qm(), '2026cc')!;
    const regressed = tbaMatchToRow(
      qm({ time: 1_789_000_900, alliances: { red: { score: -1 }, blue: { score: -1 } } }),
      '2026cc',
    )!;
    expect(shouldWriteMatchRow(stored(played), regressed)).toBe(false);
  });

  it('writes a roster change even when timing and result are unchanged', () => {
    const before = tbaMatchToRow(qm(), '2026cc')!;
    const after = tbaMatchToRow(
      qm({
        alliances: {
          red: { score: 120, team_keys: ['frc254', 'frc1678', 'frc9999'] },
          blue: { score: 95, team_keys: ['frc971', 'frc604', 'frc649'] },
        },
      }),
      '2026cc',
    )!;
    expect(shouldWriteMatchRow(stored(before), after)).toBe(true);
  });

  it('writes a winner flip with equal scores (DQ / tiebreaker)', () => {
    const tie = tbaMatchToRow(
      qm({ alliances: { red: { score: 90 }, blue: { score: 90 } } }),
      '2026cc',
    )!;
    const decided = tbaMatchToRow(
      qm({ winning_alliance: 'blue', alliances: { red: { score: 90 }, blue: { score: 90 } } }),
      '2026cc',
    )!;
    expect(shouldWriteMatchRow(stored(tie), decided)).toBe(true);
  });
});

describe('upcomingMatchToRow', () => {
  it('uses the game-within-set number for playoff keys', () => {
    expect(
      upcomingMatchToRow({ match_key: '2026cc_sf3m1', event_key: '2026cc', team_keys: [] }),
    ).toMatchObject({ comp_level: 'sf', match_number: 1 });
  });

  it('only writes a roster when all six team keys are present', () => {
    const partial = upcomingMatchToRow({
      match_key: '2026cc_qm4',
      event_key: '2026cc',
      team_keys: ['frc1', 'frc2'],
    });
    expect(partial).not.toHaveProperty('red1');
    const full = upcomingMatchToRow({
      match_key: '2026cc_qm4',
      event_key: '2026cc',
      team_keys: ['frc1', 'frc2', 'frc3', 'frc4', 'frc5', 'frc6'],
    });
    expect(full).toMatchObject({ red1: 1, blue3: 6 });
  });

  it('ignores keys it cannot place', () => {
    expect(upcomingMatchToRow({ match_key: '2026cc_pm1', event_key: '2026cc' })).toBeNull();
    expect(upcomingMatchToRow({ event_key: '2026cc' })).toBeNull();
  });
});

describe('helpers', () => {
  it('teamNum parses frc keys and rejects junk', () => {
    expect(teamNum('frc3256')).toBe(3256);
    expect(teamNum('frc254B')).toBe(254);
    expect(teamNum('frc0')).toBeNull();
    expect(teamNum(undefined)).toBeNull();
    expect(teamNum({})).toBeNull();
  });

  it('epochToIso rejects zero, negative and non-numbers', () => {
    expect(epochToIso(0)).toBeNull();
    expect(epochToIso(-5)).toBeNull();
    expect(epochToIso('1789000000')).toBeNull();
    expect(epochToIso(Number.NaN)).toBeNull();
  });
});
