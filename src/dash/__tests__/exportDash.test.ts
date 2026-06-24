// src/dash/__tests__/exportDash.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TeamAgg } from '@/dash/aggregate';
import type { PicklistEntry } from '@/dash/picklistClient';
import { teamAggToCsv, picklistToCsv, downloadText } from '@/dash/exportDash';

/** Minimal TeamAgg factory; only the exported columns matter here. */
function agg(overrides: Partial<TeamAgg>): TeamAgg {
  return {
    teamNumber: 254,
    matchesScouted: 3,
    meanAutoFuel: 0,
    meanTeleopFuelActive: 0,
    meanTeleopFuelInactive: 0,
    meanEndgameFuel: 0,
    meanTotalFuel: 0,
    meanFuelPoints: 12.5,
    meanFuelConfidence: 1,
    fuelPointsWeighted: 12.5,
    climbSuccessRate: 0.5,
    avgClimbLevel: 2,
    meanClimbPoints: 8,
    avgDefenseRating: 3,
    noShowRate: 0,
    diedRate: 0,
    reliability: 1,
    scoutingExpectedPoints: 20.5,
    ...overrides,
  };
}

describe('teamAggToCsv', () => {
  it('emits the expected header row', () => {
    const csv = teamAggToCsv([]);
    const header = csv.split('\n')[0];
    expect(header).toBe(
      'teamNumber,matchesScouted,scoutingExpectedPoints,meanFuelPoints,fuelPointsWeighted,climbSuccessRate,avgDefenseRating,reliability',
    );
  });

  it('emits one row per TeamAgg with the selected columns', () => {
    const csv = teamAggToCsv([
      agg({ teamNumber: 254, matchesScouted: 3, scoutingExpectedPoints: 20.5, meanFuelPoints: 12.5, fuelPointsWeighted: 12.5, climbSuccessRate: 0.5, avgDefenseRating: 3, reliability: 1 }),
      agg({ teamNumber: 1678, matchesScouted: 2, scoutingExpectedPoints: 10, meanFuelPoints: 6, fuelPointsWeighted: 6, climbSuccessRate: 0, avgDefenseRating: 2, reliability: 0.5 }),
    ]);
    const lines = csv.split('\n');
    expect(lines.length).toBe(3); // header + 2
    expect(lines[1]).toBe('254,3,20.5,12.5,12.5,0.5,3,1');
    expect(lines[2]).toBe('1678,2,10,6,6,0,2,0.5');
  });
});

describe('picklistToCsv', () => {
  it('emits the expected header row', () => {
    expect(picklistToCsv([]).split('\n')[0]).toBe('rank,teamNumber,tier,note');
  });

  it('numbers ranks 1-based and escapes notes containing commas and quotes', () => {
    const entries: PicklistEntry[] = [
      { teamNumber: 254, tier: 'A', note: 'great, "elite" shooter' },
      { teamNumber: 1678, tier: null, note: null },
    ];
    const lines = picklistToCsv(entries).split('\n');
    expect(lines[0]).toBe('rank,teamNumber,tier,note');
    // rank is 1-based; note with comma + quote is wrapped and internal quotes doubled.
    expect(lines[1]).toBe('1,254,A,"great, ""elite"" shooter"');
    // null tier/note serialize to empty fields.
    expect(lines[2]).toBe('2,1678,,');
  });

  it('wraps fields containing newlines', () => {
    const line = picklistToCsv([{ teamNumber: 7, tier: null, note: 'line1\nline2' }]).split('\n');
    // The newline lives inside a quoted field, so splitting on \n yields the open quote.
    expect(line[1]).toBe('1,7,,"line1');
    expect(line[2]).toBe('line2"');
  });
});

describe('downloadText', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.fn>;
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:mock-url');
    revokeObjectURL = vi.fn();
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

    clickSpy = vi.fn();
    // Intercept the temporary anchor's click so jsdom doesn't navigate.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(clickSpy);
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it('creates an object URL, clicks an anchor, and revokes the URL', () => {
    downloadText('picklist.csv', 'text/csv', 'rank,teamNumber\n1,254');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toContain('text/csv');

    expect(clickSpy).toHaveBeenCalledTimes(1);

    // The URL must be revoked (no leak).
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});
