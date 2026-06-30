import { describe, it, expect } from 'vitest';
import {
  winDestination,
  loseDestination,
  resolveFeedTeams,
  sfSet,
  feedLabel,
} from '@/dash/playoffModel';
import type { MatchRow } from '@/dash/useEventData';

function m(over: Partial<MatchRow>): MatchRow {
  return {
    match_key: '2026evt_qm1', event_key: '2026evt', comp_level: 'qm', match_number: 1,
    scheduled_time: null, red1: null, red2: null, red3: null, blue1: null, blue2: null, blue3: null,
    actual_red_score: null, actual_blue_score: null, winner: null, result_synced_at: null, ...over,
  };
}

describe('playoffModel destinations (FRC 8-alliance double elim)', () => {
  it('upper round 1 winner advances to round 2, loser drops to lower round 1', () => {
    const w = winDestination(1);
    expect(w).toMatchObject({ kind: 'set' });
    if (w.kind === 'set') {
      expect(w.slot.set).toBe(7); // M1 winner → M7
      expect(w.opponent).toEqual({ kind: 'winner', set: 2 }); // faces winner of M2
    }
    const l = loseDestination(1);
    expect(l).toMatchObject({ kind: 'set' });
    if (l.kind === 'set') expect(l.slot.set).toBe(5); // M1 loser → M5
  });

  it('lower round 1 loser is eliminated', () => {
    expect(loseDestination(5).kind).toBe('eliminated');
  });

  it('upper final (M11): winner to finals, loser to the lower final (M13)', () => {
    expect(winDestination(11)).toEqual({ kind: 'finals', opponent: { kind: 'winner', set: 13 } });
    const l = loseDestination(11);
    expect(l).toMatchObject({ kind: 'set' });
    if (l.kind === 'set') expect(l.slot.set).toBe(13);
  });

  it('lower final (M13): winner to finals, loser eliminated', () => {
    expect(winDestination(13)).toEqual({ kind: 'finals', opponent: { kind: 'winner', set: 11 } });
    expect(loseDestination(13).kind).toBe('eliminated');
  });

  it('parses the sf set from the key tail (not match_number)', () => {
    expect(sfSet(m({ match_key: '2026evt_sf3m1', comp_level: 'sf', match_number: 1 }))).toBe(3);
    expect(sfSet(m({ match_key: '2026evt_sf12m1', comp_level: 'sf', match_number: 1 }))).toBe(12);
  });

  it('resolves a winner/loser feed to real teams once the match is decided', () => {
    const bySet = new Map<number, MatchRow>([
      [8, m({ comp_level: 'sf', red1: 148, red2: 217, red3: 1114, blue1: 27, blue2: 469, blue3: 2046, actual_red_score: 90, actual_blue_score: 70, winner: 'red' })],
    ]);
    expect(resolveFeedTeams({ kind: 'winner', set: 8 }, bySet)).toEqual([148, 217, 1114]);
    expect(resolveFeedTeams({ kind: 'loser', set: 8 }, bySet)).toEqual([27, 469, 2046]);
    // Undecided / absent → null (caller shows the feed label instead).
    expect(resolveFeedTeams({ kind: 'winner', set: 9 }, bySet)).toBeNull();
  });

  it('labels feeds for humans', () => {
    expect(feedLabel({ kind: 'winner', set: 8 })).toBe('Winner of M8');
    expect(feedLabel({ kind: 'loser', set: 11 })).toBe('Loser of M11');
    expect(feedLabel({ kind: 'seed', n: 3 })).toBe('Alliance 3');
  });
});
