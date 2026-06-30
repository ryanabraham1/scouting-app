import { describe, it, expect } from 'vitest';
import {
  computeCoverage,
  computeCoverageFromAssignments,
  slotKey,
  type Seat,
} from '../coverage';
import { isQualMatchKey } from '@/lib/formatMatch';

function seat(matchKey: string, color: 'red' | 'blue', station: 1 | 2 | 3, team: number): Seat {
  return { matchKey, allianceColor: color, station, targetTeamNumber: team };
}

// 6 seats across one match (qm1), red 1-3 then blue 1-3.
const oneMatch: Seat[] = [
  seat('e_qm1', 'red', 1, 254),
  seat('e_qm1', 'red', 2, 1678),
  seat('e_qm1', 'red', 3, 100),
  seat('e_qm1', 'blue', 1, 200),
  seat('e_qm1', 'blue', 2, 300),
  seat('e_qm1', 'blue', 3, 400),
];

describe('computeCoverage', () => {
  it('1. empty slots → fully covered, rate 1, no gaps', () => {
    expect(computeCoverage([], () => '')).toEqual({
      totalSeats: 0,
      coveredSeats: 0,
      gapCount: 0,
      coverageRate: 1,
      gapsByMatch: [],
    });
  });

  it('2. all covered → gapCount 0, rate 1, no groups', () => {
    const s = computeCoverage(oneMatch, () => 'scout-x');
    expect(s.gapCount).toBe(0);
    expect(s.coveredSeats).toBe(6);
    expect(s.coverageRate).toBe(1);
    expect(s.gapsByMatch).toEqual([]);
  });

  it('3. partial gaps → counts + grouped gaps in input order', () => {
    const unassigned = new Set([slotKey(oneMatch[2]), slotKey(oneMatch[5])]);
    const s = computeCoverage(oneMatch, (k) => (unassigned.has(k) ? '' : 'scout-x'));
    expect(s.gapCount).toBe(2);
    expect(s.coveredSeats).toBe(4);
    expect(s.totalSeats).toBe(6);
    expect(s.coverageRate).toBeCloseTo(4 / 6, 6);
    expect(s.gapsByMatch).toHaveLength(1);
    expect(s.gapsByMatch[0].matchKey).toBe('e_qm1');
    expect(s.gapsByMatch[0].gaps.map((g) => g.targetTeamNumber)).toEqual([100, 400]);
  });

  it('4. whitespace pick counts as a gap', () => {
    const s = computeCoverage([oneMatch[0]], () => '   ');
    expect(s.gapCount).toBe(1);
    expect(s.coveredSeats).toBe(0);
  });

  it('5. grouping preserves first-seen match order and within-group slot order', () => {
    const interleaved: Seat[] = [
      seat('e_qm1', 'red', 1, 254),
      seat('e_qm2', 'red', 1, 11),
      seat('e_qm1', 'red', 2, 1678),
    ];
    const s = computeCoverage(interleaved, () => ''); // all gaps
    expect(s.gapsByMatch.map((g) => g.matchKey)).toEqual(['e_qm1', 'e_qm2']);
    expect(s.gapsByMatch[0].gaps.map((g) => g.targetTeamNumber)).toEqual([254, 1678]);
    expect(s.gapsByMatch[1].gaps.map((g) => g.targetTeamNumber)).toEqual([11]);
  });
});

describe('computeCoverageFromAssignments', () => {
  it('6. defensive null guard → scoutId null does NOT count as covered', () => {
    const assignments = [
      { matchKey: 'e_qm1', allianceColor: 'red' as const, station: 1, scoutId: 's1' },
      { matchKey: 'e_qm1', allianceColor: 'red' as const, station: 2, scoutId: 's2' },
      { matchKey: 'e_qm1', allianceColor: 'red' as const, station: 3, scoutId: null },
      { matchKey: 'e_qm1', allianceColor: 'blue' as const, station: 1, scoutId: 's3' },
      { matchKey: 'e_qm1', allianceColor: 'blue' as const, station: 2, scoutId: 's4' },
      // blue 3 has no assignment row at all
    ];
    const s = computeCoverageFromAssignments(oneMatch, assignments);
    expect(s.gapCount).toBe(2); // red3 (null) + blue3 (missing)
    expect(s.coveredSeats).toBe(4);
  });

  it('6b. production wire shape (all scoutId non-null) → 4 of 6 covered', () => {
    const assignments = [
      { matchKey: 'e_qm1', allianceColor: 'red' as const, station: 1, scoutId: 's1' },
      { matchKey: 'e_qm1', allianceColor: 'red' as const, station: 2, scoutId: 's2' },
      { matchKey: 'e_qm1', allianceColor: 'blue' as const, station: 1, scoutId: 's3' },
      { matchKey: 'e_qm1', allianceColor: 'blue' as const, station: 2, scoutId: 's4' },
    ];
    const s = computeCoverageFromAssignments(oneMatch, assignments);
    expect(s.gapCount).toBe(2);
    expect(s.coveredSeats).toBe(4);
  });

  it('7. a published seat not in slots is ignored (no over-count)', () => {
    const assignments = [
      ...oneMatch.map((s) => ({
        matchKey: s.matchKey,
        allianceColor: s.allianceColor,
        station: s.station,
        scoutId: 'sx',
      })),
      // own-team / extra seat not present in the slots universe
      { matchKey: 'e_qm1', allianceColor: 'red' as const, station: 1, scoutId: 'extra' },
      { matchKey: 'e_qm99', allianceColor: 'blue' as const, station: 3, scoutId: 'extra' },
    ];
    const s = computeCoverageFromAssignments(oneMatch, assignments);
    expect(s.totalSeats).toBe(6);
    expect(s.coveredSeats).toBe(6);
    expect(s.gapCount).toBe(0);
  });
});

describe('coverage gap math is quals-only (playoff seats are not gaps)', () => {
  // The AssignmentBoard builds its seat universe from qualification matches
  // only; a playoff match is intentionally unassigned and must NOT count as a
  // gap. We mirror that filter here over a quals+playoff seat list.
  const qualSeat = seat('2026casnv_qm1', 'red', 1, 254);
  const playoffSeat = seat('2026casnv_sf1', 'red', 1, 777);

  it('a playoff match seat, once filtered to quals, contributes no unassigned gap', () => {
    const allSeats = [qualSeat, playoffSeat];
    const qualSlots = allSeats.filter((s) => isQualMatchKey(s.matchKey));
    // Nothing assigned at all → only the qual seat should be a gap.
    const s = computeCoverage(qualSlots, () => '');
    expect(s.totalSeats).toBe(1);
    expect(s.gapCount).toBe(1);
    expect(s.gapsByMatch.map((g) => g.matchKey)).toEqual(['2026casnv_qm1']);
    expect(s.gapsByMatch.some((g) => g.matchKey.includes('sf'))).toBe(false);
  });
});

describe('slotKey', () => {
  it('8. locks the key format the board depends on', () => {
    expect(slotKey({ matchKey: 'e_qm1', allianceColor: 'blue', station: 3 })).toBe('e_qm1:blue:3');
  });
});
