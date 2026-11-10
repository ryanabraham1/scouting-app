vi.mock('@/auth/useSession', () => ({ useSession: () => ({ scout: null, loading: false }), clearCachedScout: vi.fn() }));
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PicklistEntry } from '@/dash/picklistClient';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

vi.mock('@/dash/useActiveEvent', () => ({
  useActiveEvent: () => ({ eventKey: '2026demo', loading: false, authoritative: true }),
}));

vi.mock('@/db/localStore', () => ({
  db: {
    cachedTeams: {
      where: () => ({
        equals: () => ({
          toArray: () =>
            Promise.resolve([{ id: '2026demo:254', event_key: '2026demo', team_number: 254, nickname: 'Cheesy Poofs' }]),
        }),
      }),
    },
  },
}));

const getPicklistMock = vi.fn<(key: string) => Promise<PicklistEntry[]>>();
const getCachedPicklistMock = vi.fn<(key: string) => PicklistEntry[] | null>();
vi.mock('@/dash/picklistClient', async (orig) => ({
  ...(await orig<typeof import('@/dash/picklistClient')>()),
  getPicklist: (key: string) => getPicklistMock(key),
  getCachedPicklist: (key: string) => getCachedPicklistMock(key),
}));

import ScoutPicklistView, { splitPicklist } from '../ScoutPicklistView';

const ENTRIES: PicklistEntry[] = [
  { teamNumber: 254, tierType: 'first', note: 'Fast cycler' },
  { teamNumber: 1678, tierType: null },
  { teamNumber: 3256, tierType: 'second' },
  { teamNumber: 9999, dnp: true },
];

function renderView(): void {
  render(
    <MemoryRouter>
      <ScoutPicklistView />
    </MemoryRouter>,
  );
}

describe('splitPicklist', () => {
  it('splits into 1st, 2nd and do-not-pick, preserving order', () => {
    const { first, second, dnp } = splitPicklist(ENTRIES);
    expect(first.map((e) => e.teamNumber)).toEqual([254, 1678]);
    expect(second.map((e) => e.teamNumber)).toEqual([3256]);
    expect(dnp.map((e) => e.teamNumber)).toEqual([9999]);
  });
});

describe('ScoutPicklistView', () => {
  beforeEach(() => {
    getPicklistMock.mockReset();
    getCachedPicklistMock.mockReset();
    getCachedPicklistMock.mockReturnValue(null);
  });

  it('shows the live picklist read-only with team names and notes', async () => {
    getPicklistMock.mockResolvedValue(ENTRIES);
    renderView();
    const first = await screen.findByTestId('scout-picklist-first');
    expect(within(first).getAllByTestId('scout-picklist-first-row')).toHaveLength(2);
    expect(await within(first).findByText('Cheesy Poofs')).toBeTruthy();
    expect(within(first).getByText('Fast cycler')).toBeTruthy();
    expect(within(screen.getByTestId('scout-picklist-second')).getByText('3256')).toBeTruthy();
    expect(within(screen.getByTestId('scout-picklist-dnp')).getByText('9999')).toBeTruthy();
    expect(screen.queryByTestId('scout-picklist-cached')).toBeNull();
    expect(screen.queryByRole('button', { name: /remove|delete|move/i })).toBeNull();
  });

  it('falls back to the cached snapshot when offline', async () => {
    getCachedPicklistMock.mockReturnValue(ENTRIES);
    getPicklistMock.mockRejectedValue(new Error('Failed to fetch'));
    renderView();
    expect(await screen.findByTestId('scout-picklist-cached')).toBeTruthy();
    expect(screen.getAllByTestId('scout-picklist-first-row')).toHaveLength(2);
  });

  it('explains when nothing can be loaded', async () => {
    getPicklistMock.mockRejectedValue(new Error('Failed to fetch'));
    renderView();
    expect(await screen.findByTestId('scout-picklist-error')).toBeTruthy();
  });

  it('says so when the leads have not built a picklist', async () => {
    getPicklistMock.mockResolvedValue([]);
    renderView();
    expect(await screen.findByTestId('scout-picklist-empty')).toBeTruthy();
  });
});
