// src/dash/__tests__/RankingView.test.tsx
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import type { MsrRow } from '@/dash/types';
import type { EventEpa } from '@/dash/useEventData';

// --- mock the data hooks; each test sets the return values via the holders ---
let reportsReturn: { data: MsrRow[] | undefined; isLoading: boolean };
let epaReturn: { data: EventEpa | undefined };
let tbaReturn: { data: unknown };
let teamsReturn: { data: { team_number: number; nickname: string | null }[]; isLoading: boolean };

vi.mock('@/dash/useEventData', () => ({
  useEventReports: () => reportsReturn,
  useEventEpa: () => epaReturn,
  useEventMatches: () => ({ data: [], isLoading: false, isError: false, isSuccess: true }),
  useEventTeams: () => teamsReturn,
  useTbaRankings: () => tbaReturn,
}));

import RankingView from '@/dash/RankingView';

// The jsdom-compat env ships a non-functional localStorage; install a minimal
// in-memory polyfill so the real column-persistence logic is exercised.
beforeAll(() => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
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
  reportsReturn = { data: [], isLoading: false };
  epaReturn = { data: { epaByTeam: new Map(), available: false } };
  tbaReturn = { data: undefined };
  // Default: no event roster — keeps the existing "only scouted teams" tests
  // exercising exactly the teams in `reports`.
  teamsReturn = { data: [], isLoading: false };
});

/** Minimal MsrRow factory: fills required fields, override per test. */
function row(overrides: Partial<MsrRow>): MsrRow {
  return {
    target_team_number: 100,
    match_key: 'evt_qm1',
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

/** Two scouted teams with clearly different fuel points so sort order is observable. */
const reports: MsrRow[] = [
  // Team 254: high fuel points
  row({ target_team_number: 254, fuel_points: 40, fuel_estimate_confidence: 1, climb_level: 3, climb_success: true, defense_rating: 4 }),
  row({ target_team_number: 254, fuel_points: 50, fuel_estimate_confidence: 1, climb_level: 3, climb_success: true, defense_rating: 4 }),
  // Team 1678: lower fuel points
  row({ target_team_number: 1678, fuel_points: 10, fuel_estimate_confidence: 1, climb_level: 1, climb_success: false, defense_rating: 2 }),
];

describe('RankingView', () => {
  it('renders the ranking container', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(getByTestId('dash-ranking')).toBeTruthy();
  });

  it('shows a loading state while reports load', () => {
    reportsReturn = { data: undefined, isLoading: true };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(getByTestId('dash-ranking-loading')).toBeTruthy();
  });

  it('shows the empty state (with the new copy) when there are no teams and no scouting', () => {
    reportsReturn = { data: [], isLoading: false };
    teamsReturn = { data: [], isLoading: false };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    const empty = getByTestId('dash-ranking-empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toBe('No teams or scouting data yet for this event.');
  });

  it('adds EPA-only rows for every event team without scouting', () => {
    // Only 254 is scouted; the roster also carries 1678 + 9999 (no reports).
    reportsReturn = { data: [reports[0]], isLoading: false };
    teamsReturn = {
      data: [
        { team_number: 254, nickname: 'Cheesy Poofs' },
        { team_number: 1678, nickname: 'Citrus' },
        { team_number: 9999, nickname: null },
      ],
      isLoading: false,
    };
    epaReturn = { data: { epaByTeam: new Map([[9999, 42]]), available: true } };
    const { getByTestId, getAllByTestId } = render(<RankingView eventKey="2026casnv" />);
    // A row for the unscouted 9999 exists even though it has zero reports.
    const row9999 = getByTestId('ranking-row-9999');
    expect(row9999).toBeTruthy();
    expect(within(row9999).getByTestId('epa-9999').textContent).toBe('42');
    // …and it carries 0 matches scouted.
    expect(within(row9999).getByText('0')).toBeTruthy();
    // All three roster teams render (254 scouted, 1678 + 9999 EPA-only).
    const rows = getAllByTestId(/^ranking-row-/);
    const ids = rows.map((r) => r.getAttribute('data-testid'));
    expect(ids).toContain('ranking-row-254');
    expect(ids).toContain('ranking-row-1678');
    expect(ids).toContain('ranking-row-9999');
  });

  it('defaults the sort to EPA when the event has zero scouting', () => {
    // No reports at all, but a roster with EPA values — rank by EPA by default
    // (Exp. Pts is 0 for everyone so it would be a meaningless tie-break order).
    reportsReturn = { data: [], isLoading: false };
    teamsReturn = {
      data: [
        { team_number: 254, nickname: null },
        { team_number: 1678, nickname: null },
      ],
      isLoading: false,
    };
    epaReturn = {
      data: { epaByTeam: new Map([[254, 30], [1678, 70]]), available: true },
    };
    const { getAllByTestId } = render(<RankingView eventKey="2026casnv" />);
    // Default desc-by-EPA puts the higher-EPA 1678 first.
    const rows = getAllByTestId(/^ranking-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('ranking-row-1678');
    expect(rows[1].getAttribute('data-testid')).toBe('ranking-row-254');
  });

  it('renders one row per scouted team', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(getByTestId('ranking-row-254')).toBeTruthy();
    expect(getByTestId('ranking-row-1678')).toBeTruthy();
  });

  it('defaults to sorting by scoutingExpectedPoints descending (254 before 1678)', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getAllByTestId } = render(<RankingView eventKey="2026casnv" />);
    const rows = getAllByTestId(/^ranking-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('ranking-row-254');
    expect(rows[1].getAttribute('data-testid')).toBe('ranking-row-1678');
  });

  it('reorders rows when a column header is clicked', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getByTestId, getAllByTestId } = render(<RankingView eventKey="2026casnv" />);

    // Click team-number header → sort ascending by team number puts 254 first
    // (254 < 1678). Click scoutingExpectedPoints once → ascending puts 1678 first.
    fireEvent.click(getByTestId('sort-scoutingExpectedPoints'));
    const rows = getAllByTestId(/^ranking-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('ranking-row-1678');
    expect(rows[1].getAttribute('data-testid')).toBe('ranking-row-254');
  });

  it('sorts by team number when its header is clicked', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getByTestId, getAllByTestId } = render(<RankingView eventKey="2026casnv" />);
    fireEvent.click(getByTestId('sort-teamNumber'));
    const rows = getAllByTestId(/^ranking-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('ranking-row-254');
    expect(rows[1].getAttribute('data-testid')).toBe('ranking-row-1678');
  });

  it('falls back to an in-house scouting EPA when no external EPA is available', () => {
    reportsReturn = { data: reports, isLoading: false };
    epaReturn = { data: { epaByTeam: new Map(), available: false, source: 'none' } };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    const row254 = getByTestId('ranking-row-254');
    // No "—": the EPA cell shows our in-house scouting estimate (a number) + "est".
    const cell = within(row254).getByTestId('epa-254');
    expect(cell.textContent).not.toBe('—');
    expect(cell.textContent).toMatch(/^\d+est$/);
    // Banner explains the fallback source.
    expect(getByTestId('dash-ranking-epa-banner').textContent).toMatch(/in-house/i);
  });

  it('shows the EPA value when Statbotics is available', () => {
    reportsReturn = { data: reports, isLoading: false };
    epaReturn = {
      data: { epaByTeam: new Map([[254, 55], [1678, null]]), available: true },
    };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(within(getByTestId('ranking-row-254')).getByTestId('epa-254').textContent).toBe('55');
    // null EPA still renders "—"
    expect(within(getByTestId('ranking-row-1678')).getByTestId('epa-1678').textContent).toBe('—');
  });

  it('shows "—" for TBA rank when rankings are unavailable', () => {
    reportsReturn = { data: reports, isLoading: false };
    tbaReturn = { data: undefined };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(within(getByTestId('ranking-row-254')).getByTestId('tba-254').textContent).toBe('—');
  });

  it('matches TBA rank by team_key frc{n}', () => {
    reportsReturn = { data: reports, isLoading: false };
    tbaReturn = {
      data: { rankings: [{ rank: 1, team_key: 'frc254' }, { rank: 7, team_key: 'frc1678' }] },
    };
    const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(within(getByTestId('ranking-row-254')).getByTestId('tba-254').textContent).toBe('1');
    expect(within(getByTestId('ranking-row-1678')).getByTestId('tba-1678').textContent).toBe('7');
  });

  it('calls onSelectTeam with the team number when its cell button is clicked', () => {
    reportsReturn = { data: reports, isLoading: false };
    const onSelectTeam = vi.fn();
    const { getByTestId } = render(
      <RankingView eventKey="2026casnv" onSelectTeam={onSelectTeam} />,
    );
    fireEvent.click(getByTestId('ranking-team-254'));
    expect(onSelectTeam).toHaveBeenCalledWith(254);
  });

  it('renders the team number as plain text when onSelectTeam is absent', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { queryByTestId, getByTestId } = render(<RankingView eventKey="2026casnv" />);
    expect(queryByTestId('ranking-team-254')).toBeNull();
    // The number is still shown in the row.
    expect(within(getByTestId('ranking-row-254')).getByText('254')).toBeTruthy();
  });

  it('selecting teams populates the compare panel', () => {
    reportsReturn = { data: reports, isLoading: false };
    const { getByTestId, queryByTestId } = render(<RankingView eventKey="2026casnv" />);
    // No compare panel before any selection.
    expect(queryByTestId('compare-panel')).toBeNull();

    fireEvent.click(getByTestId('cmp-254'));
    fireEvent.click(getByTestId('cmp-1678'));

    const panel = getByTestId('compare-panel');
    expect(panel).toBeTruthy();
    expect(within(panel).getByText('254')).toBeTruthy();
    expect(within(panel).getByText('1678')).toBeTruthy();
  });

  describe('user-selectable columns', () => {
    it('shows all columns by default (parity) and the Team column is always present', () => {
      reportsReturn = { data: reports, isLoading: false };
      const { getByTestId, getAllByTestId } = render(<RankingView eventKey="2026casnv" />);
      // Default: every stat header renders.
      expect(getByTestId('sort-matchesScouted')).toBeTruthy();
      expect(getByTestId('sort-climbSuccessRate')).toBeTruthy();
      expect(getByTestId('sort-epa')).toBeTruthy();
      // The identity column is shown…
      expect(getByTestId('sort-teamNumber')).toBeTruthy();
      // …and team numbers still render in the body.
      const row254 = getByTestId('ranking-row-254');
      expect(within(row254).getByText('254')).toBeTruthy();
      expect(getAllByTestId(/^ranking-row-/).length).toBe(2);
    });

    it('Team is not offered as a toggleable option in the picker', () => {
      reportsReturn = { data: reports, isLoading: false };
      const { getByTestId, queryByTestId } = render(<RankingView eventKey="2026casnv" />);
      fireEvent.click(getByTestId('ranking-columns-toggle'));
      // A toggleable stat option exists…
      expect(getByTestId('ranking-col-opt-climbSuccessRate')).toBeTruthy();
      // …but the identity column has no checkbox.
      expect(queryByTestId('ranking-col-opt-teamNumber')).toBeNull();
    });

    it('toggling a column off hides its header and every body cell', () => {
      reportsReturn = { data: reports, isLoading: false };
      const { getByTestId, queryByTestId } = render(<RankingView eventKey="2026casnv" />);
      // Climb % is visible to start.
      expect(getByTestId('sort-climbSuccessRate')).toBeTruthy();

      fireEvent.click(getByTestId('ranking-columns-toggle'));
      fireEvent.click(getByTestId('ranking-col-opt-climbSuccessRate'));

      // Header gone — the column is hidden for every row.
      expect(queryByTestId('sort-climbSuccessRate')).toBeNull();
    });

    it('toggling a testid-bearing column off removes its body cells', () => {
      reportsReturn = { data: reports, isLoading: false };
      const { getByTestId, queryByTestId } = render(<RankingView eventKey="2026casnv" />);
      expect(getByTestId('epa-254')).toBeTruthy();

      fireEvent.click(getByTestId('ranking-columns-toggle'));
      fireEvent.click(getByTestId('ranking-col-opt-epa'));

      expect(queryByTestId('sort-epa')).toBeNull();
      expect(queryByTestId('epa-254')).toBeNull();
      expect(queryByTestId('epa-1678')).toBeNull();
    });

    it('persists the choice across remounts via localStorage', () => {
      reportsReturn = { data: reports, isLoading: false };
      const first = render(<RankingView eventKey="2026casnv" />);
      fireEvent.click(first.getByTestId('ranking-columns-toggle'));
      fireEvent.click(first.getByTestId('ranking-col-opt-climbSuccessRate'));
      expect(first.queryByTestId('sort-climbSuccessRate')).toBeNull();

      // Re-mount fresh: the hidden choice is read back from localStorage.
      cleanup();
      const second = render(<RankingView eventKey="2026casnv" />);
      expect(second.queryByTestId('sort-climbSuccessRate')).toBeNull();
      // Other columns are still visible.
      expect(second.getByTestId('sort-epa')).toBeTruthy();
    });

    it('re-showing a hidden column brings it back', () => {
      reportsReturn = { data: reports, isLoading: false };
      const { getByTestId, queryByTestId } = render(<RankingView eventKey="2026casnv" />);
      fireEvent.click(getByTestId('ranking-columns-toggle'));
      fireEvent.click(getByTestId('ranking-col-opt-reliability'));
      expect(queryByTestId('sort-reliability')).toBeNull();
      fireEvent.click(getByTestId('ranking-col-opt-reliability'));
      expect(getByTestId('sort-reliability')).toBeTruthy();
    });

    it('ignores corrupt localStorage JSON and shows all columns', () => {
      localStorage.setItem('ranking-visible-columns', '{not valid json');
      reportsReturn = { data: reports, isLoading: false };
      const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
      expect(getByTestId('sort-climbSuccessRate')).toBeTruthy();
      expect(getByTestId('sort-epa')).toBeTruthy();
    });
  });

  describe('distribution + recent-form compare rows', () => {
    // Team 11 is consistent (low σ) + improving; team 22 is swingy (high σ) + stable.
    const distReports: MsrRow[] = [
      // Consistent + improving: {10,10,30,30,30} (last-3 mean 30 vs all-mean 22).
      ...[10, 10, 30, 30, 30].map((f, i) =>
        row({ target_team_number: 11, match_key: `evt_qm${i + 1}`, fuel_points: f }),
      ),
      // Swingy + stable: {20,40,0,40,0} mean 20, last-3 mean ~13.3… → fading-ish.
      // Use {20,20,20,20,20} so it's perfectly stable but make 22 the HIGHER σ via spread.
      ...[5, 35, 5, 35, 20].map((f, i) =>
        row({ target_team_number: 22, match_key: `evt_qm${i + 1}`, fuel_points: f }),
      ),
    ];

    it('flags the lower-σ team on the Fuel σ row and never flags a winner on Recent Form', () => {
      reportsReturn = { data: distReports, isLoading: false };
      const { getByTestId } = render(<RankingView eventKey="2026casnv" />);
      fireEvent.click(getByTestId('cmp-11'));
      fireEvent.click(getByTestId('cmp-22'));
      const panel = getByTestId('compare-panel');

      // --- Fuel σ row: lower-σ team (11) wins; the other does NOT. ---
      const fuelSigmaRow = within(panel)
        .getByText('Fuel σ')
        .closest('tr') as HTMLTableRowElement;
      const sigmaCells = within(fuelSigmaRow).getAllByRole('cell');
      // cells[0] is the label; team columns follow in selection order (11, 22).
      expect(sigmaCells[1].className).toMatch(/text-success/);
      expect(sigmaCells[2].className).not.toMatch(/text-success/);

      // --- Recent Form row: labels render, but NO cell is ever winner-flagged. ---
      const formRow = within(panel)
        .getByText('Recent Form')
        .closest('tr') as HTMLTableRowElement;
      const formCells = within(formRow).getAllByRole('cell');
      expect(formCells[1].textContent).toMatch(/Improving \+/);
      expect(formCells[1].className).not.toMatch(/text-success/);
      expect(formCells[2].className).not.toMatch(/text-success/);
    });
  });
});
