import { describe, it, expect } from 'vitest';
import {
  winDestination,
  loseDestination,
  resolveFeedTeams,
  sfSet,
  feedLabel,
  projectNextPlayoffMatch,
  ourAllianceTeams,
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

describe('projectNextPlayoffMatch (bracket projection before TBA publishes)', () => {
  const us = { red1: 3256, red2: 1678, red3: 254 };
  const won = (key: string, extra: Partial<MatchRow> = {}) =>
    m({ match_key: key, comp_level: 'sf', ...us, blue1: 118, blue2: 973, blue3: 5940, actual_red_score: 90, actual_blue_score: 70, winner: 'red', ...extra });

  it('projects the upper-bracket set after a win, opponent as the feeding winner', () => {
    const p = projectNextPlayoffMatch([won('2026evt_sf1m1')], 3256);
    expect(p).not.toBeNull();
    expect(p!.set).toBe(7);
    expect(p!.slot?.round).toBe('Upper Round 2');
    expect(p!.ours).toEqual([3256, 1678, 254]);
    expect(p!.opponent).toEqual({ kind: 'winner', set: 2 });
    expect(p!.from).toEqual({ set: 1, outcome: 'win' });
  });

  it('projects the lower-bracket drop after a loss', () => {
    const lost = m({ match_key: '2026evt_sf7m1', comp_level: 'sf', ...us, blue1: 118, blue2: 973, blue3: 5940, actual_red_score: 60, actual_blue_score: 90, winner: 'blue' });
    const p = projectNextPlayoffMatch([lost], 3256);
    expect(p!.set).toBe(9);
    expect(p!.opponent).toEqual({ kind: 'winner', set: 6 });
    expect(p!.from).toEqual({ set: 7, outcome: 'lose' });
  });

  it('projects the finals after winning the upper final (M11)', () => {
    const p = projectNextPlayoffMatch([won('2026evt_sf11m1')], 3256);
    expect(p!.isFinal).toBe(true);
    expect(p!.set).toBeNull();
    expect(p!.opponent).toEqual({ kind: 'winner', set: 13 });
  });

  it('returns null when the schedule already has our next (unplayed) row', () => {
    const rows = [won('2026evt_sf1m1'), m({ match_key: '2026evt_sf7m1', comp_level: 'sf', ...us, blue1: 1, blue2: 2, blue3: 3 })];
    expect(projectNextPlayoffMatch(rows, 3256)).toBeNull();
  });

  it('returns null once eliminated, before any playoff result, and for a tied set', () => {
    const out = m({ match_key: '2026evt_sf9m1', comp_level: 'sf', ...us, blue1: 1, blue2: 2, blue3: 3, actual_red_score: 1, actual_blue_score: 9, winner: 'blue' });
    expect(projectNextPlayoffMatch([out], 3256)).toBeNull();
    expect(projectNextPlayoffMatch([m({ match_key: '2026evt_qm1' })], 3256)).toBeNull();
    expect(projectNextPlayoffMatch([won('2026evt_sf1m1', { winner: null })], 3256)).toBeNull();
  });

  it('uses the latest decided set and picks up a published-but-empty destination row', () => {
    const empty = m({ match_key: '2026evt_sf11m1', comp_level: 'sf', scheduled_time: '2026-03-14T20:00:00Z' });
    const p = projectNextPlayoffMatch([won('2026evt_sf1m1'), won('2026evt_sf7m1'), empty], 3256);
    expect(p!.set).toBe(11);
    expect(p!.row?.scheduled_time).toBe('2026-03-14T20:00:00Z');
  });
});

describe('4-robot alliances (ourAllianceTeams / allianceTeams roster)', () => {
  // Chezy Champs 2026: 3256 is the 4th robot of Alliance 4 and sits out M2 —
  // the schedule row only lists the three robots on the field.
  const alliances = [[4414, 2910, 2073, 9023], [9408, 5940, 9470, 9128], [254, 581, 694, 841], [2813, 6800, 1540, 3256]];

  it('ourAllianceTeams returns the full roster, or [baseTeam] when unknown', () => {
    expect(ourAllianceTeams(alliances, 3256)).toEqual([2813, 6800, 1540, 3256]);
    expect(ourAllianceTeams(alliances, 1114)).toEqual([1114]);
    expect(ourAllianceTeams(null, 3256)).toEqual([3256]);
  });

  it('projects our next set through our partners when we are not on the field', () => {
    const wonM2 = m({ match_key: '2026evt_sf2m1', comp_level: 'sf', red1: 6800, red2: 2813, red3: 1540, blue1: 1678, blue2: 5026, blue3: 6665, actual_red_score: 90, actual_blue_score: 60, winner: 'red' });
    expect(projectNextPlayoffMatch([wonM2], 3256)).toBeNull(); // base team alone can't see it
    const p = projectNextPlayoffMatch([wonM2], 3256, ourAllianceTeams(alliances, 3256));
    expect(p?.set).toBe(7);
    expect(p?.from).toEqual({ set: 2, outcome: 'win' });
    expect(p?.ours).toEqual([6800, 2813, 1540]);
  });
});
