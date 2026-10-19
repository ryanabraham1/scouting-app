import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the network: the upsert_board_records RPC. The local Dexie outbox is real.
const rpcMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import { db, writeBoardRecords, boardRecordKey } from '@/db/localStore';
import type { LocalBoardRecord } from '@/db/types';
import { syncBoardOnce, batchRows } from '../boardSync';
import { clearSyncCircuit } from '../retrySchedule';

function rec(id: string, extra: Record<string, unknown> = {}) {
  return { id, data: { id, type: 'ink', rev: 1, by: 'c', x: 0, y: 0, w: 1, h: 1, z: 0, ...extra }, deleted: false };
}

async function row(id: string): Promise<LocalBoardRecord | undefined> {
  return db.boardRecords.get(boardRecordKey('2026casj', id));
}

describe('syncBoardOnce', () => {
  beforeEach(async () => {
    clearSyncCircuit();
    await db.boardRecords.clear();
    rpcMock.mockReset();
  });

  it('sends one batched RPC per board and marks rows synced', async () => {
    await writeBoardRecords('2026casj', [rec('s:a'), rec('s:b')]);
    rpcMock.mockResolvedValue({ data: { ok: true, accepted: 2, stale: 0, rejected: [] }, error: null });
    const summary = await syncBoardOnce();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][0]).toBe('upsert_board_records');
    expect(rpcMock.mock.calls[0][1].p_board_key).toBe('2026casj');
    expect(rpcMock.mock.calls[0][1].p_records).toHaveLength(2);
    expect(summary.synced).toBe(2);
    expect((await row('s:a'))?.syncState).toBe('synced');
  });

  it('keeps a row dirty when it was edited while its upload was in flight', async () => {
    await writeBoardRecords('2026casj', [rec('s:a')]);
    rpcMock.mockImplementation(async () => {
      // A newer local edit lands mid-flight.
      await new Promise((r) => setTimeout(r, 5));
      await writeBoardRecords('2026casj', [rec('s:a', { x: 50 })]);
      return { data: { ok: true, accepted: 1, stale: 0, rejected: [] }, error: null };
    });
    await syncBoardOnce();
    expect((await row('s:a'))?.syncState).toBe('dirty');
  });

  it('a network failure keeps rows dirty without counting an attempt', async () => {
    await writeBoardRecords('2026casj', [rec('s:a')]);
    rpcMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const summary = await syncBoardOnce();
    expect(summary.retried).toBe(1);
    const r = await row('s:a');
    expect(r?.syncState).toBe('dirty');
    expect(r?.syncAttempts ?? 0).toBe(0);
  });

  it('rejected records dead-letter while the rest of the batch syncs', async () => {
    await writeBoardRecords('2026casj', [rec('s:a'), rec('s:big')]);
    rpcMock.mockResolvedValue({ data: { ok: true, accepted: 1, stale: 0, rejected: ['s:big'] }, error: null });
    const summary = await syncBoardOnce();
    expect(summary.synced).toBe(1);
    expect(summary.deadLettered).toBe(1);
    expect((await row('s:big'))?.syncState).toBe('error');
    expect((await row('s:a'))?.syncState).toBe('synced');
  });

  it('an unknown-event verdict keeps every row as an error, never synced', async () => {
    await writeBoardRecords('2026casj', [rec('s:a')]);
    rpcMock.mockResolvedValue({ data: { ok: false, reason: 'unknown_event' }, error: null });
    await syncBoardOnce();
    expect((await row('s:a'))?.syncState).toBe('error');
  });
});

describe('batchRows', () => {
  it('splits at 200 records', () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ data: { i } }) as unknown as LocalBoardRecord);
    expect(batchRows(rows).map((b) => b.length)).toEqual([200, 200, 50]);
  });
});
