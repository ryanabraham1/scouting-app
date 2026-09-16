import { describe, it, expect } from 'vitest';
import { slotsForMatch, autoAssign, autoAssignPlan, coveredMatchIndexes } from '../autoAssign';
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

  it('drops empty alliance slots (null/NaN team numbers)', () => {
    const m: AssignMatch = {
      matchKey: '2026caetb_qm1',
      // e.g. an incomplete schedule where some alliance slots have no team.
      redTeams: [254, null as unknown as number, 1678],
      blueTeams: [NaN as unknown as number, 200, 300],
    };
    const slots = slotsForMatch(m, 3256);
    expect(slots.map((s) => s.targetTeamNumber)).toEqual([254, 1678, 200, 300]);
    expect(slots.every((s) => Number.isFinite(s.targetTeamNumber))).toBe(true);
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
function buildMatches(count = 12): AssignMatch[] {
  const matches: AssignMatch[] = [];
  for (let i = 1; i <= count; i++) {
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

const OPTS: AssignOptions = { ownTeam: 3256, rotatePositions: false };

describe('autoAssign', () => {
  it('(a) never assigns the 3256 slot', () => {
    const out = autoAssign(buildMatches(), buildScouts(6), OPTS);
    expect(out.some((a) => a.targetTeamNumber === 3256)).toBe(false);
    // 12 matches * 5 slots = 60, 6 scouts always eligible -> all 60 filled
    expect(out).toHaveLength(60);
  });

  it('(a2) covers EVERY match when the scout pool equals the slots/match', () => {
    const matches = buildMatches();
    const out = autoAssign(matches, buildScouts(5), {
      ownTeam: 3256,
      rotatePositions: true,
    });
    for (const m of matches) {
      const filled = out.filter((a) => a.matchKey === m.matchKey).length;
      expect(filled).toBe(5); // all five non-own-team slots covered
    }
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

describe('autoAssign quals-only', () => {
  it('returns nothing for a playoff-only match list', () => {
    const playoffs: AssignMatch[] = [
      { matchKey: '2026casnv_sf1', redTeams: [11, 22, 33], blueTeams: [44, 55, 66] },
      { matchKey: '2026casnv_sf2m1', redTeams: [11, 22, 33], blueTeams: [44, 55, 66] },
      { matchKey: '2026casnv_f1m1', redTeams: [11, 22, 33], blueTeams: [44, 55, 66] },
    ];
    const out = autoAssign(playoffs, buildScouts(6), OPTS);
    expect(out).toHaveLength(0);
  });

  it('assigns ONLY the qualification matches when quals + playoffs are mixed', () => {
    const mixed: AssignMatch[] = [
      { matchKey: '2026casnv_qm1', redTeams: [11, 22, 33], blueTeams: [44, 55, 66] },
      { matchKey: '2026casnv_sf1', redTeams: [11, 22, 33], blueTeams: [44, 55, 66] },
      { matchKey: '2026casnv_qm2', redTeams: [11, 22, 33], blueTeams: [44, 55, 66] },
      { matchKey: '2026casnv_f1m1', redTeams: [11, 22, 33], blueTeams: [44, 55, 66] },
    ];
    const out = autoAssign(mixed, buildScouts(6), OPTS);
    const assignedMatchKeys = new Set(out.map((a) => a.matchKey));
    expect([...assignedMatchKeys].sort()).toEqual(['2026casnv_qm1', '2026casnv_qm2']);
    // 2 quals * 6 slots = 12 (no own-team here).
    expect(out).toHaveLength(12);
    expect(out.some((a) => a.matchKey.includes('sf') || a.matchKey.includes('f1'))).toBe(false);
  });
});

describe('autoAssign work/rest blocks', () => {
  function workedMatchIndexes(
    out: Assignment[],
    matches: AssignMatch[],
    scoutId: string,
  ): number[] {
    const idxOf = new Map(matches.map((m, i) => [m.matchKey, i]));
    return out
      .filter((a) => a.scoutId === scoutId)
      .map((a) => idxOf.get(a.matchKey) as number)
      .sort((a, b) => a - b);
  }

  it('(f) accepts avoidBackToBack:false without degrading coverage or balance', () => {
    // The flag only relaxes a soft tiebreak; correctness (full coverage, ±1
    // balance, never scouting own team) must hold whether it's on or off.
    const matches = buildMatches(); // 12 matches, 5 slots each = 60 slots
    const scouts = buildScouts(6);
    const out = autoAssign(matches, scouts, {
      ownTeam: 3256,
      rotatePositions: false,
      avoidBackToBack: false,
    });
    expect(out).toHaveLength(60);
    expect(out.some((a) => a.targetTeamNumber === 3256)).toBe(false);
    const counts = scouts.map((s) => out.filter((a) => a.scoutId === s.id).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('counts spaced assignments toward the block and accepts spacing values above 1', () => {
    const matches = buildMatches(24);
    const scouts = buildScouts(25);
    const blockAssignments = 2;
    const spacingMatches = 3;
    const breakLength = 4;
    const plan = autoAssignPlan(matches, scouts, {
      ownTeam: 3256,
      rotatePositions: false,
      scheduleMode: 'blocked',
      blockAssignments,
      spacingMatches,
      breakLength,
    });

    expect(plan.assignments).toHaveLength(24 * 5);
    expect(plan.relaxedMatchKeys).toEqual([]);
    const loads = scouts.map(
      (s) => plan.assignments.filter((assignment) => assignment.scoutId === s.id).length,
    );
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(blockAssignments);
    for (const s of scouts) {
      const worked = workedMatchIndexes(plan.assignments, matches, s.id);
      for (let i = 1; i < worked.length; i++) {
        const previousCompletedBlock = i % blockAssignments === 0;
        const minimumGap = (previousCompletedBlock ? breakLength : spacingMatches) + 1;
        expect(worked[i] - worked[i - 1]).toBeGreaterThanOrEqual(minimumGap);
      }
    }
  });

  it('uses consecutive assignments when spacing is 0, then honors the longer break', () => {
    const matches = buildMatches(18);
    const scouts = buildScouts(15);
    const plan = autoAssignPlan(matches, scouts, {
      ownTeam: 3256,
      rotatePositions: false,
      scheduleMode: 'blocked',
      blockAssignments: 2,
      spacingMatches: 0,
      breakLength: 3,
    });
    expect(plan.relaxedMatchKeys).toEqual([]);
    for (const s of scouts) {
      const worked = workedMatchIndexes(plan.assignments, matches, s.id);
      for (let i = 1; i < worked.length; i++) {
        expect(worked[i] - worked[i - 1]).toBeGreaterThanOrEqual(i % 2 === 0 ? 4 : 1);
      }
    }
  });

  it('relaxes blocked preferences instead of leaving seats empty when staffing is tight', () => {
    const matches = buildMatches();
    const plan = autoAssignPlan(matches, buildScouts(5), {
      ownTeam: 3256,
      rotatePositions: false,
      scheduleMode: 'blocked',
      blockAssignments: 2,
      spacingMatches: 3,
      breakLength: 4,
    });
    expect(plan.assignments).toHaveLength(60);
    expect(plan.relaxedMatchKeys.length).toBeGreaterThan(0);
    expect(plan.assignments.some((a) => a.targetTeamNumber === 3256)).toBe(false);
  });
});

describe('autoAssign partial coverage (coveragePercent)', () => {
  it('coveredMatchIndexes spreads the covered matches evenly and clamps the percent', () => {
    expect([...coveredMatchIndexes(10, 50)]).toEqual([0, 2, 4, 6, 8]);
    expect([...coveredMatchIndexes(10, 30)]).toEqual([0, 3, 6]);
    expect([...coveredMatchIndexes(12, 25)]).toEqual([0, 4, 8]);
    expect([...coveredMatchIndexes(10, 100)]).toHaveLength(10);
    expect([...coveredMatchIndexes(10, 150)]).toHaveLength(10);
    expect([...coveredMatchIndexes(10, 0)]).toHaveLength(0);
    expect([...coveredMatchIndexes(10, -5)]).toHaveLength(0);
    expect([...coveredMatchIndexes(10, NaN)]).toHaveLength(10);
    expect([...coveredMatchIndexes(0, 50)]).toHaveLength(0);
  });

  it('fills every seat of the covered matches and none of the skipped ones', () => {
    const matches = buildMatches(); // 12 quals, 5 seats each
    const plan = autoAssignPlan(matches, buildScouts(5), { ...OPTS, coveragePercent: 50 });
    const covered = ['qm1', 'qm3', 'qm5', 'qm7', 'qm9', 'qm11'].map((k) => `2026casnv_${k}`);
    const skipped = ['qm2', 'qm4', 'qm6', 'qm8', 'qm10', 'qm12'].map((k) => `2026casnv_${k}`);
    expect(plan.skippedMatchKeys).toEqual(skipped);
    expect(plan.assignments).toHaveLength(6 * 5);
    for (const key of covered) {
      expect(plan.assignments.filter((a) => a.matchKey === key)).toHaveLength(5);
    }
    for (const key of skipped) {
      expect(plan.assignments.some((a) => a.matchKey === key)).toBe(false);
    }
  });

  it('still balances load across scouts within the covered matches', () => {
    const plan = autoAssignPlan(buildMatches(), buildScouts(6), { ...OPTS, coveragePercent: 50 });
    const counts = new Map<string, number>();
    for (const a of plan.assignments) counts.set(a.scoutId, (counts.get(a.scoutId) ?? 0) + 1);
    const values = [...counts.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });

  it('defaults to full coverage when the option is omitted or 100', () => {
    const matches = buildMatches();
    const full = autoAssignPlan(matches, buildScouts(5), OPTS);
    expect(full.skippedMatchKeys).toEqual([]);
    expect(full.assignments).toHaveLength(60);
    const explicit = autoAssignPlan(matches, buildScouts(5), { ...OPTS, coveragePercent: 100 });
    expect(explicit).toEqual(full);
  });

  it('0% assigns nothing and reports every qual match as skipped', () => {
    const matches = buildMatches();
    const plan = autoAssignPlan(matches, buildScouts(5), { ...OPTS, coveragePercent: 0 });
    expect(plan.assignments).toEqual([]);
    expect(plan.skippedMatchKeys).toEqual(matches.map((m) => m.matchKey));
  });

  it('counts skipped matches toward blocked-mode spacing and rest', () => {
    // 50% coverage = every other match. With spacing 1 (every other event
    // match), a scout's work block lines up exactly with the covered matches,
    // so nothing needs relaxing and the pattern stays intact.
    const matches = buildMatches();
    const plan = autoAssignPlan(matches, buildScouts(10), {
      ...OPTS,
      coveragePercent: 50,
      scheduleMode: 'blocked',
      blockAssignments: 2,
      spacingMatches: 1,
      breakLength: 1,
    });
    expect(plan.relaxedMatchKeys).toEqual([]);
    expect(plan.assignments).toHaveLength(30);
    expect(plan.assignments.every((a) => !plan.skippedMatchKeys.includes(a.matchKey))).toBe(true);
  });
});
