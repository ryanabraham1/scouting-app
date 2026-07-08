// src/dash/__tests__/nextMatch.test.ts
import { describe, it, expect } from 'vitest';
import {
  isUnplayedMatch,
  nextMatchForTeam,
  matchRowForNexus,
  trackedNextMatch,
  lastMatchForTeam,
  lastMatchOverall,
} from '@/dash/nextMatch';
import type { MatchRow } from '@/dash/useEventData';
import type { NexusEventStatus, NexusMatch } from '@/dash/nexusClient';

const OURS = 3256;

/** Minimal MatchRow factory; override per test. */
function match(overrides: Partial<MatchRow>): MatchRow {
  return {
    match_key: '2026evt_qm1',
    event_key: '2026evt',
    comp_level: 'qm',
    match_number: 1,
    scheduled_time: null,
    red1: 111,
    red2: 222,
    red3: 333,
    blue1: 444,
    blue2: 555,
    blue3: 666,
    actual_red_score: null,
    actual_blue_score: null,
    winner: null,
    result_synced_at: null,
    ...overrides,
  };
}

/** Minimal NexusMatch factory. */
function nexusMatch(overrides: Partial<NexusMatch>): NexusMatch {
  return {
    label: 'Qualification 1',
    status: null,
    redTeams: [],
    blueTeams: [],
    times: {
      estimatedQueueTime: null,
      estimatedOnDeckTime: null,
      estimatedOnFieldTime: null,
      estimatedStartTime: null,
      actualQueueTime: null,
      actualOnFieldTime: null,
    },
    ...overrides,
  };
}

function status(upcoming: NexusMatch[]): NexusEventStatus {
  return {
    eventKey: '2026evt',
    dataAsOfTime: null,
    nowQueuing: null,
    onField: null,
    queuing: null,
    matches: upcoming,
    upcoming,
  };
}

describe('isUnplayedMatch', () => {
  it('is true only when no score, winner, or synced result', () => {
    expect(isUnplayedMatch(match({}))).toBe(true);
    expect(isUnplayedMatch(match({ actual_red_score: 50, actual_blue_score: 40 }))).toBe(false);
    expect(isUnplayedMatch(match({ winner: 'red' }))).toBe(false);
    expect(isUnplayedMatch(match({ result_synced_at: '2026-06-25T00:00:00Z' }))).toBe(false);
  });
});

describe('nextMatchForTeam', () => {
  it('returns the earliest unplayed match including the team', () => {
    const matches = [
      match({ match_key: 'qm1', match_number: 1, red1: OURS, actual_red_score: 10, actual_blue_score: 5 }), // played
      match({ match_key: 'qm2', match_number: 2, red1: 999 }), // unplayed, not ours
      match({ match_key: 'qm3', match_number: 3, blue2: OURS }), // unplayed, ours
      match({ match_key: 'qm5', match_number: 5, red1: OURS }), // later, ours
    ];
    expect(nextMatchForTeam(matches, OURS)?.match_key).toBe('qm3');
  });

  it('orders by comp level then number (qm before sf before f)', () => {
    const matches = [
      match({ match_key: 'f1', comp_level: 'f', match_number: 1, red1: OURS }),
      match({ match_key: 'sf2', comp_level: 'sf', match_number: 2, red1: OURS }),
      match({ match_key: 'qm9', comp_level: 'qm', match_number: 9, red1: OURS }),
    ];
    expect(nextMatchForTeam(matches, OURS)?.match_key).toBe('qm9');
  });

  it('returns null when the team has no scheduled unplayed match', () => {
    const matches = [
      match({ match_key: 'qm1', match_number: 1, red1: OURS, actual_red_score: 1, actual_blue_score: 2 }),
      match({ match_key: 'qm2', match_number: 2, red1: 999 }),
    ];
    expect(nextMatchForTeam(matches, OURS)).toBeNull();
  });
});

describe('matchRowForNexus', () => {
  it('maps a Nexus "Qualification N" label to the schedule MatchRow', () => {
    const matches = [
      match({ match_key: 'qm12', comp_level: 'qm', match_number: 12 }),
      match({ match_key: 'qm2', comp_level: 'qm', match_number: 2 }),
    ];
    const nm = nexusMatch({ label: 'Qualification 12' });
    expect(matchRowForNexus(matches, nm)?.match_key).toBe('qm12');
  });

  it('returns null when no schedule row matches', () => {
    const matches = [match({ match_key: 'qm1', match_number: 1 })];
    expect(matchRowForNexus(matches, nexusMatch({ label: 'Qualification 99' }))).toBeNull();
  });
});

describe('matchRowForNexus (playoffs)', () => {
  const matches = [
    match({ match_key: '2026evt_qm5', comp_level: 'qm', match_number: 5 }),
    match({ match_key: '2026evt_sf3m1', comp_level: 'sf', match_number: 1 }),
    match({ match_key: '2026evt_sf8m1', comp_level: 'sf', match_number: 1 }),
    match({ match_key: '2026evt_f1m1', comp_level: 'f', match_number: 1 }),
    match({ match_key: '2026evt_f1m2', comp_level: 'f', match_number: 2 }),
  ];
  it('maps "Final 2" to the second final game', () => {
    expect(matchRowForNexus(matches, nexusMatch({ label: 'Final 2' }))?.match_key).toBe('2026evt_f1m2');
  });
  it('maps "Semifinal 3" to the sf set-3 row', () => {
    expect(matchRowForNexus(matches, nexusMatch({ label: 'Semifinal 3' }))?.match_key).toBe('2026evt_sf3m1');
  });
  it('maps "Playoff 8" (double-elim bracket position) to sf set 8', () => {
    expect(matchRowForNexus(matches, nexusMatch({ label: 'Playoff 8' }))?.match_key).toBe('2026evt_sf8m1');
  });
  it('keeps quals mapping to qm rows (no playoff cross-talk)', () => {
    expect(matchRowForNexus(matches, nexusMatch({ label: 'Qualification 5' }))?.match_key).toBe('2026evt_qm5');
  });
});

describe('lastMatchForTeam / lastMatchOverall', () => {
  const matches = [
    match({ match_key: '2026evt_qm2', comp_level: 'qm', match_number: 2, red1: OURS }),
    match({ match_key: '2026evt_qm7', comp_level: 'qm', match_number: 7, blue1: OURS }),
    match({ match_key: '2026evt_sf3m1', comp_level: 'sf', match_number: 1, red1: OURS }),
    match({ match_key: '2026evt_f1m1', comp_level: 'f', match_number: 1 }), // not ours (defaults)
  ];
  it('returns OUR latest match by play order (sf after qm)', () => {
    expect(lastMatchForTeam(matches, OURS)?.match_key).toBe('2026evt_sf3m1');
  });
  it('returns the event last match overall', () => {
    expect(lastMatchOverall(matches)?.match_key).toBe('2026evt_f1m1');
  });
  it('returns null when the team has no matches', () => {
    expect(lastMatchForTeam([], OURS)).toBeNull();
    expect(lastMatchOverall([])).toBeNull();
  });
});

describe('trackedNextMatch', () => {
  const matches = [
    match({ match_key: 'qm2', comp_level: 'qm', match_number: 2, red1: OURS }),
    match({ match_key: 'qm4', comp_level: 'qm', match_number: 4, blue1: OURS }),
    match({ match_key: 'qm7', comp_level: 'qm', match_number: 7, red2: OURS }),
  ];

  it('falls back to the schedule when Nexus status is null (unavailable)', () => {
    expect(trackedNextMatch(matches, OURS, null)?.match_key).toBe('qm2');
  });

  it('prefers the live Nexus next match for our team when available', () => {
    // Nexus says qm4 is our next upcoming (qm2 already done on the field).
    const st = status([
      nexusMatch({ label: 'Qualification 4', redTeams: [123], blueTeams: [OURS, 1, 2] }),
      nexusMatch({ label: 'Qualification 7', redTeams: [OURS], blueTeams: [] }),
    ]);
    expect(trackedNextMatch(matches, OURS, st)?.match_key).toBe('qm4');
  });

  it('skips a played match Nexus still lists at the head of upcoming (live-path stick fix)', () => {
    // Nexus left Qual 2 flagged "On field" and never marked it Completed, so it
    // lingers first in `upcoming`. The webhook already wrote qm2's result, so we
    // must NOT pin to it — advance to qm4.
    const playedMatches = [
      match({
        match_key: 'qm2',
        comp_level: 'qm',
        match_number: 2,
        red1: OURS,
        actual_red_score: 50,
        actual_blue_score: 40,
        winner: 'red',
      }),
      match({ match_key: 'qm4', comp_level: 'qm', match_number: 4, blue1: OURS }),
    ];
    const st = status([
      nexusMatch({ label: 'Qualification 2', redTeams: [OURS, 1, 2], blueTeams: [3, 4, 5] }),
      nexusMatch({ label: 'Qualification 4', redTeams: [8, 9, 10], blueTeams: [OURS, 6, 7] }),
    ]);
    expect(trackedNextMatch(playedMatches, OURS, st)?.match_key).toBe('qm4');
  });

  it('skips Nexus upcoming matches that do not include our team', () => {
    const st = status([
      nexusMatch({ label: 'Qualification 3', redTeams: [9], blueTeams: [8] }),
      nexusMatch({ label: 'Qualification 7', redTeams: [OURS], blueTeams: [] }),
    ]);
    expect(trackedNextMatch(matches, OURS, st)?.match_key).toBe('qm7');
  });

  it('falls back to the schedule when the Nexus match cannot be resolved to a row', () => {
    const st = status([nexusMatch({ label: 'Qualification 99', redTeams: [OURS] })]);
    expect(trackedNextMatch(matches, OURS, st)?.match_key).toBe('qm2');
  });

  it('advances past an OUR match Nexus still flags "On field" when a later unplayed match exists (BUG-6)', () => {
    // qm2 is OURS and unplayed IN THE DB (its result-sync was dropped), but Nexus
    // reports it as the live frontier (still "On field", never flipped to
    // Completed). Without the frontier guard, trackedNextMatch returned qm2 (the
    // match we already played) while the Upcoming rail correctly advanced to qm4.
    const playedFrontier = [
      match({ match_key: 'qm2', comp_level: 'qm', match_number: 2, red1: OURS }),
      match({ match_key: 'qm4', comp_level: 'qm', match_number: 4, blue1: OURS }),
    ];
    const onFieldNm = nexusMatch({
      label: 'Qualification 2',
      status: 'On field',
      redTeams: [OURS, 1, 2],
      blueTeams: [3, 4, 5],
    });
    const nextNm = nexusMatch({
      label: 'Qualification 4',
      redTeams: [8, 9, 10],
      blueTeams: [OURS, 6, 7],
    });
    const st: NexusEventStatus = {
      eventKey: '2026evt',
      dataAsOfTime: null,
      nowQueuing: 'Qualification 2',
      onField: onFieldNm,
      queuing: nextNm,
      matches: [onFieldNm, nextNm],
      upcoming: [onFieldNm, nextNm],
    };
    expect(trackedNextMatch(playedFrontier, OURS, st)?.match_key).toBe('qm4');
  });
});
