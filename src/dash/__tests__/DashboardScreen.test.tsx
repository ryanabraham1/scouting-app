import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/dash/useActiveEvent', () => ({
  useActiveEvent: () => ({ eventKey: '2026demo', loading: false }),
}));

// DashboardScreen drives the real-time engine via useEventLiveSync (react-query +
// supabase Realtime). Stub it so this shell test stays isolated, like the views.
vi.mock('@/dash/useEventData', () => ({ useEventLiveSync: () => {} }));

// Stub the heavy tab bodies so the shell test stays isolated (no supabase/react-query).
vi.mock('@/dash/NextMatchView', () => ({ default: () => <div data-testid="view-next" /> }));
// TeamView echoes the selectedTeam prop so the ranking→team hand-off is observable.
vi.mock('@/dash/TeamView', () => ({
  default: ({ selectedTeam }: { selectedTeam?: number | null }) => (
    <div data-testid="view-team" data-selected={selectedTeam ?? ''} />
  ),
}));
vi.mock('@/dash/MatchView', () => ({ default: () => <div data-testid="view-match" /> }));
// RankingView exposes a button that fires onSelectTeam, like the real team cell.
vi.mock('@/dash/RankingView', () => ({
  default: ({ onSelectTeam }: { onSelectTeam?: (n: number) => void }) => (
    <div data-testid="view-ranking">
      <button data-testid="rank-pick-254" onClick={() => onSelectTeam?.(254)}>
        254
      </button>
    </div>
  ),
}));
vi.mock('@/dash/PicklistView', () => ({ default: () => <div data-testid="view-picklist" /> }));
vi.mock('@/dash/ScoutersTab', () => ({ default: () => <div data-testid="scouters-tab" /> }));
vi.mock('@/dash/SetupTab', () => ({ default: () => <div data-testid="setup-tab" /> }));

import DashboardScreen from '../DashboardScreen';

beforeEach(() => {
  window.history.replaceState({}, '', '/dashboard');
});

describe('DashboardScreen', () => {
  it('defaults to the Next Match tab', () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('view-next')).toBeInTheDocument();
  });

  it('switches to the Scouters and Setup tabs on click', () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Scouters' }));
    expect(screen.getByTestId('scouters-tab')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
    expect(screen.getByTestId('setup-tab')).toBeInTheDocument();
  });

  it('switches to the Match drill-down tab on click', () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Match' }));
    expect(screen.getByTestId('view-match')).toBeInTheDocument();
  });

  it('opens directly on Setup when ?tab=setup (the /admin alias)', () => {
    window.history.replaceState({}, '', '/dashboard?tab=setup');
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('setup-tab')).toBeInTheDocument();
  });

  it('resolves the retired ?tab=scouter alias to the merged Scouters tab', () => {
    window.history.replaceState({}, '', '/dashboard?tab=scouter');
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('scouters-tab')).toBeInTheDocument();
  });

  it('resolves the retired ?tab=roster alias to the merged Scouters tab', () => {
    window.history.replaceState({}, '', '/dashboard?tab=roster');
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('scouters-tab')).toBeInTheDocument();
  });

  it('opens the Team tab with the team preselected when a ranking row is picked', () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Ranking' }));
    fireEvent.click(screen.getByTestId('rank-pick-254'));
    const team = screen.getByTestId('view-team');
    expect(team).toBeInTheDocument();
    expect(team.getAttribute('data-selected')).toBe('254');
  });
});
