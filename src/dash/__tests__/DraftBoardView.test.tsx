import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PicklistEntry } from '@/dash/picklistClient';
import type { MsrRow } from '@/dash/types';
import type { EventComponentEpa, EventEpa } from '@/dash/useEventData';

let teamsFixture: Array<{ team_number: number; nickname: string | null }>;
let reportsFixture: MsrRow[];
let epaFixture: EventEpa;
let componentFixture: EventComponentEpa;
const getPicklistMock = vi.fn();

vi.mock('@/dash/useEventData', () => ({
  useEventReports: () => ({ data: reportsFixture, isLoading: false }),
  useEventMatches: () => ({
    data: Array.from({ length: 3 }, () => ({ actual_red_score: 10, actual_blue_score: 8 })),
    isLoading: false,
  }),
  useEventTeams: () => ({ data: teamsFixture, isLoading: false }),
  useEventEpa: () => ({ data: epaFixture }),
  useEventComponentEpas: () => ({ data: componentFixture }),
  useTbaRankings: () => ({ data: undefined }),
}));

vi.mock('@/dash/picklistClient', () => ({
  getPicklist: (eventKey: string) => getPicklistMock(eventKey),
  entryList: (entry: PicklistEntry) => (entry.tierType === 'second' ? 'second' : 'first'),
}));

import DraftBoardView from '@/dash/DraftBoardView';

beforeAll(() => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, String(value)),
    removeItem: (key: string) => void mem.delete(key),
    clear: () => mem.clear(),
    key: () => null,
    get length() {
      return mem.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
});

beforeEach(() => {
  cleanup();
  localStorage.clear();
  getPicklistMock.mockReset();
  reportsFixture = [report({ target_team_number: 254, auto_fuel: 8, fuel_points: 8 })];
  teamsFixture = [
    { team_number: 254, nickname: 'The Cheesy Poofs' },
    { team_number: 1678, nickname: 'Citrus Circuits' },
    { team_number: 3256, nickname: 'WarriorBorgs' },
  ];
  epaFixture = {
    epaByTeam: new Map([
      [254, 42],
      [1678, 28],
      [3256, 14],
    ]),
    available: true,
    source: 'statbotics',
  };
  componentFixture = {
    fraction: { fAuto: 0.15, fFuel: 0.55, fClimb: 0.3 },
    defenseByTeam: new Map(),
    available: true,
  };
  getPicklistMock.mockResolvedValue([
    { teamNumber: 254, tier: 'A', note: 'Fast cycles', dnp: false },
  ] satisfies PicklistEntry[]);
});

function renderBoard(onSelectTeam?: (team: number) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DraftBoardView eventKey="2026casnv" onSelectTeam={onSelectTeam} />
    </QueryClientProvider>,
  );
}

describe('DraftBoardView team pool', () => {
  it('lays out identity, metrics, badges, and decisions as responsive row regions', async () => {
    const { getByTestId, getByText } = renderBoard();
    const row = await waitFor(() => getByTestId('draft-row-254'));

    expect(row.className).toContain('lg:grid-cols-');
    expect(getByText('Performance')).toBeTruthy();
    expect(within(row).getByTestId('draft-identity-254').textContent).toContain(
      'The Cheesy Poofs',
    );

    const metrics = within(row).getByTestId('draft-metrics-254');
    expect(metrics.className).toContain('grid-cols-3');
    expect(within(metrics).getByTestId('draft-epa-254').textContent).toBe('42');
    expect(within(metrics).getByTestId('draft-points-254').textContent).toBe('8.0');
    expect(within(metrics).getByTestId('draft-auto-254').textContent).toBe('8.0scout');

    const actions = within(row).getByTestId('draft-actions-254');
    expect(actions.className).toContain('grid-cols-2');
    expect(within(actions).getByTestId('draft-ours-254').className).toContain('h-11');
    expect(within(actions).getByTestId('draft-ours-254').className).toContain('lg:h-8');
    await waitFor(() =>
      expect(within(row).getByTestId('draft-picklist-rank-254').textContent).toBe('#1'),
    );
  });

  it('preserves status toggles and exposes their pressed state', async () => {
    const { getByTestId } = renderBoard();
    const row = await waitFor(() => getByTestId('draft-row-254'));
    const ours = within(row).getByTestId('draft-ours-254');
    const taken = within(row).getByTestId('draft-taken-254');

    expect(ours.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(ours);
    expect(row.getAttribute('data-status')).toBe('ours');
    expect(ours.getAttribute('aria-pressed')).toBe('true');
    expect(ours.getAttribute('aria-label')).toMatch(/remove team 254/i);

    fireEvent.click(taken);
    expect(row.getAttribute('data-status')).toBe('taken');
    expect(ours.getAttribute('aria-pressed')).toBe('false');
    expect(taken.getAttribute('aria-pressed')).toBe('true');
    expect(taken.textContent).toContain('Undo');
  });

  it('prefers scouted auto, falls back to EPA auto, and sums each alliance member once', async () => {
    const { getByTestId } = renderBoard();
    const scoutedRow = await waitFor(() => getByTestId('draft-row-254'));
    const estimatedRow = getByTestId('draft-row-1678');

    expect(within(scoutedRow).getByTestId('draft-auto-254').textContent).toBe('8.0scout');
    expect(within(estimatedRow).getByTestId('draft-auto-1678').textContent).toBe('6.0est.');
    // Captain 3256 contributes its one EPA auto estimate (14 × 0.15 / 0.70 = 3).
    expect(getByTestId('draft-alliance-auto').textContent).toBe('3.0');
    expect(getByTestId('draft-alliance-auto-source').textContent).toBe('est.');

    fireEvent.click(within(scoutedRow).getByTestId('draft-ours-254'));
    // Captain 3 + pick 8 = 11; neither row is counted twice.
    expect(getByTestId('draft-alliance-auto').textContent).toBe('11.0');
    expect(getByTestId('draft-alliance-auto-source').textContent).toBe('scout + est.');
  });

  it('uses the configured base team as our draft captain', async () => {
    localStorage.setItem('base_team_number', '1678');
    const { getByTestId } = renderBoard();
    await waitFor(() => getByTestId('draft-row-1678'));

    // 1678 EPA auto estimate: 28 × 0.15 / 0.70 = 6.
    expect(getByTestId('draft-alliance-auto').textContent).toBe('6.0');
  });

  it('removes the captain that picked us from available recommendations', async () => {
    const { getByTestId, queryByTestId } = renderBoard();
    await waitFor(() => getByTestId('draft-row-254'));
    fireEvent.change(getByTestId('draft-pickedby'), { target: { value: '254' } });

    expect(getByTestId('draft-row-254').getAttribute('data-status')).toBe('taken');
    expect(queryByTestId('draft-best-254')).toBeNull();
  });

  it('keeps the stable team-link interaction', async () => {
    const onSelectTeam = vi.fn();
    const { getByTestId } = renderBoard(onSelectTeam);
    await waitFor(() => getByTestId('draft-row-254'));

    fireEvent.click(getByTestId('draft-team-254'));
    expect(onSelectTeam).toHaveBeenCalledWith(254);
  });
});

function report(overrides: Partial<MsrRow>): MsrRow {
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
    server_received_at: '2026-06-23T00:00:00Z',
    deleted: false,
    ...overrides,
  };
}
