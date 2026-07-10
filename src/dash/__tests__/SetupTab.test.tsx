import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const setupState = vi.hoisted(() => ({
  activeEvent: '2026demo' as string | null,
  eventData: new Map<string, unknown>(),
  events: [
    { event_key: '2026casnv', name: 'Silicon Valley', is_active: true },
    { event_key: '2026caetb', name: 'East Bay', is_active: false },
  ],
}));

vi.mock('@/dash/useActiveEvent', () => ({
  useActiveEvent: () => ({ eventKey: setupState.activeEvent, loading: false }),
}));

const setActiveEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/dash/setActiveEvent', () => ({
  setActiveEvent: (...a: unknown[]) => setActiveEventMock(...a),
}));

const deleteEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/dash/deleteEvent', () => ({
  deleteEvent: (...a: unknown[]) => deleteEventMock(...a),
}));

const enableDemoMock = vi.fn().mockResolvedValue(undefined);
const disableDemoMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/dash/demoEvent', () => ({
  DEMO_EVENT_KEY: '2026demo',
  isDemoEvent: (k: string | null) => k === '2026demo',
  enableDemoMode: (...a: unknown[]) => enableDemoMock(...a),
  disableDemoMode: (...a: unknown[]) => disableDemoMock(...a),
}));

// Stub admin children to keep the test focused on SetupTab wiring.
vi.mock('@/admin/EventSetup', () => ({
  EventSetup: (props: { onImported: (k: string) => void }) => (
    <button data-testid="import-stub" onClick={() => props.onImported('2026new')}>
      import
    </button>
  ),
}));
vi.mock('@/admin/ScheduleView', () => ({ ScheduleView: () => <div data-testid="schedule-stub" /> }));
vi.mock('@/admin/AssignmentBoard', () => ({ AssignmentBoard: () => <div data-testid="assign-stub" /> }));
vi.mock('@/admin/MatchPlanner', () => ({
  MatchPlanner: (props: {
    eventKey: string;
    matches: Array<{ matchKey: string }>;
    scouts: Array<{ displayName: string }>;
    teams: Array<{ teamNumber: number }>;
  }) => (
    <div
      data-testid="planner-stub"
      data-event={props.eventKey}
      data-matches={props.matches.map((row) => row.matchKey).join(',')}
      data-scouts={props.scouts.map((row) => row.displayName).join(',')}
      data-teams={props.teams.map((row) => row.teamNumber).join(',')}
    />
  ),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      let eventKey: string | null = null;
      const resolve = (): unknown => {
        if (table === 'event' && eventKey == null) {
          return { data: setupState.events, error: null };
        }
        return (
          setupState.eventData.get(`${table}:${eventKey ?? ''}`) ??
          { data: [], error: null }
        );
      };
      const builder = {
        select: () => builder,
        eq: (column: string, value: string) => {
          if (column === 'event_key') eventKey = value;
          return builder;
        },
        order: () => builder,
        then: (
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
      };
      return builder;
    },
  },
}));

// The jsdom-compat test env has a non-functional localStorage, so mock the base
// team store with an in-memory value (same approach as useActiveEvent.test).
// vi.hoisted lets the (hoisted) vi.mock factory share state without TDZ issues.
const DEFAULT_BASE_TEAM = 3256;
const store = vi.hoisted(() => ({ team: 3256 }));
vi.mock('@/dash/baseTeamStore', () => ({
  DEFAULT_BASE_TEAM: 3256,
  getStoredBaseTeam: () => store.team,
  setStoredBaseTeam: (n: number | null) => {
    store.team = n != null && Number.isInteger(n) && n > 0 ? n : 3256;
  },
}));

import SetupTab from '../SetupTab';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  setActiveEventMock.mockClear();
  deleteEventMock.mockClear();
  enableDemoMock.mockClear();
  disableDemoMock.mockClear();
  store.team = DEFAULT_BASE_TEAM;
  setupState.activeEvent = '2026demo';
  setupState.eventData.clear();
});

describe('SetupTab', () => {
  it('shows the current active event', () => {
    render(<SetupTab />, { wrapper });
    expect(screen.getByTestId('setup-active-event').textContent).toContain('2026demo');
  });

  it('sets the imported event active', async () => {
    render(<SetupTab />, { wrapper });
    fireEvent.click(screen.getByTestId('import-stub'));
    await waitFor(() => expect(setActiveEventMock).toHaveBeenCalledWith('2026new', expect.anything()));
  });

  it('switches to an already-imported event without re-importing', async () => {
    render(<SetupTab />, { wrapper });
    // The picker lists imported events; switching only flips is_active.
    const btn = await screen.findByTestId('setup-switch-2026caetb');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(setActiveEventMock).toHaveBeenCalledWith('2026caetb', expect.anything()),
    );
  });

  it('deletes an imported event after a two-step confirm', async () => {
    render(<SetupTab />, { wrapper });
    // First click arms the confirm; the event is not yet deleted.
    const del = await screen.findByTestId('setup-delete-2026caetb');
    fireEvent.click(del);
    expect(deleteEventMock).not.toHaveBeenCalled();
    // Second click (the Delete confirm) runs the removal.
    fireEvent.click(screen.getByTestId('setup-delete-confirm-2026caetb'));
    await waitFor(() =>
      expect(deleteEventMock).toHaveBeenCalledWith('2026caetb', expect.anything()),
    );
  });

  it('cancels a delete without removing the event', async () => {
    render(<SetupTab />, { wrapper });
    fireEvent.click(await screen.findByTestId('setup-delete-2026casnv'));
    fireEvent.click(screen.getByTestId('setup-delete-cancel-2026casnv'));
    // Back to the un-armed trash button; nothing deleted.
    expect(screen.getByTestId('setup-delete-2026casnv')).toBeInTheDocument();
    expect(deleteEventMock).not.toHaveBeenCalled();
  });

  it('shows the enable-demo button when the demo event is not in the list', async () => {
    render(<SetupTab />, { wrapper });
    // EVENTS has no 2026demo, so the enable button (not the status) renders.
    expect(await screen.findByTestId('setup-demo-enable')).toBeInTheDocument();
    expect(screen.queryByTestId('setup-demo-status')).not.toBeInTheDocument();
  });

  it('triggers the seed/activate path when enabling demo mode', async () => {
    render(<SetupTab />, { wrapper });
    fireEvent.click(await screen.findByTestId('setup-demo-enable'));
    await waitFor(() => expect(enableDemoMock).toHaveBeenCalledWith(expect.anything()));
  });

  it('defaults the base team to 3256', () => {
    render(<SetupTab />, { wrapper });
    expect(screen.getByTestId('setup-base-team-current').textContent).toContain('3256');
  });

  it('saves a new base team', () => {
    render(<SetupTab />, { wrapper });
    fireEvent.change(screen.getByTestId('setup-base-team-input'), { target: { value: '254' } });
    fireEvent.click(screen.getByTestId('setup-base-team-save'));
    expect(getStoredBaseTeam()).toBe(254);
    expect(screen.getByTestId('setup-base-team-current').textContent).toContain('254');
  });

  it('rejects a non-positive base team without persisting', () => {
    render(<SetupTab />, { wrapper });
    fireEvent.change(screen.getByTestId('setup-base-team-input'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('setup-base-team-save'));
    expect(getStoredBaseTeam()).toBe(DEFAULT_BASE_TEAM);
  });

  it('resets the base team to the default', () => {
    render(<SetupTab />, { wrapper });
    fireEvent.change(screen.getByTestId('setup-base-team-input'), { target: { value: '254' } });
    fireEvent.click(screen.getByTestId('setup-base-team-save'));
    expect(getStoredBaseTeam()).toBe(254);

    fireEvent.click(screen.getByTestId('setup-base-team-reset'));
    expect(getStoredBaseTeam()).toBe(DEFAULT_BASE_TEAM);
    expect(screen.getByTestId('setup-base-team-current').textContent).toContain('3256');
  });

  it('ignores a late A load and renders only B until switching back to A', async () => {
    let resolveAMatches!: (value: unknown) => void;
    const delayedAMatches = new Promise((resolve) => {
      resolveAMatches = resolve;
    });
    setupState.activeEvent = '2026a';
    setupState.eventData.set('match:2026a', delayedAMatches);
    setupState.eventData.set('scout:2026a', {
      data: [{ id: 'a-scout', display_name: 'Alice A' }],
      error: null,
    });
    setupState.eventData.set('event_team:2026a', {
      data: [{ team: { team_number: 101, nickname: 'A Team' } }],
      error: null,
    });
    setupState.eventData.set('match:2026b', {
      data: [{
        match_key: '2026b_qm1',
        match_number: 1,
        red1: 201,
        red2: 202,
        red3: 203,
        blue1: 204,
        blue2: 205,
        blue3: 206,
      }],
      error: null,
    });
    setupState.eventData.set('scout:2026b', {
      data: [{ id: 'b-scout', display_name: 'Blair B' }],
      error: null,
    });
    setupState.eventData.set('event_team:2026b', {
      data: [{ team: { team_number: 201, nickname: 'B Team' } }],
      error: null,
    });

    const rendered = render(<SetupTab />, { wrapper });
    expect(screen.getByTestId('setup-event-data-loading')).toHaveTextContent('2026a');

    setupState.activeEvent = '2026b';
    rendered.rerender(<SetupTab />);
    const bPlanner = await screen.findByTestId('planner-stub');
    expect(bPlanner).toHaveAttribute('data-event', '2026b');
    expect(bPlanner).toHaveAttribute('data-matches', '2026b_qm1');
    expect(bPlanner).toHaveAttribute('data-scouts', 'Blair B');
    expect(bPlanner).toHaveAttribute('data-teams', '201');

    resolveAMatches({
      data: [{
        match_key: '2026a_qm1',
        match_number: 1,
        red1: 101,
        red2: 102,
        red3: 103,
        blue1: 104,
        blue2: 105,
        blue3: 106,
      }],
      error: null,
    });
    await Promise.resolve();
    expect(screen.getByTestId('planner-stub')).toHaveAttribute('data-event', '2026b');
    expect(screen.getByTestId('planner-stub')).toHaveAttribute('data-matches', '2026b_qm1');

    setupState.activeEvent = '2026a';
    rendered.rerender(<SetupTab />);
    const aPlanner = await screen.findByTestId('planner-stub');
    await waitFor(() => expect(aPlanner).toHaveAttribute('data-event', '2026a'));
    expect(aPlanner).toHaveAttribute('data-matches', '2026a_qm1');
    expect(aPlanner).toHaveAttribute('data-scouts', 'Alice A');
    expect(aPlanner).toHaveAttribute('data-teams', '101');
  });
});
