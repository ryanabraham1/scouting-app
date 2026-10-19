import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the network: the upsert_strategy_canvas RPC. The local Dexie outbox is real.
const rpcMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import {
  db,
  saveStrategyCanvasLocal,
  listStrategyCanvasDeadLetters,
} from '@/db/localStore';
import type { LocalStrategyCanvas } from '@/db/types';
import { syncStrategyCanvasOnce } from '../strategyCanvasSync';
import { clearSyncCircuit } from '../retrySchedule';

function makeCanvas(over: Partial<LocalStrategyCanvas> = {}): LocalStrategyCanvas {
  return {
    key: '2026casnv:qm1:auto',
    eventKey: '2026casnv',
    matchKey: 'qm1',
    phase: 'auto',
    strokes: [],
    deletedIds: [],
    robots: [],
    updatedAt: '2026-10-18T00:00:00.000Z',
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
    ...over,
  };
}

describe('syncStrategyCanvasOnce', () => {
  beforeEach(async () => {
    clearSyncCircuit();
    await db.strategyCanvas.clear();
    rpcMock.mockReset();
  });

  it('applied verdict marks the board synced', async () => {
    rpcMock.mockResolvedValue({ data: { status: 'applied', revision: 1 }, error: null });
    await saveStrategyCanvasLocal(makeCanvas());

    expect(await syncStrategyCanvasOnce()).toEqual({
      attempted: 1,
      synced: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect((await db.strategyCanvas.get('2026casnv:qm1:auto'))?.syncState).toBe('synced');
  });

  it('a pre-migration void response still counts as applied', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    await saveStrategyCanvasLocal(makeCanvas());

    expect((await syncStrategyCanvasOnce()).synced).toBe(1);
  });

  it('a server rejection dead-letters the board instead of marking it synced', async () => {
    rpcMock.mockResolvedValue({
      data: { status: 'rejected', reason: 'unknown event' },
      error: null,
    });
    await saveStrategyCanvasLocal(makeCanvas());

    expect(await syncStrategyCanvasOnce()).toEqual({
      attempted: 1,
      synced: 0,
      retried: 0,
      deadLettered: 1,
    });
    const [dead] = await listStrategyCanvasDeadLetters();
    expect(dead.lastSyncError).toMatch(/unknown event/);
    expect(dead.recoveryIssue).toMatchObject({ kind: 'terminal', code: 'STRATEGY_CANVAS_REJECTED' });
  });
});
