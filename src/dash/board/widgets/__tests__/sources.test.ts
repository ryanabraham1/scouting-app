import { describe, expect, it } from 'vitest';
import { sourceRecords } from '../sources';
import type { BoardData } from '../data';

const data = {
  eventKey: '2026test', baseTeam: 3256,
  teams: [{ team_number: 254, nickname: 'Cheesy' }, { team_number: 3256, nickname: 'WarriorBorgs' }],
  matches: [{ match_key: '2026test_qm1', red1: 254, blue1: 3256 }, { match_key: '2026test_qm2', red1: 971, blue1: 604 }],
  reports: [
    { id: 'a', target_team_number: 254, match_key: '2026test_qm1', notes: 'Protect the lane', auto_path: null, deleted: false },
    { id: 'b', target_team_number: 3256, match_key: '2026test_qm1', notes: 'Observed no movement', auto_path: [], deleted: false },
    { id: 'deleted', target_team_number: 254, notes: 'Deleted', deleted: true },
  ],
  pits: new Map([[254, { teamNumber: 254, drivetrain: 'swerve' }]]),
  strategyNotes: new Map([['2026test:-1:254', 'Defend the feed']]),
  agg: new Map([[254, { matchesScouted: 2, diedRate: 0 }]]), standings: new Map(), picklist: [], scouts: [], assignments: [],
} as unknown as BoardData;

describe('live app data sources', () => {
  it('filters reports by team and match and excludes deleted data', () => {
    expect(sourceRecords(data, { source: 'reports', team: 254, match: 'qm1' }).map((r) => r.key)).toEqual(['a']);
    expect(sourceRecords(data, { source: 'reports', team: 'base' }).map((r) => r.key)).toEqual(['b']);
  });
  it('includes scout and strategy notes, preserving their origins', () => {
    const rows = sourceRecords(data, { source: 'notes', team: 254 });
    expect(rows.map((r) => r.row.note)).toEqual(['Protect the lane', 'Defend the feed']);
  });
  it('can pin any field of one record while retaining unknown vs observed-empty paths', () => {
    expect(sourceRecords(data, { source: 'reports', record: 'a' })[0].row.auto_path).toBeNull();
    expect(sourceRecords(data, { source: 'reports', record: 'b' })[0].row.auto_path).toEqual([]);
    expect(sourceRecords(data, { source: 'aggregates', team: 254, record: '254' })[0].row.diedRate).toBe(0);
  });
  it('a team schedule matches either alliance instead of just one station', () => {
    expect(sourceRecords(data, { source: 'matches', team: 'base' }).map((r) => r.key)).toEqual(['2026test_qm1']);
  });
});
