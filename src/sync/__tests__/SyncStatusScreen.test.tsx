import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// --- mock useSession (lead is staff) ---
const useSessionMock = vi.fn();
vi.mock('@/auth/useSession', () => ({
  useSession: () => useSessionMock(),
}));

// --- mock the supabase client; fetchCoverage queries `assignment` +
// `match_scouting_report`, both .select(...).eq('event_key', key). ---
const from = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { from: (...a: unknown[]) => from(...a) } }));

import SyncStatusScreen from '@/sync/SyncStatusScreen';

type Row = Record<string, unknown>;

// Build a query-chain mock: .select(...).eq(...) resolves to { data, error }.
function tableMock(data: Row[]) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ data, error: null }),
  };
}

function wireTables(assignments: Row[], reports: Row[]) {
  from.mockImplementation((t: string) => {
    if (t === 'assignment') return tableMock(assignments);
    if (t === 'match_scouting_report') return tableMock(reports);
    return tableMock([]);
  });
}

beforeEach(() => {
  useSessionMock.mockReset();
  from.mockReset();
  useSessionMock.mockReturnValue({
    scout: { id: 'lead-1', event_key: '2026demo' },
    session: {},
    role: 'lead',
    loading: false,
  });
  wireTables([], []);
});

describe('SyncStatusScreen', () => {
  it('renders the screen container', async () => {
    render(<SyncStatusScreen />);
    expect(await screen.findByTestId('sync-status')).toBeInTheDocument();
  });

  it('shows a no-active-event empty state', async () => {
    useSessionMock.mockReturnValue({ scout: null, session: {}, role: 'lead', loading: false });
    render(<SyncStatusScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('sync-status')).toHaveTextContent(/no active event/i);
    });
  });

  it('computes per-match received vs expected coverage', async () => {
    wireTables(
      [
        { match_key: 'qm1', target_team_number: 254, scout_id: 's1' },
        { match_key: 'qm1', target_team_number: 1678, scout_id: 's2' },
        { match_key: 'qm1', target_team_number: 100, scout_id: 's3' },
      ],
      [
        {
          match_key: 'qm1',
          target_team_number: 254,
          scout_id: 's1',
          server_received_at: '2026-06-23T10:00:00Z',
        },
        {
          match_key: 'qm1',
          target_team_number: 1678,
          scout_id: 's2',
          server_received_at: '2026-06-23T10:05:00Z',
        },
      ]
    );
    render(<SyncStatusScreen />);
    const row = await screen.findByTestId('sync-match-qm1');
    // 2 of the 3 assigned reports have arrived
    expect(row).toHaveTextContent('2/3');
  });

  it('flags a missing assigned report', async () => {
    wireTables(
      [
        { match_key: 'qm2', target_team_number: 254, scout_id: 's1' },
        { match_key: 'qm2', target_team_number: 1678, scout_id: 's2' },
      ],
      [
        {
          match_key: 'qm2',
          target_team_number: 254,
          scout_id: 's1',
          server_received_at: '2026-06-23T11:00:00Z',
        },
      ]
    );
    render(<SyncStatusScreen />);
    const row = await screen.findByTestId('sync-match-qm2');
    expect(row).toHaveTextContent('1/2');
    // the missing assigned target is surfaced
    expect(row).toHaveTextContent(/missing/i);
    expect(row).toHaveTextContent('1678');
  });
});
