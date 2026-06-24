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
  getPicklistMock.mockResolvedValue(TWO.map((e) => ({ ...e })));
  savePicklistMock.mockResolvedValue(undefined);
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
});
