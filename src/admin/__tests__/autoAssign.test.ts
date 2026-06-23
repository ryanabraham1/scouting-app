import { describe, it, expect } from 'vitest';
import { slotsForMatch, autoAssign } from '../autoAssign';
import type { AssignMatch, AssignScout, AssignOptions, Assignment } from '../types';

const m1: AssignMatch = {
  matchKey: '2026casnv_qm1',
  redTeams: [3256, 254, 1678],
  blueTeams: [9999, 1323, 604],
};

describe('slotsForMatch', () => {
  it('returns all 6 slots when ownTeam is absent', () => {
    const m: AssignMatch = {
      matchKey: '2026casnv_qm2',
      redTeams: [11, 22, 33],
      blueTeams: [44, 55, 66],
    };
    const slots = slotsForMatch(m, 3256);
    expect(slots).toEqual([
      { allianceColor: 'red', station: 1, targetTeamNumber: 11 },
      { allianceColor: 'red', station: 2, targetTeamNumber: 22 },
      { allianceColor: 'red', station: 3, targetTeamNumber: 33 },
      { allianceColor: 'blue', station: 1, targetTeamNumber: 44 },
      { allianceColor: 'blue', station: 2, targetTeamNumber: 55 },
      { allianceColor: 'blue', station: 3, targetTeamNumber: 66 },
    ]);
  });

  it('omits exactly the slot whose targetTeamNumber === ownTeam (3256)', () => {
    const slots = slotsForMatch(m1, 3256);
    expect(slots).toHaveLength(5);
    expect(slots.some((s) => s.targetTeamNumber === 3256)).toBe(false);
    expect(slots).toEqual([
      { allianceColor: 'red', station: 2, targetTeamNumber: 254 },
      { allianceColor: 'red', station: 3, targetTeamNumber: 1678 },
      { allianceColor: 'blue', station: 1, targetTeamNumber: 9999 },
      { allianceColor: 'blue', station: 2, targetTeamNumber: 1323 },
      { allianceColor: 'blue', station: 3, targetTeamNumber: 604 },
    ]);
  });
});

// 12 matches, ownTeam 3256 placed in red station 1 of EVERY match (so exactly 5 slots/match = 60 slots).
function buildMatches(): AssignMatch[] {
  const matches: AssignMatch[] = [];
  for (let i = 1; i <= 12; i++) {
    const base = 100 + i * 10;
    matches.push({
      matchKey: `2026casnv_qm${i}`,
      redTeams: [3256, base + 1, base + 2],
      blueTeams: [base + 3, base + 4, base + 5],
    });
  }
  return matches;
}

function buildScouts(n: number): AssignScout[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    displayName: `Scout ${i + 1}`,
  }));
}

const OPTS: AssignOptions = { ownTeam: 3256, breakEveryN: 0, rotatePositions: false };

describe('autoAssign', () => {
  it('(a) never assigns the 3256 slot', () => {
    const out = autoAssign(buildMatches(), buildScouts(6), OPTS);
    expect(out.some((a) => a.targetTeamNumber === 3256)).toBe(false);
    // 12 matches * 5 slots = 60, 6 scouts always eligible -> all 60 filled
    expect(out).toHaveLength(60);
  });

  it('(b) balances assignments within ±1 across scouts', () => {
    const scouts = buildScouts(6);
    const out = autoAssign(buildMatches(), scouts, OPTS);
    const counts = scouts.map((s) => out.filter((a) => a.scoutId === s.id).length);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    expect(max - min).toBeLessThanOrEqual(1);
    // 60 slots / 6 scouts = exactly 10 each
    expect(counts).toEqual([10, 10, 10, 10, 10, 10]);
  });

  it('(c) respects unavailableMatchKeys (no slot in that match for that scout)', () => {
    const scouts = buildScouts(6);
    scouts[0].unavailableMatchKeys = ['2026casnv_qm1', '2026casnv_qm2'];
    const out = autoAssign(buildMatches(), scouts, OPTS);
    const s1InQm1 = out.filter((a) => a.scoutId === 's1' && a.matchKey === '2026casnv_qm1');
    const s1InQm2 = out.filter((a) => a.scoutId === 's1' && a.matchKey === '2026casnv_qm2');
    expect(s1InQm1).toHaveLength(0);
    expect(s1InQm2).toHaveLength(0);
  });

  it('(d) is deterministic (same inputs -> identical output)', () => {
    const a = autoAssign(buildMatches(), buildScouts(6), OPTS);
    const b = autoAssign(buildMatches(), buildScouts(6), OPTS);
    expect(a).toEqual(b);
  });
});

describe('autoAssign break cadence', () => {
  // Helper: longest run of consecutive matches (in match order) a scout is assigned to.
  function longestStreak(out: Assignment[], matches: AssignMatch[], scoutId: string): number {
    let best = 0;
    let cur = 0;
    for (const m of matches) {
      const worked = out.some((a) => a.matchKey === m.matchKey && a.scoutId === scoutId);
      if (worked) {
        cur += 1;
        best = Math.max(best, cur);
      } else {
        cur = 0;
      }
    }
    return best;
  }

  it('(e) no scout exceeds breakEveryN consecutive assignments', () => {
    const matches = buildMatches(); // 12 matches, 5 slots each
    const scouts = buildScouts(6);
    const opts: AssignOptions = { ownTeam: 3256, breakEveryN: 2, rotatePositions: false };
    const out = autoAssign(matches, scouts, opts);
    for (const s of scouts) {
      expect(longestStreak(out, matches, s.id)).toBeLessThanOrEqual(2);
    }
    // Sanity: still produced assignments and never touched 3256.
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((a) => a.targetTeamNumber === 3256)).toBe(false);
  });
});
