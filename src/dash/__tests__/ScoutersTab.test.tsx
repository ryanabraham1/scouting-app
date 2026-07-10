// src/dash/__tests__/ScoutersTab.test.tsx
// The unified Scouters panel: ONE list merging the persistent roster with the
// active event's scout rows. Covers add, the merged report counts + profile
// drill-down, hide/unhide, and the global delete-by-name.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MsrRow } from '@/dash/types';
import type { ScoutRow } from '@/dash/useEventData';

const listRoster = vi.fn();
const addScouter = vi.fn();
const setScouterHidden = vi.fn();
const deleteRosterScouter = vi.fn();

vi.mock('@/roster/rosterClient', () => ({
  listRoster: (opts?: { includeHidden?: boolean }) => listRoster(opts),
  addScouter: (name: string) => addScouter(name),
  setScouterHidden: (name: string, hidden: boolean) => setScouterHidden(name, hidden),
  deleteRosterScouter: (name: string) => deleteRosterScouter(name),
}));

const useEventScoutsMock = vi.fn();
const useEventReportsMock = vi.fn();
vi.mock('@/dash/useEventData', () => ({
  useEventScouts: (eventKey: string | null) => useEventScoutsMock(eventKey),
  useEventReports: (eventKey: string | null) => useEventReportsMock(eventKey),
}));

const useEventPitsMock = vi.fn();
vi.mock('@/dash/useTeamPit', () => ({
  useEventPits: (eventKey: string | null) => useEventPitsMock(eventKey),
}));

import ScoutersTab from '../ScoutersTab';

function row(overrides: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 254,
    match_key: '2026casnv_qm1',
    alliance_color: 'red',
    station: 1,
    auto_fuel: 0,
    teleop_fuel_active: 0,
    teleop_fuel_inactive: 0,
    endgame_fuel: 0,
    fuel_points: 0,
    fuel_estimate_confidence: 1,
    fuel_by_shift: [0, 0, 0, 0],
    climb_level: 0,
    climb_attempted: false,
    climb_success: false,
    auto_left_starting_line: false,
    auto_climb_level1: false,
    defense_rating: 0,
    pins: 0,
    no_show: false,
    died: false,
    tipped: false,
    dropped_fuel: false,
    fed_corral: false,
    auto_start_position: null,
    auto_path: null,
    scout_id: null,
    notes: null,
    server_received_at: '2026-06-23T00:00:00Z',
    deleted: false,
    ...overrides,
  };
}

const scouts: ScoutRow[] = [
  { id: 's1', display_name: 'Alice', event_key: '2026demo' },
  { id: 's2', display_name: 'Bob', event_key: '2026demo' },
];
const reports: MsrRow[] = [
  row({ scout_id: 's1', match_key: '2026demo_qm1', target_team_number: 254, fuel_points: 20 }),
  row({ scout_id: 's1', match_key: '2026demo_qm2', target_team_number: 1678, fuel_points: 10 }),
];

function querySuccess<T>(data: T) {
  return { data, isLoading: false, isError: false, isSuccess: true };
}

function renderTab(eventKey: string | null = '2026demo') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScoutersTab eventKey={eventKey} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listRoster.mockReset().mockResolvedValue([
    { id: 'a', name: 'Alice', hidden: false },
    { id: 'b', name: 'Bob', hidden: false },
  ]);
  addScouter.mockReset().mockResolvedValue(undefined);
  setScouterHidden.mockReset().mockResolvedValue(undefined);
  deleteRosterScouter.mockReset().mockResolvedValue(undefined);
  useEventScoutsMock.mockReset().mockReturnValue(querySuccess(scouts));
  useEventReportsMock.mockReset().mockReturnValue(querySuccess(reports));
  useEventPitsMock.mockReset().mockReturnValue(querySuccess(new Map()));
});

describe('ScoutersTab (unified)', () => {
  it('merges roster names into a single list', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('requests hidden scouters too (admin view)', async () => {
    renderTab();
    await waitFor(() => expect(listRoster).toHaveBeenCalledWith({ includeHidden: true }));
  });

  it('shows merged per-scouter report counts', async () => {
    renderTab();
    const item = await screen.findByTestId('scouter-item-Alice');
    expect(item.textContent).toContain('2 reports');
    expect((await screen.findByTestId('scouter-item-Bob')).textContent).toContain('0 reports');
  });

  it('keeps the load bar inside the balanced summary and preserves touch targets', async () => {
    renderTab();
    const item = await screen.findByTestId('scouter-item-Alice');
    const summary = within(item).getByTestId('scouter-summary-Alice');
    const loadBar = within(item).getByTestId('scouter-load-bar-Alice');

    expect(summary).toContainElement(loadBar.parentElement);
    expect(summary.className).toContain('relative');
    expect(summary.className).toContain('p-2');

    for (const control of [
      within(item).getByTestId('scouter-open-Alice'),
      within(item).getByTestId('scouter-hide-Alice'),
      within(item).getByTestId('scouter-remove-Alice'),
    ]) {
      expect(Number.parseFloat(control.style.minHeight)).toBeGreaterThanOrEqual(44);
    }

    fireEvent.click(within(item).getByTestId('scouter-open-Alice'));
    const details = within(item).getByTestId('scouter-details-Alice');
    expect(details).not.toContainElement(loadBar);
    expect(details).toContainElement(within(item).getByTestId('scouter-profile'));
  });

  it('shows per-scouter pit report counts (list) and teams (profile)', async () => {
    useEventPitsMock.mockReturnValue(
      querySuccess(
        new Map<number, { teamNumber: number; authorScoutId: string }>([
          [254, { teamNumber: 254, authorScoutId: 's1' }],
          [1678, { teamNumber: 1678, authorScoutId: 's1' }],
          [9999, { teamNumber: 9999, authorScoutId: 's2' }],
        ]),
      ),
    );
    renderTab();
    // List chip: Alice authored 2 pit reports, Bob 1.
    const alice = await screen.findByTestId('scouter-item-Alice');
    expect(within(alice).getByTestId('scouter-pit-count-Alice').textContent).toContain('2 pit');
    const bob = await screen.findByTestId('scouter-item-Bob');
    expect(within(bob).getByTestId('scouter-pit-count-Bob').textContent).toContain('1 pit');
    // Profile: pit teams listed.
    fireEvent.click(within(alice).getByTestId('scouter-open-Alice'));
    const profile = await screen.findByTestId('scouter-profile');
    expect(within(profile).getByTestId('scouter-pit-reports').textContent).toContain('2');
    const pitTeams = within(profile).getByTestId('scouter-pit-teams');
    expect(pitTeams.textContent).toContain('254');
    expect(pitTeams.textContent).toContain('1678');
  });

  it('adds a scouter and refreshes', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    listRoster.mockResolvedValueOnce([
      { id: 'a', name: 'Alice', hidden: false },
      { id: 'b', name: 'Bob', hidden: false },
      { id: 'c', name: 'Carol', hidden: false },
    ]);
    fireEvent.change(screen.getByTestId('roster-name-input'), { target: { value: 'Carol' } });
    fireEvent.click(screen.getByTestId('roster-add-btn'));
    await waitFor(() => expect(addScouter).toHaveBeenCalledWith('Carol'));
    await waitFor(() => expect(screen.getByText('Carol')).toBeInTheDocument());
  });

  it('does not add a blank name', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('roster-name-input'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('roster-add-btn'));
    expect(addScouter).not.toHaveBeenCalled();
  });

  it('opens a profile with stats on click', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('scouter-open-Alice'));
    const profile = screen.getByTestId('scouter-profile');
    expect(within(profile).getByTestId('scouter-report-count').textContent).toContain('2');
    expect(within(profile).getByTestId('scouter-teams-covered').textContent).toContain('2');
  });

  it('hides a scouter (keeps reports) via setScouterHidden', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('scouter-hide-Alice'));
    await waitFor(() => expect(setScouterHidden).toHaveBeenCalledWith('Alice', true));
  });

  it('requires a confirm before deleting, then deletes globally by name', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('scouter-remove-Alice'));
    expect(screen.getByTestId('scouter-remove-confirm-Alice')).toBeTruthy();
    expect(deleteRosterScouter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('scouter-remove-confirm-Alice'));
    await waitFor(() => expect(deleteRosterScouter).toHaveBeenCalledWith('Alice'));
  });

  it('surfaces a delete error', async () => {
    deleteRosterScouter.mockRejectedValue(new Error('nope'));
    renderTab();
    fireEvent.click(await screen.findByTestId('scouter-remove-Alice'));
    fireEvent.click(screen.getByTestId('scouter-remove-confirm-Alice'));
    await waitFor(() =>
      expect(screen.getByTestId('scouter-action-error').textContent).toContain('nope'),
    );
  });

  it('keeps roster usable but hides report counts with a note when no event is active', async () => {
    useEventScoutsMock.mockReturnValue(querySuccess([]));
    useEventReportsMock.mockReturnValue(querySuccess([]));
    renderTab(null);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByTestId('scouters-no-event')).toBeInTheDocument();
  });

  // --- scout heartbeat moved here from Next Match (gated on eventKey) ---------
  it('renders the scout heartbeat at the top when an event is active', async () => {
    renderTab('2026demo');
    const heartbeat = await screen.findByTestId('scout-heartbeat');
    expect(heartbeat).toBeInTheDocument();
    // It anchors to the freshest-reported match and shows an X/Y synced count.
    expect(screen.getByTestId('scout-heartbeat-count').textContent).toMatch(/\/\s*\d+|\/—/);
    // It sits ABOVE the roster card.
    const roster = screen.getByTestId('roster-tab');
    expect(
      heartbeat.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('does NOT render the scout heartbeat when no event is active', async () => {
    useEventScoutsMock.mockReturnValue(querySuccess([]));
    useEventReportsMock.mockReturnValue(querySuccess([]));
    renderTab(null);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.queryByTestId('scout-heartbeat')).toBeNull();
  });
});
