import { describe, it, expect } from 'vitest';
import { render, within } from '@testing-library/react';
import PlayoffPath from '@/dash/PlayoffPath';
import type { MatchRow } from '@/dash/useEventData';

function m(over: Partial<MatchRow>): MatchRow {
  return {
    match_key: '2026evt_qm1', event_key: '2026evt', comp_level: 'qm', match_number: 1,
    scheduled_time: null, red1: null, red2: null, red3: null, blue1: null, blue2: null, blue3: null,
    actual_red_score: null, actual_blue_score: null, winner: null, result_synced_at: null, ...over,
  };
}

describe('PlayoffPath', () => {
  it('focuses our next unplayed match with win/lose destinations', () => {
    const matches = [
      m({ match_key: '2026evt_sf1m1', comp_level: 'sf', red1: 3256, red2: 1678, red3: 254, blue1: 118, blue2: 973, blue3: 5940, actual_red_score: 88, actual_blue_score: 71, winner: 'red' }),
      m({ match_key: '2026evt_sf7m1', comp_level: 'sf', red1: 3256, red2: 1678, red3: 254, blue1: 195, blue2: 694, blue3: 2910 }),
    ];
    const { getByTestId } = render(<PlayoffPath matches={matches} baseTeam={3256} />);
    const current = getByTestId('playoff-path-current');
    expect(current.textContent).toContain('M7');
    expect(current.textContent).toContain('195'); // opponent shown from the row

    // Win → upper final M11; lose → lower bracket M9.
    expect(getByTestId('playoff-path-win').textContent).toContain('M11');
    expect(getByTestId('playoff-path-lose').textContent).toContain('M9');
  });

  it('shows the opponent as a winner/loser feed until that match is decided', () => {
    // Our M7 is scheduled but M8 (which feeds our M11 opponent) is undecided.
    const matches = [
      m({ match_key: '2026evt_sf7m1', comp_level: 'sf', red1: 3256, red2: 1678, red3: 254, blue1: 195, blue2: 694, blue3: 2910 }),
    ];
    const { getByTestId } = render(<PlayoffPath matches={matches} baseTeam={3256} />);
    expect(getByTestId('playoff-path-win').textContent).toContain('Winner of M8');
    expect(getByTestId('playoff-path-lose').textContent).toContain('Winner of M6');
  });

  it('resolves a future opponent to real teams once their match is decided', () => {
    const matches = [
      m({ match_key: '2026evt_sf7m1', comp_level: 'sf', red1: 3256, red2: 1678, red3: 254, blue1: 195, blue2: 694, blue3: 2910 }),
      // M8 decided: 148/217/1114 win → they're our opponent if we win into M11.
      m({ match_key: '2026evt_sf8m1', comp_level: 'sf', red1: 148, red2: 217, red3: 1114, blue1: 27, blue2: 469, blue3: 2046, actual_red_score: 95, actual_blue_score: 80, winner: 'red' }),
    ];
    const { getByTestId } = render(<PlayoffPath matches={matches} baseTeam={3256} />);
    const win = getByTestId('playoff-path-win');
    expect(win.textContent).toContain('148');
    expect(win.textContent).not.toContain('Winner of M8');
  });

  it('reports elimination when we lose with nowhere to drop', () => {
    const matches = [
      m({ match_key: '2026evt_sf9m1', comp_level: 'sf', red1: 3256, red2: 1678, red3: 254, blue1: 118, blue2: 973, blue3: 5940, actual_red_score: 60, actual_blue_score: 90, winner: 'blue' }),
    ];
    const { getByTestId } = render(<PlayoffPath matches={matches} baseTeam={3256} />);
    expect(getByTestId('playoff-path-status').textContent).toMatch(/Eliminated/i);
  });

  it('handles the finals series (win → champions)', () => {
    const matches = [
      m({ match_key: '2026evt_f1m1', comp_level: 'f', match_number: 1, red1: 3256, red2: 1678, red3: 254, blue1: 148, blue2: 217, blue3: 1114, actual_red_score: 102, actual_blue_score: 99, winner: 'red' }),
      m({ match_key: '2026evt_f1m2', comp_level: 'f', match_number: 2, red1: 3256, red2: 1678, red3: 254, blue1: 148, blue2: 217, blue3: 1114 }),
    ];
    const { getByTestId } = render(<PlayoffPath matches={matches} baseTeam={3256} />);
    expect(getByTestId('playoff-path-current').textContent).toContain('Finals');
    expect(within(getByTestId('playoff-path-win')).getByText('Champions')).toBeTruthy();
  });
});
