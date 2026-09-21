// src/dash/__tests__/PicklistEpaBoard.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import PicklistEpaBoard from '@/dash/PicklistEpaBoard';
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
        inListTeams={new Set()}
        onAdd={onAdd}
      />,
    );
    expect(getByTestId('picklist-epa-board')).toBeTruthy();
    // 2 of 3 teams have an EPA.
    expect(getByTestId('epa-board-count').textContent).toContain('2/3');
  });

  it('links a board team number to its Analysis team page', () => {
    const { getByTestId } = render(
      <PicklistEpaBoard teams={TEAMS} epa={statboticsEpa()} inListTeams={new Set()} onAdd={onAdd} />,
    );
    expect(getByTestId('epa-board-team-254')).toHaveAttribute(
      'href',
      '/analysis?tab=team&team=254',
    );
  });

  it('orders rows by EPA desc, sinking no-EPA teams to the bottom with "—"', () => {
    const { getByTestId } = render(
      <PicklistEpaBoard
        teams={TEAMS}
        epa={statboticsEpa()}
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
        inListTeams={new Set([254])}
        onAdd={onAdd}
      />,
    );
    expect(getByTestId('epa-board-added-254')).toBeTruthy();
    expect(queryByTestId('epa-board-add-254')).toBeNull();
    // Other teams still get an add button.
    expect(getByTestId('epa-board-add-1678')).toBeTruthy();
  });

  it('shows "—" (never the scouted estimate) when no match-result EPA resolved', () => {
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
        inListTeams={new Set()}
        onAdd={onAdd}
      />,
    );
    expect(getByTestId('epa-board-epa-254').textContent).toContain('—');
    expect(getByTestId('epa-board-source-note').textContent).toMatch(/no match-result epa/i);
    expect(getByTestId('epa-board-epa-1678').textContent).toContain('—');
  });

  it('renders a non-empty strength bar for each ranked team even when all EPA <= 0 (BUG-13)', () => {
    // All-zero EPAs: maxEpa would be 0, which previously zeroed EVERY bar. Each
    // ranked team should still get a minimal (equal) bar.
    const zeroEpa: EventEpa = {
      epaByTeam: new Map<number, number | null>([
        [254, 0],
        [1678, 0],
        [9999, null],
      ]),
      available: true,
      source: 'local',
      sourceByTeam: new Map([
        [254, 'local'],
        [1678, 'local'],
        [9999, 'none'],
      ]),
    };
    const { getByTestId } = render(
      <PicklistEpaBoard
        teams={TEAMS}
        epa={zeroEpa}
        inListTeams={new Set()}
        onAdd={onAdd}
      />,
    );
    // Teams with a (zero) EPA get a visible, non-0% bar.
    const bar254 = getByTestId('epa-board-bar-254');
    expect(bar254.style.width).not.toBe('0%');
    expect(bar254.style.width).not.toBe('');
    const bar1678 = getByTestId('epa-board-bar-1678');
    expect(bar1678.style.width).not.toBe('0%');
    // A team with NO estimate at all still renders an empty bar.
    expect(getByTestId('epa-board-bar-9999').style.width).toBe('0%');
  });

  it('renders a DNP toggle that calls onToggleDnp, and hides it for picked teams', () => {
    const onToggleDnp = vi.fn();
    const { getByTestId, queryByTestId } = render(
      <PicklistEpaBoard
        teams={TEAMS}
        epa={statboticsEpa()}
        inListTeams={new Set([254])}
        dnpTeams={new Set([1678])}
        onToggleDnp={onToggleDnp}
        onAdd={onAdd}
      />,
    );
    // 254 is a pick → no DNP toggle (can't DNP a team on your picklist).
    expect(queryByTestId('epa-board-dnp-254')).toBeNull();
    // 1678 is flagged DNP → its toggle is pressed and clears on click.
    const dnp1678 = getByTestId('epa-board-dnp-1678');
    expect(dnp1678.getAttribute('aria-pressed')).toBe('true');
    // 9999 is neither → an unpressed DNP toggle that flags on click.
    fireEvent.click(getByTestId('epa-board-dnp-9999'));
    expect(onToggleDnp).toHaveBeenCalledWith(9999);
  });

  it('omits the DNP control entirely when onToggleDnp is not provided', () => {
    const { queryByTestId } = render(
      <PicklistEpaBoard
        teams={TEAMS}
        epa={statboticsEpa()}
        inListTeams={new Set()}
        onAdd={onAdd}
      />,
    );
    expect(queryByTestId('epa-board-dnp-254')).toBeNull();
  });

  it('degrades to an empty state when there are no teams', () => {
    const { getByTestId } = render(
      <PicklistEpaBoard
        teams={[]}
        epa={undefined}
        inListTeams={new Set()}
        onAdd={onAdd}
      />,
    );
    expect(getByTestId('epa-board-empty')).toBeTruthy();
  });
});
