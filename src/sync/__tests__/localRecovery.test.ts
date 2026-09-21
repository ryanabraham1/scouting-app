import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { maybeSingle, from } = vi.hoisted(() => {
  const maybeSingleMock = vi.fn();
  const fromMock = vi.fn(() => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: maybeSingleMock,
    };
    return chain;
  });
  return { maybeSingle: maybeSingleMock, from: fromMock };
});

vi.mock('@/lib/supabase', () => ({ supabase: { from } }));

import { db, listMatchupNotesForEvent, saveMatchupNoteLocal } from '@/db/localStore';
import type { LocalMatchupNote } from '@/db/types';
import {
  autoResolveConflicts,
  listLocalRecoveryRecords,
  loadRecoveryVersions,
  resolveLocalRecovery,
} from '../localRecovery';

function failedNote(): LocalMatchupNote {
  return {
    key: '2026test:-1:254',
    eventKey: '2026test',
    ourTeam: -1,
    oppTeam: 254,
    note: 'Block the local lane',
    authorScoutId: null,
    updatedAt: '2026-07-10T12:00:00.000Z',
    syncState: 'error',
    syncAttempts: 0,
    lastSyncError: 'changed on another device',
    recoveryIssue: {
      kind: 'conflict',
      code: 'MATCHUP_NOTE_CONFLICT',
      detectedAt: '2026-07-10T12:00:01.000Z',
      serverRevision: 10,
    },
  };
}

describe('typed local recovery registry', () => {
  beforeEach(async () => {
    await db.matchupNotes.clear();
    await db.strategyCanvas.clear();
    maybeSingle.mockReset();
    from.mockClear();
  });

  it('keeps conflicted local notes out of canonical dashboard reads', async () => {
    await saveMatchupNoteLocal(failedNote());
    expect(await listMatchupNotesForEvent('2026test')).toEqual([]);

    const records = await listLocalRecoveryRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'matchup-note',
      local: { recoveryIssue: { kind: 'conflict' } },
    });
  });

  it('loads both versions and creates an explicit merged retry', async () => {
    await saveMatchupNoteLocal(failedNote());
    maybeSingle.mockResolvedValue({
      data: {
        event_key: '2026test',
        our_team: -1,
        opp_team: 254,
        note: 'Server plan',
        row_revision: Date.parse('2026-07-10T12:05:00.000Z'),
        updated_at: '2026-07-10T12:05:00.000Z',
        author_scout_id: null,
        deleted: false,
      },
      error: null,
    });

    const record = (await listLocalRecoveryRecords())[0];
    const versions = await loadRecoveryVersions(record);
    await resolveLocalRecovery(record, versions, 'merge');

    const saved = await db.matchupNotes.get(record.key);
    expect(saved?.syncState).toBe('dirty');
    expect(saved?.recoveryIssue).toBeNull();
    expect(saved?.note).toContain('Server plan');
    expect(saved?.note).toContain('Block the local lane');
  });

  it('using the server discards only the rejected local recovery copy', async () => {
    await saveMatchupNoteLocal(failedNote());
    const record = (await listLocalRecoveryRecords())[0];
    await resolveLocalRecovery(
      record,
      {
        kind: 'matchup-note',
        local: 'Block the local lane',
        server: 'Server plan',
        serverRevision: 12,
      },
      'server',
    );
    expect(await db.matchupNotes.get(record.key)).toBeUndefined();
  });

  describe('autoResolveConflicts (no-human self-heal)', () => {
    it('merges a differing server note and requeues the merged copy', async () => {
      await saveMatchupNoteLocal(failedNote());
      maybeSingle.mockResolvedValue({
        data: {
          event_key: '2026test',
          our_team: -1,
          opp_team: 254,
          note: 'Server plan',
          row_revision: Date.parse('2026-07-10T12:05:00.000Z'),
          updated_at: '2026-07-10T12:05:00.000Z',
          author_scout_id: null,
          deleted: false,
        },
        error: null,
      });

      expect(await autoResolveConflicts()).toBe(1);
      const saved = await db.matchupNotes.get('2026test:-1:254');
      expect(saved?.syncState).toBe('dirty');
      expect(saved?.recoveryIssue).toBeNull();
      expect(saved?.note).toContain('Server plan');
      expect(saved?.note).toContain('Block the local lane');
      // The retry carries a revision above the server's so it lands as applied.
      expect(Date.parse(saved!.updatedAt)).toBeGreaterThan(Date.parse('2026-07-10T12:05:00.000Z'));
    });

    it('drops the local copy when the server already holds identical text', async () => {
      await saveMatchupNoteLocal(failedNote());
      maybeSingle.mockResolvedValue({
        data: {
          event_key: '2026test',
          our_team: -1,
          opp_team: 254,
          note: '  Block the local lane ',
          row_revision: 5,
          updated_at: '2026-07-10T12:05:00.000Z',
          author_scout_id: null,
          deleted: false,
        },
        error: null,
      });

      expect(await autoResolveConflicts()).toBe(1);
      expect(await db.matchupNotes.get('2026test:-1:254')).toBeUndefined();
    });

    it('resends the local copy as-is when the server row is gone', async () => {
      await saveMatchupNoteLocal(failedNote());
      maybeSingle.mockResolvedValue({ data: null, error: null });

      expect(await autoResolveConflicts()).toBe(1);
      const saved = await db.matchupNotes.get('2026test:-1:254');
      expect(saved?.syncState).toBe('dirty');
      expect(saved?.note).toBe('Block the local lane');
    });

    it('leaves the conflict for the next drain when the server cannot be read', async () => {
      await saveMatchupNoteLocal(failedNote());
      maybeSingle.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });

      expect(await autoResolveConflicts()).toBe(0);
      expect((await db.matchupNotes.get('2026test:-1:254'))?.syncState).toBe('error');
    });

    it('ignores terminal (non-conflict) dead-letters', async () => {
      await saveMatchupNoteLocal({
        ...failedNote(),
        recoveryIssue: { kind: 'terminal', code: 'X', detectedAt: '2026-07-10T12:00:01.000Z' },
      });
      expect(await autoResolveConflicts()).toBe(0);
      expect(maybeSingle).not.toHaveBeenCalled();
    });
  });
});
