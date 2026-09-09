import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/dash/useActiveEvent', () => ({
  useActiveEvent: () => ({ eventKey: '2026demo', loading: false, authoritative: true }),
}));
vi.mock('@/dash/useEventData', () => ({ useEventLiveSync: () => {} }));
vi.mock('@/dash/NextMatchView', () => ({ default: () => <div data-testid="view-next" /> }));
vi.mock('@/dash/AllianceSimulatorView', () => ({
  default: () => <div data-testid="view-alliance" />,
}));
vi.mock('@/dash/TeamView', () => ({
  default: ({
    selectedTeam,
    onOpenMatch,
  }: {
    selectedTeam?: number | null;
    onOpenMatch?: (match: string) => void;
  }) => (
    <div data-testid="view-team" data-selected={selectedTeam ?? ''}>
      <button type="button" onClick={() => onOpenMatch?.('2026demo_qm7')}>Open match</button>
    </div>
  ),
}));
vi.mock('@/dash/MatchView', () => ({
  default: ({ initialMatchKey }: { initialMatchKey?: string | null }) => (
    <div data-testid="view-match" data-match={initialMatchKey ?? ''} />
  ),
}));
vi.mock('@/dash/RankingView', () => ({
  default: ({ onSelectTeam }: { onSelectTeam?: (team: number) => void }) => (
    <div data-testid="view-ranking">
      <button type="button" onClick={() => onSelectTeam?.(254)}>Open 254</button>
    </div>
  ),
}));

import AnalysisScreen from '../AnalysisScreen';

function renderAnalysis(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <AnalysisScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', '/analysis');
});

describe('AnalysisScreen', () => {
  it('defaults to Pit Display and shows all five analysis sections', () => {
    renderAnalysis();
    expect(screen.getByTestId('view-next')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual([
      'Pit Display',
      'Team',
      'Match',
      'Ranking',
      'Alliance',
    ]);
  });

  it('brings back the Alliance screen as a visible tab', () => {
    renderAnalysis();
    fireEvent.click(screen.getByRole('tab', { name: 'Alliance' }));
    expect(screen.getByTestId('view-alliance')).toBeInTheDocument();
  });

  it('opens a ranking team in Analysis and preserves a shareable query', () => {
    renderAnalysis();
    fireEvent.click(screen.getByRole('tab', { name: 'Ranking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open 254' }));
    expect(screen.getByTestId('view-team')).toHaveAttribute('data-selected', '254');
    expect(window.location.search).toBe('?tab=team&team=254');
  });

  it('loads a team directly from the URL and can drill into a match', () => {
    window.history.replaceState({}, '', '/analysis?tab=team&team=1678');
    renderAnalysis();
    expect(screen.getByTestId('view-team')).toHaveAttribute('data-selected', '1678');
    fireEvent.click(screen.getByRole('button', { name: 'Open match' }));
    expect(screen.getByTestId('view-match')).toHaveAttribute('data-match', '2026demo_qm7');
    expect(window.location.search).toBe('?tab=match&match=2026demo_qm7');
  });
});
