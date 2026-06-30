// src/dash/__tests__/presetExports.test.ts
import { describe, it, expect } from 'vitest';
import type { TeamAgg } from '@/dash/aggregate';
import type { PicklistEntry } from '@/dash/picklistClient';
import {
  buildPresetRows,
  allianceSheetToCsv,
  picklistToolCsv,
  allianceSheetToHtml,
  fetchTeamMetadata,
  type PresetRow,
  type TeamMetadata,
} from '@/dash/presetExports';

/** Minimal TeamAgg factory; only the columns the presets read matter. */
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
    climbSuccessRate: 0.5,
    avgClimbLevel: 2,
    meanClimbPoints: 8,
    avgDefenseRating: 3,
    noShowRate: 0,
    diedRate: 0,
    reliability: 1,
    scoutingExpectedPoints: 20.5,
    fuelSuppressionWhileDefended: null,
    defendedSampleMs: 0,
    defenderEffectiveness: null,
    defenseSampleCount: 0,
    stdDevFuelPoints: 0,
    minFuelPoints: 0,
    maxFuelPoints: 0,
    stdDevClimbPoints: 0,
    minClimbPoints: 0,
    maxClimbPoints: 0,
    stdDevDefenseRating: 0,
    minDefenseRating: 0,
    maxDefenseRating: 0,
    recentFuelMean: 0,
    recentFuelDelta: 0,
    recentTrend: 'insufficient',
    ...overrides,
  };
}

function meta(overrides: Partial<TeamMetadata> & { teamNumber: number }): TeamMetadata {
  return {
    nickname: null,
    city: null,
    stateProv: null,
    rookieYear: null,
    ...overrides,
  };
}

const ENTRIES: PicklistEntry[] = [
  { teamNumber: 254, tier: 'A', note: 'shooter' },
  { teamNumber: 1678, tier: 'B', note: null },
];

describe('buildPresetRows', () => {
  it('happy path: ranks 1,2 with metrics + statbotics EPA', () => {
    const aggByTeam = new Map<number, TeamAgg>([
      [254, agg({ teamNumber: 254, scoutingExpectedPoints: 20.5 })],
      [1678, agg({ teamNumber: 1678, scoutingExpectedPoints: 10 })],
    ]);
    const epaByTeam = new Map<number, number | null>([
      [254, 45],
      [1678, 30],
    ]);
    const rows = buildPresetRows(
      ENTRIES,
      aggByTeam,
      epaByTeam,
      true,
      'statbotics',
      new Map(),
      new Map([
        [254, 'statbotics'],
        [1678, 'statbotics'],
      ]),
    );
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0].epa).toBe(45);
    expect(rows[0].epaSource).toBe('statbotics');
    expect(rows[0].matchesScouted).toBe(3);
    expect(rows[1].teamNumber).toBe(1678);
  });

  it('unscouted team is included with null metrics but kept identity', () => {
    const rows = buildPresetRows(
      [{ teamNumber: 9999, tier: 'C', note: 'unscouted' }],
      new Map(), // no agg
      new Map([[9999, 50]]),
      true,
      'statbotics',
      new Map([[9999, meta({ teamNumber: 9999, nickname: 'Ghost', city: 'SF', stateProv: 'CA' })]]),
      new Map([[9999, 'statbotics']]),
    );
    const r = rows[0];
    expect(r.rank).toBe(1);
    expect(r.matchesScouted).toBeNull();
    expect(r.expPts).toBeNull();
    // external EPA still applies (team present in epaByTeam)
    expect(r.epa).toBe(50);
    expect(r.nickname).toBe('Ghost');
    expect(r.city).toBe('SF');
  });

  it('in-house EPA: epaAvailable false → epa = scoutingExpectedPoints, source scouting', () => {
    const aggByTeam = new Map<number, TeamAgg>([
      [254, agg({ teamNumber: 254, scoutingExpectedPoints: 20.5 })],
    ]);
    const rows = buildPresetRows(
      [{ teamNumber: 254 }],
      aggByTeam,
      new Map(),
      false,
      'none',
      new Map(),
      new Map([[254, 'none']]),
    );
    expect(rows[0].epa).toBe(20.5);
    expect(rows[0].epaSource).toBe('scouting');
  });

  it('per-team local EPA via sourceByTeam (NOT event-wide flag)', () => {
    const aggByTeam = new Map<number, TeamAgg>([[254, agg({ teamNumber: 254 })]]);
    const rows = buildPresetRows(
      [{ teamNumber: 254 }],
      aggByTeam,
      new Map([[254, 42]]),
      true,
      'statbotics', // event-wide says statbotics
      new Map(),
      new Map([[254, 'local']]), // but THIS team is local
    );
    expect(rows[0].epa).toBe(42);
    expect(rows[0].epaSource).toBe('local');
  });

  it('event source statbotics but team has NO external → scouting (not mislabeled)', () => {
    const aggByTeam = new Map<number, TeamAgg>([
      [254, agg({ teamNumber: 254, scoutingExpectedPoints: 18 })],
    ]);
    const rows = buildPresetRows(
      [{ teamNumber: 254 }],
      aggByTeam,
      new Map([[254, null]]), // no external number for this team
      true,
      'statbotics',
      new Map(),
      new Map([[254, 'none']]),
    );
    expect(rows[0].epa).toBe(18);
    expect(rows[0].epaSource).toBe('scouting');
  });

  it('regression guard: unscouted team with NO EPA does not throw', () => {
    const rows = buildPresetRows(
      [{ teamNumber: 7 }],
      new Map(), // no agg
      new Map(),
      false, // both EPA sources down
      'none',
      new Map(),
      new Map(),
    );
    expect(rows[0].epa).toBeNull();
    expect(rows[0].epaSource).toBe('none');
    expect(rows[0].matchesScouted).toBeNull();
  });

  it('falls back to eventSource when sourceByTeam is absent', () => {
    const aggByTeam = new Map<number, TeamAgg>([[254, agg({ teamNumber: 254 })]]);
    const rows = buildPresetRows(
      [{ teamNumber: 254 }],
      aggByTeam,
      new Map([[254, 99]]),
      true,
      'local',
      new Map(),
      // no sourceByTeam
    );
    expect(rows[0].epaSource).toBe('local');
  });
});

describe('fetchTeamMetadata', () => {
  it('error path → empty Map (degrades, never throws)', async () => {
    const fakeClient = {
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({ data: null, error: { message: 'offline' } }),
        }),
      }),
    } as never;
    const map = await fetchTeamMetadata([254, 1678], fakeClient);
    expect(map.size).toBe(0);
  });

  it('empty input → empty Map without querying', async () => {
    const map = await fetchTeamMetadata([]);
    expect(map.size).toBe(0);
  });

  it('column mapping: state_prov→stateProv, rookie_year→rookieYear, keyed by team_number', async () => {
    const fakeClient = {
      from: () => ({
        select: () => ({
          in: () =>
            Promise.resolve({
              data: [
                {
                  team_number: 254,
                  nickname: 'The Cheesy Poofs',
                  city: 'San Jose',
                  state_prov: 'CA',
                  rookie_year: 1999,
                },
              ],
              error: null,
            }),
        }),
      }),
    } as never;
    const map = await fetchTeamMetadata([254], fakeClient);
    const m = map.get(254)!;
    expect(m.stateProv).toBe('CA');
    expect(m.rookieYear).toBe(1999);
    expect(m.nickname).toBe('The Cheesy Poofs');
    expect(m.city).toBe('San Jose');
  });
});

/** Helper to make a fully-resolved PresetRow for the CSV/HTML builders. */
function row(overrides: Partial<PresetRow> & { rank: number; teamNumber: number }): PresetRow {
  return {
    nickname: null,
    city: null,
    stateProv: null,
    tier: null,
    note: null,
    matchesScouted: null,
    expPts: null,
    fuelPts: null,
    climbRate: null,
    defense: null,
    reliability: null,
    epa: null,
    epaSource: 'none',
    ...overrides,
  };
}

describe('allianceSheetToCsv', () => {
  it('emits the exact header', () => {
    expect(allianceSheetToCsv([], '2026demo').split('\n')[0]).toBe(
      'Rank,Team,Nickname,Location,Tier,Note,Matches,Exp Pts,FUEL Pts,Climb %,Defense,Reliability,EPA,EPA Source',
    );
  });

  it('formats numbers and degrades nulls to em-dash, joins location', () => {
    const csv = allianceSheetToCsv(
      [
        row({
          rank: 1,
          teamNumber: 254,
          nickname: 'Poofs',
          city: 'San Jose',
          stateProv: 'CA',
          tier: 'A',
          note: 'shooter',
          matchesScouted: 3,
          expPts: 20.5,
          fuelPts: 12.5,
          climbRate: 0.5,
          defense: 3,
          reliability: 1,
          epa: 45.4,
          epaSource: 'statbotics',
        }),
        row({ rank: 2, teamNumber: 9999 }), // fully unscouted
      ],
      '2026demo',
    );
    const lines = csv.split('\n');
    expect(lines[1]).toBe('1,254,Poofs,"San Jose, CA",A,shooter,3,20.5,12.5,50%,3.0,100%,45,statbotics');
    // unscouted row: numerics render em-dash
    expect(lines[2]).toBe('2,9999,—,—,—,—,—,—,—,—,—,—,—,none');
  });

  it('escapes commas/quotes in nickname and note like csvField', () => {
    const csv = allianceSheetToCsv(
      [row({ rank: 1, teamNumber: 1, nickname: 'Lobstah, "Bots"', note: 'a,b' })],
      'e',
    );
    const line = csv.split('\n')[1];
    expect(line).toContain('"Lobstah, ""Bots"""');
    expect(line).toContain('"a,b"');
  });
});

describe('picklistToolCsv', () => {
  it('emits exact snake_case header', () => {
    expect(picklistToolCsv([]).split('\n')[0]).toBe(
      'rank,team_number,nickname,tier,note,epa,epa_source,exp_points,fuel_points,climb_rate,defense,reliability,matches_scouted',
    );
  });

  it('null numerics render EMPTY (not em-dash), rates raw decimals, epa_source literal', () => {
    const csv = picklistToolCsv([
      row({
        rank: 1,
        teamNumber: 254,
        epa: 45.4,
        epaSource: 'local',
        expPts: 20.5,
        fuelPts: 12.5,
        climbRate: 0.5,
        defense: 3,
        reliability: 0.8,
        matchesScouted: 3,
      }),
      row({ rank: 2, teamNumber: 9999 }), // unscouted → blanks
    ]);
    const lines = csv.split('\n');
    expect(lines[1]).toBe('1,254,,,,45.4,local,20.5,12.5,0.5,3.0,0.8,3');
    expect(lines[2]).toBe('2,9999,,,,,none,,,,,,');
  });
});

describe('allianceSheetToHtml', () => {
  it('contains title, table, one tr per row, escapes HTML, and shows EPA note when not statbotics', () => {
    const html = allianceSheetToHtml(
      [
        row({ rank: 1, teamNumber: 254, nickname: '<Poofs> & co' }),
        row({ rank: 2, teamNumber: 1678 }),
      ],
      '2026demo',
      'local',
    );
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Alliance Selection — 2026demo</title>');
    expect(html).toContain('<table>');
    // HTML-escaped nickname
    expect(html).toContain('&lt;Poofs&gt; &amp; co');
    // EPA note present for local source
    expect(html).toContain('local estimate');
    // one data row per row in tbody
    const trCount = (html.match(/<tr/g) || []).length;
    // header tr + 2 data rows
    expect(trCount).toBe(3);
  });

  it('omits the EPA note when source is statbotics', () => {
    const html = allianceSheetToHtml([row({ rank: 1, teamNumber: 254 })], '2026demo', 'statbotics');
    expect(html).not.toContain('<p class="epa-note">');
  });
});
