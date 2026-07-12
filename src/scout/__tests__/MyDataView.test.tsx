import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LocalMatchReport } from '@/db/types';

vi.mock('@/auth/useSession', () => ({
  useSession: () => ({
    scout: {
      id: 'scout-current',
      display_name: ' Ada Lovelace ',
      event_key: '2026demo',
    },
    session: {},
    loading: false,
  }),
}));

vi.mock('@/dash/useActiveEvent', () => ({
  useActiveEvent: () => ({
    eventKey: '2026demo',
    loading: false,
    authoritative: true,
  }),
}));

const listReportsMock = vi.fn();
vi.mock('@/db/localStore', () => ({
  listReports: () => listReportsMock(),
}));

import MyDataView from '../MyDataView';

function mkReport(over: Partial<LocalMatchReport>): LocalMatchReport {
  return {
    id: over.id ?? 'r1',
    eventKey: over.eventKey ?? '2026demo',
    scoutId: over.scoutId ?? 'scout-current',
    scoutName: 'scoutName' in over ? over.scoutName : 'Ada Lovelace',
    matchKey: over.matchKey ?? 'qm1',
    targetTeamNumber: over.targetTeamNumber ?? 254,
    fuelPoints: over.fuelPoints ?? 42,
    climbLevel: over.climbLevel ?? 0,
    defenseDurationMs: over.defenseDurationMs ?? 0,
    defendedDurationMs: over.defendedDurationMs ?? 0,
    notes: over.notes ?? '',
    createdAt: over.createdAt ?? '2026-06-23T00:00:00.000Z',
  } as unknown as LocalMatchReport;
}

beforeEach(() => {
  listReportsMock.mockReset();
});

describe('MyDataView', () => {
  it('shows only the active event and normalized current scouter name, newest first', async () => {
    listReportsMock.mockResolvedValue([
      mkReport({
        id: 'a',
        matchKey: 'qm1',
        createdAt: '2026-06-23T00:00:01.000Z',
      }),
      mkReport({
        id: 'b',
        scoutId: 'reconciled-scout-id',
        scoutName: '  ADA   LOVELACE ',
        matchKey: 'qm2',
        createdAt: '2026-06-23T00:00:02.000Z',
      }),
      // Legacy report without scoutName: strict ID is the compatibility fallback.
      mkReport({
        id: 'c',
        scoutName: undefined,
        matchKey: 'qm3',
        createdAt: '2026-06-23T00:00:03.000Z',
      }),
      mkReport({
        id: 'other-scout',
        scoutName: 'Grace Hopper',
        matchKey: 'qm4',
        createdAt: '2026-06-23T00:00:04.000Z',
      }),
      mkReport({
        id: 'other-event',
        eventKey: '2026other',
        matchKey: 'qm5',
        createdAt: '2026-06-23T00:00:05.000Z',
      }),
    ]);

    render(
      <MemoryRouter>
        <MyDataView />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByTestId('my-data-row').length).toBe(3));

    const rows = screen.getAllByTestId('my-data-row');
    // The changed scout ID still matches by name; foreign name/event rows do not.
    expect(rows[0].textContent).toContain('qm3');
    expect(rows[1].textContent).toContain('qm2');
    expect(rows[2].textContent).toContain('qm1');
    expect(screen.queryByText('qm4')).toBeNull();
    expect(screen.queryByText('qm5')).toBeNull();
  });

  it('renders the scoped empty state when only other scouts or events have matches', async () => {
    listReportsMock.mockResolvedValue([
      mkReport({ scoutName: 'Grace Hopper' }),
      mkReport({ eventKey: '2026other' }),
    ]);
    render(
      <MemoryRouter>
        <MyDataView />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('my-data-empty')).toBeTruthy());
    expect(screen.getByTestId('my-data-empty')).toHaveTextContent(
      'No matches scouted yet for this event.',
    );
  });

  it('shows exact defense + being-defended durations in seconds', async () => {
    listReportsMock.mockResolvedValue([
      mkReport({ id: 'a', defenseDurationMs: 4200, defendedDurationMs: 1500 }),
    ]);
    render(
      <MemoryRouter>
        <MyDataView />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('my-data-row')).toBeTruthy());
    const row = screen.getByTestId('my-data-row');
    expect(row.textContent).toContain('4.2s');
    expect(row.textContent).toContain('1.5s');
  });
});
