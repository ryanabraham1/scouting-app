import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Workstream B owns the real rosterClient; mock it here.
const listRoster = vi.fn();
const addScouter = vi.fn();
const removeScouter = vi.fn();

vi.mock('@/roster/rosterClient', () => ({
  listRoster: () => listRoster(),
  addScouter: (name: string) => addScouter(name),
  removeScouter: (id: string) => removeScouter(id),
}));

import RosterTab from '../RosterTab';

beforeEach(() => {
  listRoster.mockReset().mockResolvedValue([
    { id: 'a', name: 'Alice' },
    { id: 'b', name: 'Bob' },
  ]);
  addScouter.mockReset().mockResolvedValue(undefined);
  removeScouter.mockReset().mockResolvedValue(undefined);
});

describe('RosterTab', () => {
  it('lists scouter names from the roster client', async () => {
    render(<RosterTab />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('adds a scouter and refreshes the list', async () => {
    render(<RosterTab />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    listRoster.mockResolvedValueOnce([
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob' },
      { id: 'c', name: 'Carol' },
    ]);

    fireEvent.change(screen.getByTestId('roster-name-input'), {
      target: { value: 'Carol' },
    });
    fireEvent.click(screen.getByTestId('roster-add-btn'));

    await waitFor(() => expect(addScouter).toHaveBeenCalledWith('Carol'));
    await waitFor(() => expect(screen.getByText('Carol')).toBeInTheDocument());
  });

  it('does not add a blank name', async () => {
    render(<RosterTab />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('roster-name-input'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByTestId('roster-add-btn'));
    expect(addScouter).not.toHaveBeenCalled();
  });

  it('removes a scouter and refreshes the list', async () => {
    render(<RosterTab />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    listRoster.mockResolvedValueOnce([{ id: 'b', name: 'Bob' }]);

    fireEvent.click(screen.getByTestId('roster-remove-a'));

    await waitFor(() => expect(removeScouter).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(screen.queryByText('Alice')).not.toBeInTheDocument());
  });
});
