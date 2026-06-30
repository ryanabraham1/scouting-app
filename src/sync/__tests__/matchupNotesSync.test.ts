import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the network: the upsert_matchup_note RPC. The local Dexie outbox is real.
const rpcMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import {
  db,
  saveMatchupNoteLocal,
  getMatchupSyncQueue,
  listMatchupDeadLetters,
} from '@/db/localStore';
import type { LocalMatchupNote } from '@/db/types';
import { SYNC_MAX_ATTEMPTS } from '@/sync/constants';
import { syncMatchupNotesOnce } from '../matchupNotesSync';

function makeNote(over: Partial<LocalMatchupNote> = {}): LocalMatchupNote {
  return {
    key: '2026casnv:3256:254',
    eventKey: '2026casnv',
    ourTeam: 3256,
    oppTeam: 254,
    note: 'deny feed lane',
    updatedAt: '2026-06-29T00:00:00.000Z',
    authorScoutId: null,
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
    ...over,
  };
}

describe('syncMatchupNotesOnce', () => {
  beforeEach(async () => {
    await db.matchupNotes.clear();
    rpcMock.mockReset();
  });

  it('dirty note: calls upsert_matchup_note with normalized wire shape, marks synced', async () => {
    rpcMock.mockResolvedValue({ error: null });
    await saveMatchupNoteLocal(makeNote());

    const summary = await syncMatchupNotesOnce();

    expect(summary).toEqual({ attempted: 1, synced: 1, retried: 0, deadLettered: 0 });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][0]).toBe('upsert_matchup_note');
    expect(rpcMock.mock.calls[0][1].p).toMatchObject({
      event_key: '2026casnv',
      our_team: 3256,
      opp_team: 254,
      note: 'deny feed lane',
      row_revision: Date.parse('2026-06-29T00:00:00.000Z'),
    });
    expect((await getMatchupSyncQueue()).length).toBe(0);
    expect((await db.matchupNotes.get('2026casnv:3256:254'))?.syncState).toBe('synced');
  });

  it('transient error under cap: returns to dirty and bumps attempts', async () => {
    rpcMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await saveMatchupNoteLocal(makeNote());

    const summary = await syncMatchupNotesOnce();

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 1, deadLettered: 0 });
    const rec = await db.matchupNotes.get('2026casnv:3256:254');
    expect(rec?.syncState).toBe('dirty');
    expect(rec?.syncAttempts).toBe(1);
  });

  it('terminal error (42501): dead-letters', async () => {
    rpcMock.mockResolvedValue({ error: { code: '42501', message: 'denied' } });
    await saveMatchupNoteLocal(makeNote());

    const summary = await syncMatchupNotesOnce();

    expect(summary).toEqual({ attempted: 1, synced: 0, retried: 0, deadLettered: 1 });
    expect((await db.matchupNotes.get('2026casnv:3256:254'))?.syncState).toBe('error');
    expect((await listMatchupDeadLetters()).length).toBe(1);
  });

  it('transient at SYNC_MAX_ATTEMPTS: dead-letters', async () => {
    rpcMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await saveMatchupNoteLocal(makeNote({ syncAttempts: SYNC_MAX_ATTEMPTS }));

    const summary = await syncMatchupNotesOnce();

    expect(summary.deadLettered).toBe(1);
    expect((await db.matchupNotes.get('2026casnv:3256:254'))?.syncState).toBe('error');
  });

  it('idempotent: re-running after success is a no-op (note no longer queued)', async () => {
    rpcMock.mockResolvedValue({ error: null });
    await saveMatchupNoteLocal(makeNote());
    await syncMatchupNotesOnce();
    rpcMock.mockClear();

    const summary = await syncMatchupNotesOnce();
    expect(summary).toEqual({ attempted: 0, synced: 0, retried: 0, deadLettered: 0 });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
