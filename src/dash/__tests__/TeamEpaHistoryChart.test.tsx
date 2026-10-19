import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import TeamEpaHistoryChart from '@/dash/TeamEpaHistoryChart';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TeamEpaHistoryChart', () => {
  it('lists every match point and shows current, last-match change, and season high', () => {
    const points = [
      { matchKey: '2026one_qm1', eventKey: '2026one', compLevel: 'qm', matchNumber: 1, value: 42.1 },
      { matchKey: '2026one_qm2', eventKey: '2026one', compLevel: 'qm', matchNumber: 2, value: 46.3 },
      { matchKey: '2026two_sf1m1', eventKey: '2026two', compLevel: 'sf', matchNumber: 3, value: 40.8 },
    ];

    const { getByTestId, getByRole } = render(
      <TeamEpaHistoryChart teamNumber={9470} points={points} />,
    );

    const accessiblePoints = within(
      getByRole('list', { name: 'Team 9470 BSR progression by match' }),
    ).getAllByRole('listitem');
    expect(accessiblePoints).toHaveLength(3);
    expect(accessiblePoints[2]?.textContent).toContain('40.8 BSR');
    expect(getByTestId('team-epa-history').textContent).toContain('40.8');
    expect(getByTestId('team-epa-history').textContent).toContain('-5.5');
    expect(getByTestId('team-epa-history').textContent).toContain('46.3');
  });
});
