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
  // Real (pure) list-membership resolution — mirrors picklistClient.entryList.
  entryList: (e: PicklistEntry) => (e.tierType === 'second' ? 'second' : 'first'),
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
    { team_number: 9999, nickname: 'Test Bots' },
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

  it('links a row team number to the Team tab via onSelectTeam', async () => {
    const onSelectTeam = vi.fn();
    const utils = render(<PicklistView eventKey="2026casnv" onSelectTeam={onSelectTeam} />);
    await waitFor(() => expect(utils.getByTestId('pick-team-254')).toBeTruthy());
    fireEvent.click(utils.getByTestId('pick-team-254'));
    expect(onSelectTeam).toHaveBeenCalledWith(254);
  });

  it('renders team numbers as plain text without onSelectTeam', async () => {
    const { queryByTestId } = await renderLoaded();
    expect(queryByTestId('pick-team-254')).toBeNull();
  });

  it('adds a team via the add input + button (ignoring duplicates/invalid)', async () => {
    const { getByTestId, getAllByTestId } = await renderLoaded();
    const input = getByTestId('pick-add-input') as HTMLInputElement;

    // valid new event team appends
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

  it('rejects a team not competing at the event and surfaces a warning (BUG-11)', async () => {
    const { getByTestId, getAllByTestId, queryByTestId } = await renderLoaded();
    const input = getByTestId('pick-add-input') as HTMLInputElement;

    // 88888 is not in teamsFixture → rejected, error shown, no row added
    fireEvent.change(input, { target: { value: '88888' } });
    fireEvent.click(getByTestId('pick-add'));
    expect(getAllByTestId(/^pick-row-/).length).toBe(2);
    expect(getByTestId('pick-add-error').textContent).toMatch(/not competing/i);
    // the bogus value is kept so the lead can correct it
    expect(input.value).toBe('88888');

    // typing a valid event team clears the error and previews its name
    fireEvent.change(input, { target: { value: '9999' } });
    expect(queryByTestId('pick-add-error')).toBeNull();
    expect(getByTestId('pick-add-preview').textContent).toBe('Test Bots');
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

  it('autosaves the current ordered entries and shows a saved indicator', async () => {
    const { getByTestId } = await renderLoaded();
    // reorder — autosave persists it (no Save button)
    fireEvent.click(getByTestId('pick-up-1678'));

    await waitFor(() => expect(savePicklistMock).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [eventKey, entries] = savePicklistMock.mock.calls[0] as [string, PicklistEntry[]];
    expect(eventKey).toBe('2026casnv');
    expect(entries.map((e) => e.teamNumber)).toEqual([1678, 254]);

    await waitFor(() => expect(getByTestId("pick-saved")).toBeTruthy(), { timeout: 3000 });
  });

  it('edits the note input and autosaves it', async () => {
    const { getByTestId } = await renderLoaded();
    const row = getByTestId('pick-row-254');
    const note = within(row).getByTestId('pick-note-254') as HTMLInputElement;

    fireEvent.change(note, { target: { value: 'fast cycle' } });

    await waitFor(() => expect(savePicklistMock).toHaveBeenCalled(), { timeout: 3000 });
    const entries = savePicklistMock.mock.calls.at(-1)![1] as PicklistEntry[];
    const e254 = entries.find((e) => e.teamNumber === 254)!;
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

  it('shows the empty-state in the dialog only when the event has NO teams at all', async () => {
    reportsFixture = [];
    teamsFixture = [];
    getPicklistMock.mockResolvedValue([]);
    const { getByTestId } = render(<PicklistView eventKey="2026casnv" />);
    await waitFor(() => expect(getByTestId('pick-empty')).toBeTruthy());
    fireEvent.click(getByTestId('pick-seed-open'));
    expect(getByTestId('pick-seed-empty')).toBeTruthy();
    expect((getByTestId('pick-seed-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('seed dialog ranks the WHOLE field: unscouted event teams get empty aggs', async () => {
    reportsFixture = []; // nobody scouted yet — EPA-only seeding must still work
    seedPicklistMock.mockReturnValue([
      { teamNumber: 254, tier: null, note: null, tierType: null, dnp: false },
    ]);
    getPicklistMock.mockResolvedValue([]);
    const { getByTestId, queryByTestId } = render(<PicklistView eventKey="2026casnv" />);
    await waitFor(() => expect(getByTestId('pick-empty')).toBeTruthy());
    fireEvent.click(getByTestId('pick-seed-open'));
    // Not the empty state — every event team is seedable.
    expect(queryByTestId('pick-seed-empty')).toBeNull();
    fireEvent.click(getByTestId('pick-seed-confirm'));
    const opts = seedPicklistMock.mock.calls.at(-1)![0] as { aggs: Array<{ teamNumber: number }> };
    expect(opts.aggs.map((a) => a.teamNumber).sort((x, y) => x - y)).toEqual([254, 1678, 9999]);
    await waitFor(() => expect(getByTestId('pick-row-254')).toBeTruthy());
  });

  it('marks a team do-not-pick from the EPA board and autosaves it (not as a pick row)', async () => {
    const { getByTestId, queryByTestId } = await renderLoaded();

    // 9999 isn't on the picklist, so the board shows its DNP toggle.
    fireEvent.click(getByTestId('epa-board-dnp-9999'));
    await waitFor(() => expect(savePicklistMock).toHaveBeenCalled(), { timeout: 3000 });
    const entries = savePicklistMock.mock.calls.at(-1)![1] as PicklistEntry[];
    expect(entries.find((e) => e.teamNumber === 9999)?.dnp).toBe(true);
    // A DNP team never appears as an ordered pick row.
    expect(queryByTestId('pick-row-9999')).toBeNull();
  });

  // --- Two picklists: 1st pick / 2nd pick ---

  it('shows the 1st-pick list by default with entries lacking tierType (legacy)', async () => {
    const { getByTestId } = await renderLoaded();
    // Legacy entries (no tierType) belong to the 1st-pick list.
    expect(getByTestId('pick-list-first').getAttribute('aria-selected')).toBe('true');
    expect(getByTestId('pick-row-254')).toBeTruthy();
    expect(getByTestId('pick-row-1678')).toBeTruthy();
  });

  it('splits entries into the two lists by tierType and switches between them', async () => {
    getPicklistMock.mockResolvedValue([
      { teamNumber: 254, tier: null, note: null, tierType: null, dnp: false },
      { teamNumber: 1678, tier: null, note: null, tierType: 'second', dnp: false },
    ]);
    const { getByTestId, queryByTestId } = await renderLoaded();
    // 1st list shows only 254.
    expect(getByTestId('pick-row-254')).toBeTruthy();
    expect(queryByTestId('pick-row-1678')).toBeNull();
    // Switch to the 2nd list → only 1678.
    fireEvent.click(getByTestId('pick-list-second'));
    expect(queryByTestId('pick-row-254')).toBeNull();
    expect(getByTestId('pick-row-1678')).toBeTruthy();
  });

  it('moves a team to the other list and autosaves tierType', async () => {
    const { getByTestId, queryByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-move-list-254')); // 1st → 2nd

    // Gone from the active (1st) list, present under the 2nd tab.
    expect(queryByTestId('pick-row-254')).toBeNull();
    fireEvent.click(getByTestId('pick-list-second'));
    expect(getByTestId('pick-row-254')).toBeTruthy();

    await waitFor(() => expect(savePicklistMock).toHaveBeenCalled(), { timeout: 3000 });
    const entries = savePicklistMock.mock.calls.at(-1)![1] as PicklistEntry[];
    const e254 = entries.find((e) => e.teamNumber === 254)!;
    expect(e254.tierType).toBe('second');
    // Canonical persist order: 1st-list entries before 2nd-list entries.
    expect(entries.map((e) => e.teamNumber)).toEqual([1678, 254]);
  });

  it('adds a team to the ACTIVE (2nd) list', async () => {
    const { getByTestId, queryByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-list-second'));
    const input = getByTestId('pick-add-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.click(getByTestId('pick-add'));
    await waitFor(() => expect(getByTestId('pick-row-9999')).toBeTruthy());

    // Not on the 1st list.
    fireEvent.click(getByTestId('pick-list-first'));
    expect(queryByTestId('pick-row-9999')).toBeNull();

    await waitFor(() => expect(savePicklistMock).toHaveBeenCalled(), { timeout: 3000 });
    const entries = savePicklistMock.mock.calls.at(-1)![1] as PicklistEntry[];
    expect(entries.find((e) => e.teamNumber === 9999)?.tierType).toBe('second');
  });

  it('rejects adding a team that is already on the OTHER list', async () => {
    const { getByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-list-second'));
    const input = getByTestId('pick-add-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '254' } }); // on the 1st list
    fireEvent.click(getByTestId('pick-add'));
    expect(getByTestId('pick-add-error').textContent).toMatch(/already on the picklist/i);
  });

  it('reorders within a list without disturbing the other list', async () => {
    getPicklistMock.mockResolvedValue([
      { teamNumber: 254, tier: null, note: null, tierType: null, dnp: false },
      { teamNumber: 1678, tier: null, note: null, tierType: null, dnp: false },
      { teamNumber: 9999, tier: null, note: null, tierType: 'second', dnp: false },
    ]);
    const { getByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-up-1678')); // 1st list → 1678, 254

    await waitFor(() => expect(savePicklistMock).toHaveBeenCalled(), { timeout: 3000 });
    const entries = savePicklistMock.mock.calls.at(-1)![1] as PicklistEntry[];
    expect(entries.map((e) => e.teamNumber)).toEqual([1678, 254, 9999]);
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

  it('seed replace only swaps the ACTIVE list — the other list survives', async () => {
    getPicklistMock.mockResolvedValue([
      { teamNumber: 254, tier: null, note: null, tierType: null, dnp: false },
      { teamNumber: 1678, tier: null, note: null, tierType: 'second', dnp: false },
    ]);
    reportsFixture = [msr(111, 50)];
    seedPicklistMock.mockReturnValue([
      { teamNumber: 111, tier: null, note: null, tierType: null, dnp: false },
    ]);
    const { getByTestId, queryByTestId } = await renderLoaded();
    fireEvent.click(getByTestId('pick-seed-open'));
    fireEvent.click(getByTestId('pick-seed-confirm')); // replace, active = 1st list
    await waitFor(() => expect(getByTestId('pick-row-111')).toBeTruthy());
    expect(queryByTestId('pick-row-254')).toBeNull(); // 1st list replaced
    // The 2nd list is untouched.
    fireEvent.click(getByTestId('pick-list-second'));
    expect(getByTestId('pick-row-1678')).toBeTruthy();
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
