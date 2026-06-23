import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- mock useSync (the real hook lands this wave from a sibling agent) ---
const useSyncMock = vi.fn();
vi.mock('@/sync/useSync', () => ({
  useSync: () => useSyncMock(),
}));

// --- mock localStore (dead-letter listing + requeue for retry-all) ---
const listDeadLetters = vi.fn();
const requeueReport = vi.fn();
vi.mock('@/db/localStore', () => ({
  listDeadLetters: (...a: unknown[]) => listDeadLetters(...a),
  requeueReport: (...a: unknown[]) => requeueReport(...a),
}));

import { SyncIndicator } from '@/sync/SyncIndicator';

function setSync(over: Partial<ReturnType<typeof useSyncMock>>) {
  useSyncMock.mockReturnValue({
    online: true,
    queued: 0,
    deadLetters: 0,
    syncing: false,
    syncNow: vi.fn(),
    ...over,
  });
}

beforeEach(() => {
  useSyncMock.mockReset();
  listDeadLetters.mockReset();
  requeueReport.mockReset();
  listDeadLetters.mockResolvedValue([]);
  requeueReport.mockResolvedValue(undefined);
});

describe('SyncIndicator', () => {
  it('renders queued and dead-letter counts', () => {
    setSync({ online: true, queued: 2, deadLetters: 1 });
    render(<SyncIndicator />);
    expect(screen.getByTestId('sync-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('sync-queued')).toHaveTextContent('2');
    expect(screen.getByTestId('sync-deadletters')).toHaveTextContent('1');
  });

  it('sync-now button calls syncNow', () => {
    const syncNow = vi.fn();
    setSync({ online: true, queued: 2, deadLetters: 0, syncNow });
    render(<SyncIndicator />);
    fireEvent.click(screen.getByTestId('sync-now'));
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  it('disables sync-now while syncing', () => {
    setSync({ online: true, syncing: true });
    render(<SyncIndicator />);
    expect((screen.getByTestId('sync-now') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables sync-now and shows offline state when offline', () => {
    setSync({ online: false, queued: 1 });
    render(<SyncIndicator />);
    expect((screen.getByTestId('sync-now') as HTMLButtonElement).disabled).toBe(true);
    // an offline dot / state is surfaced via aria-label on the indicator dot
    expect(screen.getByTestId('sync-indicator')).toHaveTextContent(/offline/i);
  });

  it('shows online state when online', () => {
    setSync({ online: true });
    render(<SyncIndicator />);
    expect(screen.getByTestId('sync-indicator')).toHaveTextContent(/online/i);
  });

  it('hides retry-all when there are no dead-letters', () => {
    setSync({ online: true, deadLetters: 0 });
    render(<SyncIndicator />);
    expect(screen.queryByTestId('sync-retry-all')).toBeNull();
  });

  it('retry-all requeues each dead-letter then syncs', async () => {
    const syncNow = vi.fn();
    listDeadLetters.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    setSync({ online: true, deadLetters: 2, syncNow });
    render(<SyncIndicator />);
    fireEvent.click(screen.getByTestId('sync-retry-all'));
    await waitFor(() => {
      expect(requeueReport).toHaveBeenCalledWith('a');
      expect(requeueReport).toHaveBeenCalledWith('b');
    });
    await waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1));
  });
});
