import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks ------------------------------------------------------------------
// preloadEventData reads from Supabase + the roster client and writes the
// results into Dexie. We mock the network layer so we can drive the exact
// "successful-but-empty" responses that used to wipe the offline cache.

type TableResult = { data: unknown[] | null; error: { message: string } | null };
const tableResults: Record<string, TableResult> = {};

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          Promise.resolve(tableResults[table] ?? { data: [], error: null }),
      }),
    }),
  },
}));

let rosterRows: Array<{ id: string; name: string }> = [];
vi.mock('@/roster/rosterClient', () => ({
  listRoster: () => Promise.resolve(rosterRows),
}));

import { preloadEventData, getCachedAssignments } from '../preloadClient';
import { db } from '../localStore';
import type { CachedAssignment } from '../types';

function assignmentRow(scoutId: string, matchKey: string): CachedAssignment {
  return {
    id: `${scoutId}:${matchKey}`,
    scout_id: scoutId,
    match_key: matchKey,
    alliance_color: 'red',
    station: 1,
    target_team_number: 254,
    event_key: '2026event',
  };
}

describe('preloadEventData — empty responses do not wipe the offline cache', () => {
  beforeEach(async () => {
    await db.cachedAssignments.clear();
    await db.cachedMatches.clear();
    await db.cachedTeams.clear();
    await db.cachedRoster.clear();
    for (const k of Object.keys(tableResults)) delete tableResults[k];
    rosterRows = [];
  });

  it('keeps cached assignments when the server returns zero rows', async () => {
    // Scout already has assignments cached for offline use.
    await db.cachedAssignments.bulkPut([
      assignmentRow('scout1', '2026event_qm1'),
      assignmentRow('scout1', '2026event_qm2'),
    ]);

    // Server momentarily returns a successful-but-empty assignment list
    // (e.g. the select_scouter row-consolidation race).
    tableResults['assignment'] = { data: [], error: null };

    const res = await preloadEventData({ eventKey: '2026event', scoutId: 'scout1' });

    expect(res.counts.assignments).toBe(0);
    // The cache must survive — this is the regression guard.
    const cached = await getCachedAssignments('scout1');
    expect(cached.map((a) => a.match_key).sort()).toEqual([
      '2026event_qm1',
      '2026event_qm2',
    ]);
  });

  it('replaces cached assignments when the server returns fresh rows', async () => {
    await db.cachedAssignments.bulkPut([assignmentRow('scout1', '2026event_qm1')]);

    tableResults['assignment'] = {
      data: [
        {
          scout_id: 'scout1',
          match_key: '2026event_qm5',
          alliance_color: 'blue',
          station: 2,
          target_team_number: 148,
          event_key: '2026event',
        },
      ],
      error: null,
    };

    const res = await preloadEventData({ eventKey: '2026event', scoutId: 'scout1' });

    expect(res.counts.assignments).toBe(1);
    const cached = await getCachedAssignments('scout1');
    // Clean refresh: the stale qm1 is gone, only the freshly-fetched qm5 remains.
    expect(cached.map((a) => a.match_key)).toEqual(['2026event_qm5']);
  });

  it('keeps cached assignments when the server query errors', async () => {
    await db.cachedAssignments.bulkPut([assignmentRow('scout1', '2026event_qm1')]);

    tableResults['assignment'] = { data: null, error: { message: 'network down' } };

    const res = await preloadEventData({ eventKey: '2026event', scoutId: 'scout1' });

    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith('assignment'))).toBe(true);
    // An error must never touch the cache either.
    const cached = await getCachedAssignments('scout1');
    expect(cached.map((a) => a.match_key)).toEqual(['2026event_qm1']);
  });
});
