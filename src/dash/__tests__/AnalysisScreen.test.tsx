import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TeamLink } from '@/components/ui/TeamLink';

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
  default: () => (
    <div data-testid="view-ranking">
      <TeamLink team={254} />
    </div>
  ),
}));

import AnalysisScreen from '../AnalysisScreen';

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location" data-search={location.search} />;
}

function renderAnalysis(path = '/analysis'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AnalysisScreen />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function currentSearch(): string | null {
  return screen.getByTestId('location').getAttribute('data-search');
}

describe('AnalysisScreen', () => {
  it('defaults to Pit Display and shows the visible analysis sections', () => {
    renderAnalysis();
    expect(screen.getByTestId('view-next')).toBeInTheDocument();
    const bar = screen.getByTestId('analysis-bottom-nav');
    expect(
      Array.from(bar.querySelectorAll('button')).map((tab) => tab.textContent?.trim()),
    ).toEqual(['Team', 'Match', 'Ranking', 'Pit']);
  });

  it('hides the Alliance tab, and a stale ?tab=alliance link falls back to Pit Display', () => {
    renderAnalysis('/analysis?tab=alliance');
    expect(screen.queryByTestId('analysis-tab-alliance')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-next')).toBeInTheDocument();
  });

  it('opens a ranking team in Analysis and preserves a shareable query', () => {
    renderAnalysis();
    fireEvent.click(screen.getByTestId('analysis-tab-ranking'));
    fireEvent.click(screen.getByRole('link', { name: '254' }));
    expect(screen.getByTestId('view-team')).toHaveAttribute('data-selected', '254');
    expect(currentSearch()).toBe('?tab=team&team=254');
  });

  it('loads a team directly from the URL and can drill into a match', () => {
    renderAnalysis('/analysis?tab=team&team=1678');
    expect(screen.getByTestId('view-team')).toHaveAttribute('data-selected', '1678');
    fireEvent.click(screen.getByRole('button', { name: 'Open match' }));
    expect(screen.getByTestId('view-match')).toHaveAttribute('data-match', '2026demo_qm7');
    expect(currentSearch()).toBe('?tab=match&match=2026demo_qm7');
  });
});
