// src/dash/__tests__/PicklistEpaBoard.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import PicklistEpaBoard from '@/dash/PicklistEpaBoard';
import { emptyTeamAgg, type TeamAgg } from '@/dash/aggregate';
import type { TeamRow, EventEpa } from '@/dash/useEventData';

const TEAMS: TeamRow[] = [
  { team_number: 254, nickname: 'The Cheesy Poofs' },
  { team_number: 1678, nickname: 'Citrus Circuits' },
  { team_number: 9999, nickname: 'No EPA Team' },
];

function statboticsEpa(): EventEpa {
  return {
    epaByTeam: new Map<number, number | null>([
      [254, 60],
      [1678, 45],
      [9999, null],
    ]),
    available: true,
    source: 'statbotics',
    sourceByTeam: new Map([
      [254, 'statbotics'],
      [1678, 'statbotics'],
      [9999, 'none'],
    ]),
  };
}

const onAdd = vi.fn();

beforeEach(() => {
  cleanup();
  onAdd.mockReset();
});

describe('PicklistEpaBoard', () => {
  it('renders the panel root, title, and count', () => {
    const { getByTestId } = render(
      <PicklistEpaBoard
        teams={TEAMS}
        epa={statboticsEpa()}
        aggByTeam={new Map<number, TeamAgg>()}
        inListTeams={new Set()}
        onAdd={onAdd}
      />,
    );
    expect(getByTestId('picklist-epa-board')).toBeTruthy();
    // 2 of 3 teams have an EPA.
    expect(getByTestId('epa-board-count').textContent).toContain('2/3');
  });

  it('orders rows by EPA desc, sinking no-EPA teams to the bottom with "—"', () => {
    const { getByTestId } = render(
      <PicklistEpaBoard
        teams={TEAMS}
        epa={statboticsEpa()}
        aggByTeam={new Map<number, TeamAgg>()}
        inListTeams={new Set()}
        onAdd={onAdd}
      />,
    );
    const list = getByTestId('epa-board-list');
    const order = within(list)
      .getAllByTestId(/^epa-board-row-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'epa-board-row-254', // 60
      'epa-board-row-1678', // 45
      'epa-board-row-9999', // null → bottom
    ]);
    expect(getByTestId('epa-board-epa-254').textContent).toContain('60');
    expect(getByTestId('epa-board-epa-9999').textContent).toContain('—');
  });

  it('calls onAdd with the team number when the add button is tapped', () => {
    const { getByTestId } = render(
      <PicklistEpaBoard
        teams={TEAMS}
        epa={statboticsEpa()}
        aggByTeam={new Map<number, TeamAgg>()}
        inListTeams={new Set()}
        onAdd={onAdd}
      />,
    );
    fireEvent.click(getByTestId('epa-board-add-254'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(254);
  });

  it('shows an added (checked) state instead of an add button when already in list', () => {
    const { getByTestId, queryByTestId } = render(
      <PicklistEpaBoard
        teams={TEAMS}
        epa={statboticsEpa()}
        aggByTeam={new Map<number, TeamAgg>()}
        inListTeams={new Set([254])}
        onAdd={onAdd}
      />,
    );
    expect(getByTestId('epa-board-added-254')).toBeTruthy();
    expect(queryByTestId('epa-board-add-254')).toBeNull();
    // Other teams still get an add button.
    expect(getByTestId('epa-board-add-1678')).toBeTruthy();
  });

  it('falls back to the in-house scouting estimate (marked "est") when no external EPA', () => {
    const agg: TeamAgg = { ...emptyTeamAgg(254), scoutingExpectedPoints: 33 };
    const noEpa: EventEpa = {
      epaByTeam: new Map<number, number | null>([
        [254, null],
        [1678, null],
        [9999, null],
      ]),
      available: false,
      source: 'none',
      sourceByTeam: new Map([
        [254, 'none'],
        [1678, 'none'],
        [9999, 'none'],
      ]),
    };
    const { getByTestId } = render(
      <PicklistEpaBoard
        teams={TEAMS}
        epa={noEpa}
        aggByTeam={new Map<number, TeamAgg>([[254, agg]])}
        inListTeams={new Set()}
        onAdd={onAdd}
      />,
    );
    // 254 has an in-house estimate → real number + "est" chip.
    const epa254 = getByTestId('epa-board-epa-254');
    expect(epa254.textContent).toContain('33');
    expect(epa254.textContent).toContain('est');
    // The in-house source note is shown.
    expect(getByTestId('epa-board-source-note').textContent).toContain('in-house');
    // 1678 has no agg and no external EPA → "—".
    expect(getByTestId('epa-board-epa-1678').textContent).toContain('—');
  });

  it('degrades to an empty state when there are no teams', () => {
    const { getByTestId } = render(
      <PicklistEpaBoard
        teams={[]}
        epa={undefined}
        aggByTeam={new Map<number, TeamAgg>()}
        inListTeams={new Set()}
        onAdd={onAdd}
      />,
    );
    expect(getByTestId('epa-board-empty')).toBeTruthy();
  });
});
