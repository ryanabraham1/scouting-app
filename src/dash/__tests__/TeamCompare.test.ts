import { describe, expect, it } from 'vitest';
import { emptyTeamAgg, type TeamAgg } from '@/dash/aggregate';
import {
  buildComparisonData,
  MAX_COMPARE_TEAMS,
  TEAM_COMPARE_COLORS,
  type CompareTeam,
} from '@/dash/TeamCompare';

function team(
  teamNumber: number,
  overrides: Partial<TeamAgg> = {},
  epa: number | null = null,
): CompareTeam {
  return { agg: { ...emptyTeamAgg(teamNumber), ...overrides }, epa };
}

describe('buildComparisonData', () => {
  it('preserves selection order and assigns one stable color per team', () => {
    const data = buildComparisonData([team(111), team(222), team(333)]);
    expect(data.map((item) => item.teamNumber)).toEqual([111, 222, 333]);
    expect(data.map((item) => item.color)).toEqual(
      TEAM_COMPARE_COLORS.slice(0, 3),
    );
  });

  it('splits expected points into auto fuel, later fuel, and climb without changing the total', () => {
    const [data] = buildComparisonData([
      team(
        254,
        {
          matchesScouted: 4,
          meanAutoFuel: 10,
          meanTeleopFuelActive: 30,
          meanEndgameFuel: 10,
          meanFuelPoints: 80,
          meanClimbPoints: 20,
          scoutingExpectedPoints: 100,
        },
        94,
      ),
    ]);

    expect(data.scoring.auto).toBeCloseTo(16);
    expect(data.scoring.teleopEndgame).toBeCloseTo(64);
    expect(data.scoring.climb).toBe(20);
    expect(
      data.scoring.auto + data.scoring.teleopEndgame + data.scoring.climb,
    ).toBeCloseTo(data.scoring.expected);
    expect(data.scoring.epa).toBe(94);
  });

  it('keeps rates and qualitative defense in their native scales', () => {
    const [data] = buildComparisonData([
      team(1678, {
        reliability: 0.75,
        climbSuccessRate: 0.5,
        avgDefenseRating: 8,
      }),
    ]);
    expect(data.reliability).toBe(0.75);
    expect(data.climbSuccess).toBe(0.5);
    expect(data.defenseRating).toBe(8);
  });

  it('gates defender impact until the minimum opponent sample is met', () => {
    const data = buildComparisonData([
      team(1, { defenderEffectiveness: 0.25, defenseSampleCount: 1 }),
      team(2, { defenderEffectiveness: 0.25, defenseSampleCount: 2 }),
    ]);
    expect(data[0].opponentSlowdownCaused).toBeNull();
    expect(data[1].opponentSlowdownCaused).toBe(0.25);
  });

  it('caps the model at the supported team count', () => {
    const teams = Array.from({ length: MAX_COMPARE_TEAMS + 2 }, (_, index) =>
      team(index + 1),
    );
    expect(buildComparisonData(teams)).toHaveLength(MAX_COMPARE_TEAMS);
  });

  it('treats non-finite EPA as unavailable', () => {
    expect(
      buildComparisonData([team(1, {}, Number.NaN)])[0].scoring.epa,
    ).toBeNull();
  });
});
