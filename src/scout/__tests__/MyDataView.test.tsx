import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { LocalMatchReport } from '@/db/types';

vi.mock('@/auth/useSession', () => ({
  useSession: () => ({ scout: { id: 'scout-1', display_name: 'Ada' }, session: {}, loading: false }),
}));

const listReportsMock = vi.fn();
vi.mock('@/db/localStore', () => ({
  listReports: () => listReportsMock(),
}));

import MyDataView from '../MyDataView';

function mkReport(over: Partial<LocalMatchReport>): LocalMatchReport {
  return {
    id: over.id ?? 'r1',
    scoutId: over.scoutId ?? 'scout-1',
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
  it('shows only the current scout’s matches, newest first', async () => {
    listReportsMock.mockResolvedValue([
      mkReport({ id: 'a', scoutId: 'scout-1', matchKey: 'qm1', createdAt: '2026-06-23T00:00:01.000Z' }),
      mkReport({ id: 'b', scoutId: 'scout-2', matchKey: 'qm2', createdAt: '2026-06-23T00:00:02.000Z' }),
      mkReport({ id: 'c', scoutId: 'scout-1', matchKey: 'qm3', createdAt: '2026-06-23T00:00:03.000Z' }),
    ]);

    render(<MyDataView />);
    await waitFor(() => expect(screen.getAllByTestId('my-data-row').length).toBe(2));

    const rows = screen.getAllByTestId('my-data-row');
    // newest first: qm3 before qm1
    expect(rows[0].textContent).toContain('qm3');
    expect(rows[1].textContent).toContain('qm1');
    // foreign scout's match excluded
    expect(screen.queryByText('qm2')).toBeNull();
  });

  it('renders the empty state when the scout has no matches', async () => {
    listReportsMock.mockResolvedValue([mkReport({ scoutId: 'scout-2' })]);
    render(<MyDataView />);
    await waitFor(() => expect(screen.getByTestId('my-data-empty')).toBeTruthy());
  });

  it('shows exact defense + being-defended durations in seconds', async () => {
    listReportsMock.mockResolvedValue([
      mkReport({ id: 'a', scoutId: 'scout-1', defenseDurationMs: 4200, defendedDurationMs: 1500 }),
    ]);
    render(<MyDataView />);
    await waitFor(() => expect(screen.getByTestId('my-data-row')).toBeTruthy());
    const row = screen.getByTestId('my-data-row');
    expect(row.textContent).toContain('4.2s');
    expect(row.textContent).toContain('1.5s');
  });
});
