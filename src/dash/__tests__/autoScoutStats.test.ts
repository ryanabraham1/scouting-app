import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { matchProgress, type AutoScoutJob, type AutoScoutResultRow } from '../autoScoutClient';
import { autoFuelByTeam, teamAutoScout } from '../autoScoutStats';

function row(key: string, fuel: number, confidence = 1): AutoScoutResultRow {
  return {
    match_key: key,
    job_id: null,
    imported_at: '',
    identity_conf: { red0: confidence },
    teams: {
      '3256': {
        alliance: 'red', station: 1, fuel_scored: fuel, fuel_scored_auto: 10, fuel_scored_teleop: fuel - 10,
        fuel_fed: 4, auto_tower: 'None', endgame_tower: 'L3',
      },
    },
  };
}

function job(extra: Partial<AutoScoutJob>): AutoScoutJob {
  return {
    id: 'j', event_key: '2026cc', kind: 'matches', match_keys: [], source_url: null, stream_starts: {},
    force: false, scout: true, status: 'running', cancel_requested: false, completed_matches: [],
    match_errors: {}, progress: {}, error: null, created_at: '2026-09-19T16:00:00Z', ...extra,
  };
}

describe('team estimates', () => {
  it('averages a team across matches, in match order', () => {
    const summary = teamAutoScout([row('2026cc_qm10', 40), row('2026cc_qm9', 20)], 3256);
    expect(summary?.matches.map((m) => m.matchKey)).toEqual(['2026cc_qm9', '2026cc_qm10']);
    expect(summary?.avgFuel).toBe(30);
    expect(summary?.matches[0].autoTower).toBeNull();
    expect(summary?.matches[0].endgameTower).toBe('L3');
  });

  it('shows but does not average a match with a doubtful robot identity', () => {
    const summary = teamAutoScout([row('2026cc_qm1', 20), row('2026cc_qm2', 900, 0.3)], 3256);
    expect(summary?.matches).toHaveLength(2);
    expect(summary?.matches[1].lowConfidence).toBe(true);
    expect(summary?.avgFuel).toBe(20);
  });

  it('has nothing to show for a team without results', () => {
    expect(teamAutoScout([row('2026cc_qm1', 20)], 254)).toBeNull();
    expect(teamAutoScout(undefined, 254)).toBeNull();
  });

  it('builds the ranking column', () => {
    expect(autoFuelByTeam([row('2026cc_qm1', 20), row('2026cc_qm2', 40)]).get(3256)).toBe(30);
  });
});

describe('match progress', () => {
  const phase = (key: string, jobs: AutoScoutJob[], results: { match_key: string }[] = [], actual?: string) =>
    matchProgress([{ match_key: key, actual_time: actual }], jobs, results)[0];
  const K = '2026cc_qm1';

  it('follows a match through a job', () => {
    expect(phase(K, []).phase).toBe('upcoming');
    expect(phase(K, [], [], '2026-09-19T15:00:00Z').phase).toBe('played');
    expect(phase(K, [job({ match_keys: [K] })]).phase).toBe('queued');
    const working = phase(K, [job({ match_keys: [K], progress: { match_key: K, pct: 42, stage: 'frames' } })]);
    expect(working).toMatchObject({ phase: 'processing', pct: 42, detail: 'frames' });
    expect(phase(K, [job({ status: 'succeeded', completed_matches: [K] })], [{ match_key: K }]).phase).toBe('done');
  });

  it('follows a match through a live job', () => {
    const live = job({ kind: 'live' });
    expect(phase(K, [live], [], '2026-09-19T15:00:00Z').phase).toBe('played'); // before recording
    expect(phase(K, [live], [], '2026-09-19T17:00:00Z').phase).toBe('waiting');
    expect(phase(K, [job({ kind: 'live', progress: { queued: [K] } })]).phase).toBe('queued');
    expect(phase(K, [job({ kind: 'live', progress: { clipped: [K] } })]).phase).toBe('clipped');
  });

  it('gives the reason a match was skipped', () => {
    const skipped = phase(K, [job({ status: 'succeeded', match_errors: { [K]: 'The stream dropped' } })]);
    expect(skipped).toMatchObject({ phase: 'skipped', detail: 'The stream dropped' });
  });

  it('a finished match outranks an old skip, and a rerun outranks finished', () => {
    const old = job({ status: 'failed', match_errors: { [K]: 'nope' } });
    expect(phase(K, [old], [{ match_key: K }]).phase).toBe('done');
    expect(phase(K, [job({ match_keys: [K] }), old], [{ match_key: K }]).phase).toBe('queued');
  });
});
