import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  saveMatchupNoteLocal,
  getMatchupNote,
  listMatchupNotesForEvent,
  getMatchupSyncQueue,
  listMatchupDeadLetters,
  markMatchupPending,
  markMatchupSynced,
  markMatchupDirtyRetry,
  markMatchupSyncError,
  requeueAuthClassMatchupDeadLetters,
} from '../localStore';
import type { LocalMatchupNote } from '../types';

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

describe('matchup-note queue helpers', () => {
  beforeEach(async () => {
    await db.matchupNotes.clear();
  });

  it('saves + reads a note by key and by event', async () => {
    await saveMatchupNoteLocal(makeNote());
    expect((await getMatchupNote('2026casnv:3256:254'))?.note).toBe('deny feed lane');
    const forEvent = await listMatchupNotesForEvent('2026casnv');
    expect(forEvent).toHaveLength(1);
    expect((await listMatchupNotesForEvent('2026other'))).toHaveLength(0);
  });

  it('keeps per-team notes distinct within one event', async () => {
    await saveMatchupNoteLocal(makeNote({
      key: '2026casnv:-1:111',
      ourTeam: -1,
      oppTeam: 111,
      note: 'partner plan',
    }));
    await saveMatchupNoteLocal(makeNote({
      key: '2026casnv:-1:333',
      ourTeam: -1,
      oppTeam: 333,
      note: 'opponent plan',
    }));

    const notes = await listMatchupNotesForEvent('2026casnv');
    expect(notes.map((note) => [note.oppTeam, note.note])).toEqual([
      [111, 'partner plan'],
      [333, 'opponent plan'],
    ]);
  });

  it('getMatchupSyncQueue returns only dirty/pending, excluding synced + error', async () => {
    await saveMatchupNoteLocal(makeNote({ key: 'e:1:2', note: 'a' }));
    await saveMatchupNoteLocal(makeNote({ key: 'e:3:4', note: 'b' }));
    await saveMatchupNoteLocal(makeNote({ key: 'e:5:6', note: 'c' }));
    await markMatchupSynced('e:1:2');
    await markMatchupSyncError('e:3:4', 'boom');
    await markMatchupPending('e:5:6');

    const queue = await getMatchupSyncQueue();
    const keys = queue.map((n) => n.key);
    expect(keys).toEqual(['e:5:6']);
  });

  it('dirty-retry bumps attempts; sync-error dead-letters; auth-class requeue resets', async () => {
    await saveMatchupNoteLocal(makeNote({ key: 'e:1:2' }));
    await markMatchupDirtyRetry('e:1:2', 'transient');
    expect((await getMatchupNote('e:1:2'))?.syncAttempts).toBe(1);

    await markMatchupSyncError('e:1:2', '42501 permission denied');
    expect((await listMatchupDeadLetters())).toHaveLength(1);

    const requeued = await requeueAuthClassMatchupDeadLetters();
    expect(requeued).toBe(1);
    expect((await getMatchupNote('e:1:2'))?.syncState).toBe('dirty');
    expect((await getMatchupNote('e:1:2'))?.syncAttempts).toBe(0);
  });
});

// BLOCKING merge-gate: opening the upgraded (v3) DB must preserve existing
// reports/drafts rows seeded under the prior (v2) schema — a duplicate/wrong
// version() collision would throw on open and break ALL local storage app-wide.
describe('Dexie v2 -> v3 upgrade safety', () => {
  const DB_NAME = 'scouting-db-upgrade-test';

  it('preserves reports + drafts rows across the version bump, then exposes matchupNotes', async () => {
    // 1. Open at the PRIOR (v2) schema and seed reports + drafts.
    const v2 = new Dexie(DB_NAME);
    v2.version(1).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
    });
    v2.version(2).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
      cachedMatches: 'match_key, event_key',
      cachedAssignments: 'id, scout_id, event_key, match_key',
      cachedRoster: 'id, name',
      cachedTeams: 'id, event_key, team_number',
      preloadMeta: 'key',
    });
    await v2.open();
    await v2.table('reports').put({ id: 'r1', syncState: 'dirty', matchKey: 'qm1' });
    await v2.table('drafts').put({ draftKey: 'd1', updatedAt: 'now', state: { a: 1 } });
    v2.close();

    // 2. Re-open the SAME db at the new (v3) schema — the matching version chain.
    const v3 = new Dexie(DB_NAME);
    v3.version(1).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
    });
    v3.version(2).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
      cachedMatches: 'match_key, event_key',
      cachedAssignments: 'id, scout_id, event_key, match_key',
      cachedRoster: 'id, name',
      cachedTeams: 'id, event_key, team_number',
      preloadMeta: 'key',
    });
    v3.version(3).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
      cachedMatches: 'match_key, event_key',
      cachedAssignments: 'id, scout_id, event_key, match_key',
      cachedRoster: 'id, name',
      cachedTeams: 'id, event_key, team_number',
      preloadMeta: 'key',
      matchupNotes: 'key, eventKey, syncState, ourTeam, oppTeam',
    });

    // open() must NOT throw (no VersionError), and existing rows must survive.
    await expect(v3.open()).resolves.toBeDefined();
    expect((await v3.table('reports').get('r1'))?.matchKey).toBe('qm1');
    expect((await v3.table('drafts').get('d1'))?.state).toEqual({ a: 1 });

    // The new store is usable.
    await v3.table('matchupNotes').put(makeNote());
    expect((await v3.table('matchupNotes').get('2026casnv:3256:254'))?.note).toBe(
      'deny feed lane',
    );
    v3.close();
  });
});
