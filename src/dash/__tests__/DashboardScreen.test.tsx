import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/dash/useActiveEvent', () => ({
  useActiveEvent: () => ({ eventKey: '2026demo', loading: false, authoritative: true }),
}));

// DashboardScreen drives the real-time engine via useEventLiveSync (react-query +
// supabase Realtime). Stub it so this shell test stays isolated, like the views.
vi.mock('@/dash/useEventData', () => ({ useEventLiveSync: () => {} }));

// Stub the heavy tab bodies so the shell test stays isolated (no supabase/react-query).
vi.mock('@/dash/NextMatchView', () => ({ default: () => <div data-testid="view-next" /> }));
// TeamView echoes the selectedTeam prop so the ranking→team hand-off is
// observable, and exposes a button that fires onOpenMatch like the real
// last-match card so the team→match deep-link is observable.
vi.mock('@/dash/TeamView', () => ({
  default: ({
    selectedTeam,
    onOpenMatch,
  }: {
    selectedTeam?: number | null;
    onOpenMatch?: (k: string) => void;
  }) => (
    <div data-testid="view-team" data-selected={selectedTeam ?? ''}>
      <button data-testid="team-open-match" onClick={() => onOpenMatch?.('2026demo_qm7')}>
        open match
      </button>
    </div>
  ),
}));
// MatchView echoes the initialMatchKey prop so the team→match deep-link lands.
vi.mock('@/dash/MatchView', () => ({
  default: ({ initialMatchKey }: { initialMatchKey?: string | null }) => (
    <div data-testid="view-match" data-initial-match={initialMatchKey ?? ''} />
  ),
}));
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

  it('persists tab changes in the URL and responds to history navigation', () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Ranking' }));
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('ranking');

    window.history.replaceState({}, '', '/dashboard?tab=team');
    fireEvent.popState(window);
    expect(screen.getByTestId('view-team')).toBeInTheDocument();
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

  it('always renders the Setup tab LAST in the tab bar', () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    const tabs = screen.getAllByRole('tab');
    const labels = tabs.map((t) => t.textContent?.trim());
    // Setup is pinned to the far right (stable sort moves only setup to the end).
    expect(labels[labels.length - 1]).toBe('Setup');
  });

  it('hides the Alliance tab button but shows Draft', () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    const labels = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    // Alliance is currently hidden (TABS entry carries `hidden: true`).
    expect(labels).not.toContain('Alliance');
    expect(labels).toContain('Draft');
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

  it('opens the Match tab with the match preselected when a team last-match card is opened', () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Team' }));
    fireEvent.click(screen.getByTestId('team-open-match'));
    const matchView = screen.getByTestId('view-match');
    expect(matchView).toBeInTheDocument();
    expect(matchView.getAttribute('data-initial-match')).toBe('2026demo_qm7');
  });
});
