// src/dash/__tests__/PicklistView.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { PicklistEntry } from '@/dash/picklistClient';

// --- mock the picklist client ---
const getPicklistMock = vi.fn();
const savePicklistMock = vi.fn();
vi.mock('@/dash/picklistClient', () => ({
  getPicklist: (eventKey: string) => getPicklistMock(eventKey),
  savePicklist: (eventKey: string, entries: PicklistEntry[]) =>
    savePicklistMock(eventKey, entries),
}));

// --- mock exportDash so we can assert downloads without touching the DOM blob ---
const downloadTextMock = vi.fn();
vi.mock('@/dash/exportDash', () => ({
  downloadText: (name: string, mime: string, text: string) =>
    downloadTextMock(name, mime, text),
  picklistToCsv: (entries: PicklistEntry[]) => `csv:${entries.length}`,
}));

// --- mock presetExports WHOLESALE so this stays a pure wiring test. The real
// preset builders import csvField/csvRow from the partially-mocked exportDash
// (which omits them), so running them here would break. ---
const fetchTeamMetadataMock = vi.fn();
const buildPresetRowsMock = vi.fn();
const allianceSheetToCsvMock = vi.fn();
const picklistToolCsvMock = vi.fn();
const allianceSheetToHtmlMock = vi.fn();
vi.mock('@/dash/presetExports', () => ({
  fetchTeamMetadata: (...a: unknown[]) => fetchTeamMetadataMock(...a),
  buildPresetRows: (...a: unknown[]) => buildPresetRowsMock(...a),
  allianceSheetToCsv: (...a: unknown[]) => allianceSheetToCsvMock(...a),
  picklistToolCsv: (...a: unknown[]) => picklistToolCsvMock(...a),
  allianceSheetToHtml: (...a: unknown[]) => allianceSheetToHtmlMock(...a),
}));

// --- mock the print side-effect ---
const openPrintWindowMock = vi.fn();
vi.mock('@/dash/printWindow', () => ({
  openPrintWindow: (html: string) => openPrintWindowMock(html),
}));

// --- mock the dashboard data hooks (small fixtures) ---
let epaFixture: { epaByTeam: Map<number, number | null>; available: boolean; source: string; sourceByTeam: Map<number, string> };
let reportsFixture: unknown[];
let teamsFixture: Array<{ team_number: number; nickname: string | null }>;
vi.mock('@/dash/useEventData', () => ({
  useEventReports: () => ({ data: reportsFixture }),
  useEventMatches: () => ({ data: [] }),
  useEventEpa: () => ({ data: epaFixture }),
  useEventTeams: () => ({ data: teamsFixture }),
}));

// --- mock the pure seeder so seed wiring tests don't need fixture reports ---
import type { PicklistEntry as PE } from '@/dash/picklistClient';
const seedPicklistMock = vi.fn();
vi.mock('@/dash/picklistSeeding', () => ({
  seedPicklist: (...a: unknown[]) => seedPicklistMock(...a) as PE[],
}));

// aggregateEvent is called with reportsQuery.data ([]) → empty map; keep real impl.

import PicklistView from '@/dash/PicklistView';

const TWO: PicklistEntry[] = [
  { teamNumber: 254, tier: 'A', note: 'shooter' },
  { teamNumber: 1678, tier: 'B', note: null },
];

beforeEach(() => {
  cleanup();
  getPicklistMock.mockReset();
  savePicklistMock.mockReset();
  downloadTextMock.mockReset();
  fetchTeamMetadataMock.mockReset();
  buildPresetRowsMock.mockReset();
  allianceSheetToCsvMock.mockReset();
  picklistToolCsvMock.mockReset();
  allianceSheetToHtmlMock.mockReset();
  openPrintWindowMock.mockReset();
  seedPicklistMock.mockReset();
  reportsFixture = [];
  teamsFixture = [
    { team_number: 254, nickname: 'The Cheesy Poofs' },
    { team_number: 1678, nickname: 'Citrus Circuits' },
  ];
  getPicklistMock.mockResolvedValue(TWO.map((e) => ({ ...e })));
  savePicklistMock.mockResolvedValue(undefined);
  fetchTeamMetadataMock.mockResolvedValue(new Map());
  buildPresetRowsMock.mockReturnValue([{ rank: 1, teamNumber: 254 }]);
  allianceSheetToCsvMock.mockReturnValue('ALLIANCE_CSV');
  picklistToolCsvMock.mockReturnValue('TOOL_CSV');
  allianceSheetToHtmlMock.mockReturnValue('<!doctype html><title>x</title>');
  epaFixture = {
    epaByTeam: new Map([
      [254, 45],
      [1678, 30],
    ]),
    available: true,
    source: 'statbotics',
    sourceByTeam: new Map([
      [254, 'statbotics'],
      [1678, 'statbotics'],
    ]),
  };
});

/** Render and wait until the loaded rows are present. */
async function renderLoaded() {
  const utils = render(<PicklistView eventKey="2026casnv" />);
  await waitFor(() => expect(utils.getByTestId('pick-row-254')).toBeTruthy());
  return utils;
}

describe('PicklistView', () => {
  it('shows a loading state then loads entries from getPicklist', async () => {
    let resolve!: (v: PicklistEntry[]) => void;
    getPicklistMock.mockReturnValue(new Promise<PicklistEntry[]>((r) => (resolve = r)));
    const { getByTestId, queryByTestId } = render(<PicklistView eventKey="2026casnv" />);
    expect(getByTestId('pick-loading')).toBeTruthy();
    resolve(TWO.map((e) => ({ ...e })));
    await waitFor(() => expect(queryByTestId('pick-loading')).toBeNull());
    expect(getPicklistMock).toHaveBeenCalledWith('2026casnv');
    expect(getByTestId('pick-row-254')).toBeTruthy();
    expect(getByTestId('pick-row-1678')).toBeTruthy();
  });

  it('shows an empty state when the picklist is empty', async () => {
    getPicklistMock.mockResolvedValue([]);
    const { getByTestId } = render(<PicklistView eventKey="2026casnv" />);
    await waitFor(() => expect(getByTestId('pick-empty')).toBeTruthy());
  });

  it('renders one row per entry', async () => {
    const { getByTestId } = await renderLoaded();
    expect(getByTestId('pick-row-254')).toBeTruthy();
    expect(getByTestId('pick-row-1678')).toBeTruthy();
  });

  it('adds a team via the add input + button (ignoring duplicates/invalid)', async () => {
    const { getByTestId, getAllByTestId } = await renderLoaded();
    const input = getByTestId('pick-add-input') as HTMLInputElement;

    // valid new team appends
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.click(getByTestId('pick-add'));
    await waitFor(() => expect(getByTestId('pick-row-9999')).toBeTruthy());

    // duplicate is ignored (still exactly one 254 row)
    fireEvent.change(input, { target: { value: '254' } });
    fireEvent.click(getByTestId('pick-add'));
    expect(getAllByTestId(/^pick-row-/).length).toBe(3);

    // invalid is ignored
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.click(getByTestId('pick-add'));
    expect(getAllByTestId(/^pick-row-/).length).toBe(3);
  });

  it('reorders rows with up/down', async () => {
    const { getByTestId, getAllByTestId } = await renderLoaded();
    // initial order: 254, 1678
    let rows = getAllByTestId(/^pick-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'pick-row-254',
      'pick-row-1678',
    ]);

    // move 1678 up → 1678, 254
    fireEvent.click(getByTestId('pick-up-1678'));
    rows = getAllByTestId(/^pick-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'pick-row-1678',
      'pick-row-254',
    ]);

    // move 1678 down → back to 254, 1678
    fireEvent.click(getByTestId('pick-down-1678'));
    rows = getAllByTestId(/^pick-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'pick-row-254',
      'pick-row-1678',
    ]);
  });

  it('removes a row', async () => {
    const { getByTestId, queryByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-remove-254'));
    await waitFor(() => expect(queryByTestId('pick-row-254')).toBeNull());
    expect(getByTestId('pick-row-1678')).toBeTruthy();
  });

  it('saves the current ordered entries and shows a saved indicator', async () => {
    const { getByTestId } = await renderLoaded();
    // reorder first so we can assert the saved order
    fireEvent.click(getByTestId('pick-up-1678'));
    fireEvent.click(getByTestId('pick-save'));

    await waitFor(() => expect(savePicklistMock).toHaveBeenCalledTimes(1));
    const [eventKey, entries] = savePicklistMock.mock.calls[0] as [string, PicklistEntry[]];
    expect(eventKey).toBe('2026casnv');
    expect(entries.map((e) => e.teamNumber)).toEqual([1678, 254]);

    await waitFor(() => expect(getByTestId('pick-saved')).toBeTruthy());
  });

  it('edits tier and note inputs into state and saves them', async () => {
    const { getByTestId } = await renderLoaded();
    const row = getByTestId('pick-row-254');
    const tier = within(row).getByTestId('pick-tier-254') as HTMLInputElement;
    const note = within(row).getByTestId('pick-note-254') as HTMLInputElement;

    fireEvent.change(tier, { target: { value: 'S' } });
    fireEvent.change(note, { target: { value: 'fast cycle' } });
    fireEvent.click(getByTestId('pick-save'));

    await waitFor(() => expect(savePicklistMock).toHaveBeenCalledTimes(1));
    const entries = (savePicklistMock.mock.calls[0] as [string, PicklistEntry[]])[1];
    const e254 = entries.find((e) => e.teamNumber === 254)!;
    expect(e254.tier).toBe('S');
    expect(e254.note).toBe('fast cycle');
  });

  it('exports CSV via downloadText', async () => {
    const { getByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-export-csv'));
    expect(downloadTextMock).toHaveBeenCalledTimes(1);
    const [name, mime, text] = downloadTextMock.mock.calls[0] as [string, string, string];
    expect(name).toMatch(/\.csv$/);
    expect(mime).toContain('text/csv');
    expect(text).toBe('csv:2');
  });

  it('exports JSON via downloadText', async () => {
    const { getByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-export-json'));
    expect(downloadTextMock).toHaveBeenCalledTimes(1);
    const [name, mime, text] = downloadTextMock.mock.calls[0] as [string, string, string];
    expect(name).toMatch(/\.json$/);
    expect(mime).toContain('application/json');
    expect(JSON.parse(text)).toHaveLength(2);
  });

  it('renders the three export-preset buttons', async () => {
    const { getByTestId } = await renderLoaded();
    expect(getByTestId('pick-export-alliance-csv')).toBeTruthy();
    expect(getByTestId('pick-export-alliance-print')).toBeTruthy();
    expect(getByTestId('pick-export-tool-csv')).toBeTruthy();
  });

  it('Alliance Sheet (CSV) downloads alliance-sheet-{eventKey}.csv', async () => {
    const { getByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-export-alliance-csv'));
    await waitFor(() => expect(downloadTextMock).toHaveBeenCalledTimes(1));
    expect(fetchTeamMetadataMock).toHaveBeenCalledTimes(1);
    expect(allianceSheetToCsvMock).toHaveBeenCalledTimes(1);
    const [name, mime, text] = downloadTextMock.mock.calls[0] as [string, string, string];
    expect(name).toBe('alliance-sheet-2026casnv.csv');
    expect(mime).toContain('text/csv');
    expect(text).toBe('ALLIANCE_CSV');
  });

  it('Picklist Tool (CSV) downloads picklist-tool-{eventKey}.csv', async () => {
    const { getByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-export-tool-csv'));
    await waitFor(() => expect(downloadTextMock).toHaveBeenCalledTimes(1));
    expect(picklistToolCsvMock).toHaveBeenCalledTimes(1);
    const [name, , text] = downloadTextMock.mock.calls[0] as [string, string, string];
    expect(name).toBe('picklist-tool-2026casnv.csv');
    expect(text).toBe('TOOL_CSV');
  });

  it('Alliance Sheet (Print) opens a print window with an HTML doc', async () => {
    const { getByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-export-alliance-print'));
    await waitFor(() => expect(openPrintWindowMock).toHaveBeenCalledTimes(1));
    expect(allianceSheetToHtmlMock).toHaveBeenCalledTimes(1);
    const [html] = openPrintWindowMock.mock.calls[0] as [string];
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  // --- Smart-picklist: seed + DNP/tier flags ---

  /** Minimal MsrRow so aggregateEvent yields non-empty aggs (dialog non-empty). */
  function msr(team: number, fuel: number): Record<string, unknown> {
    return {
      target_team_number: team,
      match_key: `evt_qm${team}`,
      alliance_color: 'red',
      station: 1,
      auto_fuel: 0,
      teleop_fuel_active: 0,
      teleop_fuel_inactive: 0,
      endgame_fuel: 0,
      fuel_points: fuel,
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
    };
  }

  it('renders the Seed button and opens the dialog on click', async () => {
    const { getByTestId, queryByTestId } = await renderLoaded();
    expect(queryByTestId('pick-seed-dialog')).toBeNull();
    fireEvent.click(getByTestId('pick-seed-open'));
    expect(getByTestId('pick-seed-dialog')).toBeTruthy();
  });

  it('shows the empty-state in the dialog when there is no scouting data', async () => {
    reportsFixture = [];
    const { getByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-seed-open'));
    expect(getByTestId('pick-seed-empty')).toBeTruthy();
    expect((getByTestId('pick-seed-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('toggleDnp adds/removes the DNP badge and clears the saved indicator', async () => {
    const { getByTestId, queryByTestId } = await renderLoaded();
    // Save once so the saved indicator is showing, then a DNP edit must clear it.
    fireEvent.click(getByTestId('pick-save'));
    await waitFor(() => expect(getByTestId('pick-saved')).toBeTruthy());

    fireEvent.click(getByTestId('pick-dnp-254'));
    expect(getByTestId('pick-dnp-badge-254')).toBeTruthy();
    expect(queryByTestId('pick-saved')).toBeNull();

    // Toggling off removes the badge.
    fireEvent.click(getByTestId('pick-dnp-254'));
    expect(queryByTestId('pick-dnp-badge-254')).toBeNull();
  });

  it('cycleTier cycles — → 1st → 2nd → —', async () => {
    const { getByTestId } = await renderLoaded();
    const pill = getByTestId('pick-tier-type-254');
    expect(pill.textContent).toBe('—');
    fireEvent.click(pill);
    expect(pill.textContent).toBe('1st');
    fireEvent.click(pill);
    expect(pill.textContent).toBe('2nd');
    fireEvent.click(pill);
    expect(pill.textContent).toBe('—');
  });

  it('persists dnp/tierType through Save', async () => {
    const { getByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-dnp-254'));
    fireEvent.click(getByTestId('pick-tier-type-254')); // → first
    fireEvent.click(getByTestId('pick-save'));

    await waitFor(() => expect(savePicklistMock).toHaveBeenCalledTimes(1));
    const entries = (savePicklistMock.mock.calls[0] as [string, PicklistEntry[]])[1];
    const e254 = entries.find((e) => e.teamNumber === 254)!;
    expect(e254.dnp).toBe(true);
    expect(e254.tierType).toBe('first');
  });

  it('seeds in replace mode (replaces the whole list)', async () => {
    reportsFixture = [msr(111, 50), msr(222, 10)];
    seedPicklistMock.mockReturnValue([
      { teamNumber: 111, tier: null, note: null, tierType: null, dnp: false },
    ]);
    const { getByTestId, queryByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-seed-open'));
    fireEvent.click(getByTestId('pick-seed-confirm')); // replace is the default mode
    await waitFor(() => expect(getByTestId('pick-row-111')).toBeTruthy());
    // The prior manual entries (254, 1678) are gone in replace mode.
    expect(queryByTestId('pick-row-254')).toBeNull();
    expect(queryByTestId('pick-row-1678')).toBeNull();
  });

  it('seeds in append mode (keeps existing, adds new, skips duplicates)', async () => {
    reportsFixture = [msr(254, 50), msr(333, 10)];
    // Seeder returns 254 (already present) + 333 (new). Append must skip 254.
    seedPicklistMock.mockReturnValue([
      { teamNumber: 254, tier: null, note: null, tierType: null, dnp: false },
      { teamNumber: 333, tier: null, note: null, tierType: null, dnp: false },
    ]);
    const { getByTestId, getAllByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-seed-open'));
    fireEvent.click(getByTestId('pick-seed-mode-append'));
    fireEvent.click(getByTestId('pick-seed-confirm'));
    await waitFor(() => expect(getByTestId('pick-row-333')).toBeTruthy());
    // Existing 254 + 1678 stay; 333 added; no duplicate 254.
    const ids = getAllByTestId(/^pick-row-/).map((r) => r.getAttribute('data-testid'));
    expect(ids).toEqual(['pick-row-254', 'pick-row-1678', 'pick-row-333']);
  });

  it('hides the EPA banner for live Statbotics and shows it for in-house EPA', async () => {
    const { queryByTestId } = await renderLoaded();
    expect(queryByTestId('pick-export-epa-banner')).toBeNull();

    cleanup();
    epaFixture = {
      epaByTeam: new Map(),
      available: false,
      source: 'none',
      sourceByTeam: new Map(),
    };
    const { getByTestId } = await renderLoaded();
    const banner = getByTestId('pick-export-epa-banner');
    expect(banner.textContent).toContain('in-house estimate');
  });
});
