import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// --- mock the globally active event resolver ---
const useActiveEventMock = vi.fn();
vi.mock('@/dash/useActiveEvent', () => ({
  useActiveEvent: () => useActiveEventMock(),
}));

// --- mock the supabase client; fetchCoverage queries `assignment` +
// `match_scouting_report`, both .select(...).eq('event_key', key). ---
const from = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { from: (...a: unknown[]) => from(...a) } }));

import SyncStatusScreen from '@/sync/SyncStatusScreen';
import { db, saveMatchupNoteLocal } from '@/db/localStore';

type Row = Record<string, unknown>;

// Build a query-chain mock: .select(...).eq(...) resolves to { data, error }.
function tableMock(data: Row[]) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: data[0] ?? null, error: null })),
    then: (
      resolve: (value: { data: Row[]; error: null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data, error: null }).then(resolve, reject),
  };
  return chain;
}

function wireTables(assignments: Row[], reports: Row[], notes: Row[] = []) {
  from.mockImplementation((t: string) => {
    if (t === 'assignment') return tableMock(assignments);
    if (t === 'match_scouting_report') return tableMock(reports);
    if (t === 'matchup_note') return tableMock(notes);
    return tableMock([]);
  });
}

beforeEach(async () => {
  await db.matchupNotes.clear();
  await db.strategyCanvas.clear();
  useActiveEventMock.mockReset();
  from.mockReset();
  useActiveEventMock.mockReturnValue({
    eventKey: '2026demo',
    loading: false,
    authoritative: true,
  });
  wireTables([], []);
});

describe('SyncStatusScreen', () => {
  it('renders the screen container', async () => {
    render(
      <MemoryRouter>
        <SyncStatusScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('sync-status')).toBeInTheDocument();
  });

  it('shows a no-active-event empty state', async () => {
    useActiveEventMock.mockReturnValue({
      eventKey: null,
      loading: false,
      authoritative: true,
    });
    render(
      <MemoryRouter>
        <SyncStatusScreen />
      </MemoryRouter>,
    );
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
    render(
      <MemoryRouter>
        <SyncStatusScreen />
      </MemoryRouter>,
    );
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
    render(
      <MemoryRouter>
        <SyncStatusScreen />
      </MemoryRouter>,
    );
    const row = await screen.findByTestId('sync-match-qm2');
    expect(row).toHaveTextContent('1/2');
    // the missing assigned target is surfaced
    expect(row).toHaveTextContent(/missing/i);
    expect(row).toHaveTextContent('1678');
  });

  it('inspects and explicitly chooses between local/server conflict versions', async () => {
    await saveMatchupNoteLocal({
      key: '2026demo:-1:254',
      eventKey: '2026demo',
      ourTeam: -1,
      oppTeam: 254,
      note: 'Local plan',
      updatedAt: '2026-07-10T12:00:00.000Z',
      authorScoutId: null,
      syncState: 'error',
      syncAttempts: 0,
      lastSyncError: 'changed on another device',
      recoveryIssue: {
        kind: 'conflict',
        code: 'MATCHUP_NOTE_CONFLICT',
        detectedAt: '2026-07-10T12:01:00.000Z',
        serverRevision: 2,
      },
    });
    wireTables([], [], [{
      event_key: '2026demo',
      our_team: -1,
      opp_team: 254,
      note: 'Server plan',
      row_revision: 2,
      updated_at: '2026-07-10T12:01:00.000Z',
      author_scout_id: null,
      deleted: false,
    }]);
    render(
      <MemoryRouter>
        <SyncStatusScreen />
      </MemoryRouter>,
    );

    const recovery = await screen.findByTestId('local-recovery-deadletter');
    expect(recovery).toHaveTextContent(/not being shown as the shared version/i);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    const inspector = await screen.findByTestId('local-recovery-inspector');
    expect(inspector).toHaveTextContent('Local plan');
    await waitFor(() => expect(inspector).toHaveTextContent('Server plan'));
    expect(screen.getByRole('button', { name: /use server/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /use local/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /merge/i })).toBeEnabled();
  });
});
