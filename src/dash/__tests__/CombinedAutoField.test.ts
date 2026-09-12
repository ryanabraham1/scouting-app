import { describe, expect, it } from 'vitest';
import {
  matchupTeamAutos,
  overlayForAutoOption,
} from '@/dash/CombinedAutoField';
import type { TeamPit } from '@/dash/useTeamPit';

function pitWithAuto(startX: number): TeamPit {
  return {
    teamNumber: 254,
    autoRoutines: [{
      id: 'auto-1',
      description: 'Pit claimed auto',
      startPosition: { x: startX, y: 0.25 },
      path: [{ x: startX, y: 0.25 }, { x: 0.45, y: 0.35 }],
      underTrench: false,
      overBump: true,
      estimatedPoints: 20,
      recordedAlliance: startX < 0.5 ? 'red' : 'blue',
    }],
  } as TeamPit;
}

describe('pit auto matchup fallback', () => {
  it('infers a left-side pit drawing as red and rotates it onto blue', () => {
    const pits = new Map([[254, pitWithAuto(0.2)]]);
    const autos = matchupTeamAutos([], [254], [], pits);

    expect(autos).toHaveLength(1);
    const overlay = overlayForAutoOption(autos[0], 0);
    expect(overlay.startPosition).toEqual({ x: 0.8, y: 0.75 });
    expect(overlay.path).toEqual([
      { x: 0.8, y: 0.75 },
      { x: 0.55, y: 0.65 },
    ]);
  });

  it('keeps a right-side pit drawing unchanged for a blue matchup', () => {
    const pits = new Map([[254, pitWithAuto(0.8)]]);
    const autos = matchupTeamAutos([], [254], [], pits);
    const overlay = overlayForAutoOption(autos[0], 0);

    expect(overlay.startPosition).toEqual({ x: 0.8, y: 0.25 });
  });
});
