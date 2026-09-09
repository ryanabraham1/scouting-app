import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('@/dash/useActiveEvent', () => ({
  useActiveEvent: () => ({ eventKey: '2026demo', loading: false, authoritative: true }),
}));
vi.mock('@/dash/useEventData', () => ({ useEventLiveSync: () => {} }));
vi.mock('@/dash/strategy/StrategyView', () => ({
  default: () => <div data-testid="view-strategy" />,
}));
vi.mock('@/dash/PicklistView', () => ({
  default: ({ onSelectTeam }: { onSelectTeam?: (team: number) => void }) => (
    <div data-testid="view-picklist">
      <button type="button" onClick={() => onSelectTeam?.(254)}>Open 254</button>
    </div>
  ),
}));
vi.mock('@/dash/DraftBoardView', () => ({ default: () => <div data-testid="view-draft" /> }));
vi.mock('@/dash/ScoutersTab', () => ({ default: () => <div data-testid="scouters-tab" /> }));
vi.mock('@/dash/SetupTab', () => ({ default: () => <div data-testid="settings-tab" /> }));

import DashboardScreen from '../DashboardScreen';

function renderDashboard(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <DashboardScreen />
    </MemoryRouter>,
  );
}

function unlock(): void {
  fireEvent.change(screen.getByLabelText('Lead dashboard code'), { target: { value: '12345' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock dashboard' }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/dashboard');
});

describe('DashboardScreen', () => {
  it('starts locked and rejects an incorrect code', () => {
    renderDashboard();
    expect(screen.getByTestId('lead-dashboard-lock')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Lead dashboard code'), { target: { value: '11111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock dashboard' }));
    expect(screen.getByRole('alert')).toHaveTextContent('not correct');
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
  });

  it('unlocks with the exact code 12345 for the current session', () => {
    renderDashboard();
    unlock();
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('view-strategy')).toBeInTheDocument();
    expect(window.sessionStorage.getItem('frc-lead-dashboard-unlocked')).toBe('true');
  });

  it('shows only the five requested lead sections', () => {
    renderDashboard();
    unlock();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual([
      'Strategy',
      'Scouters',
      'Picklist',
      'Draft',
      'Settings',
    ]);
  });

  it('keeps old Setup links working as Settings', () => {
    window.history.replaceState({}, '', '/dashboard?tab=setup');
    renderDashboard();
    unlock();
    expect(screen.getByTestId('settings-tab')).toBeInTheDocument();
  });

  it('locks again from the dashboard header', () => {
    renderDashboard();
    unlock();
    fireEvent.click(screen.getByRole('button', { name: 'Lock dashboard' }));
    expect(screen.getByTestId('lead-dashboard-lock')).toBeInTheDocument();
    expect(window.sessionStorage.getItem('frc-lead-dashboard-unlocked')).toBeNull();
  });

  it('opens Picklist team details on the Analysis page', () => {
    function LocationProbe(): JSX.Element {
      const location = useLocation();
      return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
    }

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<DashboardScreen />} />
          <Route path="/analysis" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    unlock();
    fireEvent.click(screen.getByRole('tab', { name: 'Picklist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open 254' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/analysis?tab=team&team=254');
  });
});
