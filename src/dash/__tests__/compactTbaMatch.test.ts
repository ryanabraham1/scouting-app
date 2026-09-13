import { describe, expect, it } from 'vitest';
import { compactTbaMatch } from '../seasonEpa';
import { tbaMatchesToRows } from '../localEpa';
import { seasonRecordFromTbaMatches } from '../SeasonStats';

const raw = {
  key: '2026casnv_qm3',
  event_key: '2026casnv',
  comp_level: 'qm',
  set_number: 1,
  match_number: 3,
  winning_alliance: 'red',
  actual_time: 1_700_000_000,
  predicted_time: 1_700_000_100,
  time: 1_699_999_900,
  videos: [{ type: 'youtube', key: 'abc' }],
  post_result_time: 1_700_000_200,
  alliances: {
    red: { score: 120, team_keys: ['frc254', 'frc1678', 'frc3256'], surrogate_team_keys: [], dq_team_keys: [] },
    blue: { score: 90, team_keys: ['frc971', 'frc118', 'frc148'], surrogate_team_keys: [], dq_team_keys: [] },
  },
  score_breakdown: {
    red: { foulPoints: 5, adjustPoints: 0, autoPoints: 30, endGamePoints: 20, rp: 3, big: 'x'.repeat(2000) },
    blue: { foulPoints: 0, adjustPoints: 2, autoPoints: 20, endGamePoints: 10, rp: 1, big: 'y'.repeat(2000) },
  },
};

describe('compactTbaMatch', () => {
  it('drops the payload bulk but keeps every field the EPA/record paths read', () => {
    const compact = compactTbaMatch(raw) as Record<string, unknown>;
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(raw).length / 5);
    expect(compact).not.toHaveProperty('videos');
    expect(compact).toEqual({
      key: '2026casnv_qm3',
      event_key: '2026casnv',
      comp_level: 'qm',
      set_number: 1,
      match_number: 3,
      winning_alliance: 'red',
      actual_time: 1_700_000_000,
      predicted_time: 1_700_000_100,
      time: 1_699_999_900,
      alliances: {
        red: { score: 120, team_keys: ['frc254', 'frc1678', 'frc3256'] },
        blue: { score: 90, team_keys: ['frc971', 'frc118', 'frc148'] },
      },
      score_breakdown: {
        red: { foulPoints: 5, adjustPoints: 0 },
        blue: { foulPoints: 0, adjustPoints: 2 },
      },
    });
  });

  it('is transparent to the row conversion and the season record', () => {
    expect(tbaMatchesToRows([compactTbaMatch(raw)])).toEqual(tbaMatchesToRows([raw]));
    expect(seasonRecordFromTbaMatches([compactTbaMatch(raw)], 3256)).toBe(
      seasonRecordFromTbaMatches([raw], 3256),
    );
  });

  it('passes non-object entries through untouched', () => {
    expect(compactTbaMatch(null)).toBeNull();
    expect(compactTbaMatch('junk')).toBe('junk');
  });
});
