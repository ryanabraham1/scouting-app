import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks ------------------------------------------------------------------
// preloadEventData reads from Supabase + the roster client and writes the
// results into Dexie. We mock the network layer so we can drive the exact
// "successful-but-empty" responses that used to wipe the offline cache.

type TableResult = { data: unknown[] | null; error: { message: string } | null };
const tableResults: Record<string, TableResult> = {};
const selectCalls: Array<{ table: string; columns: string }> = [];

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const result = () => tableResults[table] ?? { data: [], error: null };
      const query = {
        eq: () => query,
        then: (
          resolve: (value: TableResult) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(result()).then(resolve, reject),
      };
      return {
        select: (columns: string) => {
          selectCalls.push({ table, columns });
          return query;
        },
      };
    },
  },
}));

let rosterRows: Array<{ id: string; name: string }> = [];
vi.mock('@/roster/rosterClient', () => ({
  listRoster: () => Promise.resolve(rosterRows),
}));

import {
  preloadEventData,
  getCachedAssignments,
  getCachedPitAssignments,
  getCachedPitAssignmentsForEvent,
  getPreloadMeta,
} from '../preloadClient';
import { db } from '../localStore';
import type { CachedAssignment, CachedPitAssignment } from '../types';

function assignmentRow(
  scoutId: string,
  matchKey: string,
  eventKey = '2026event',
): CachedAssignment {
  return {
    id: `${eventKey}:${matchKey}:red:1`,
    scout_id: scoutId,
    match_key: matchKey,
    alliance_color: 'red',
    station: 1,
    target_team_number: 254,
    event_key: eventKey,
  };
}

function pitAssignmentRow(scoutId: string): CachedPitAssignment {
  return {
    id: '',
    event_key: '2026event',
    team_number: 254,
    scout_id: scoutId,
    source: 'manual',
  };
}

describe('preloadEventData — event-scoped assignment caches', () => {
  beforeEach(async () => {
    await db.cachedAssignments.clear();
    await db.cachedPitAssignments.clear();
    await db.cachedMatches.clear();
    await db.cachedTeams.clear();
    await db.cachedRoster.clear();
    await db.preloadMeta.clear();
    for (const k of Object.keys(tableResults)) delete tableResults[k];
    selectCalls.length = 0;
    rosterRows = [];
  });

  it('selects the event-scoped scout relation for pit assignments', async () => {
    await preloadEventData({ eventKey: '2026event', scoutId: 'scout1' });

    expect(selectCalls).toContainEqual({
      table: 'pit_assignment',
      columns:
        'event_key,team_number,scout_id,source,scout:scout!pit_assignment_event_scout_fkey(display_name)',
    });
  });

  it('treats an empty event response as authoritative without clearing another event', async () => {
    await db.cachedAssignments.bulkPut([
      assignmentRow('scout1', '2026event_qm1'),
      assignmentRow('scout1', '2026event_qm2'),
      assignmentRow('other-scout', '2026other_qm1', '2026other'),
    ]);
    tableResults['assignment'] = { data: [], error: null };

    const res = await preloadEventData({ eventKey: '2026event', scoutId: 'scout1' });

    expect(res.counts.assignments).toBe(0);
    const cached = await getCachedAssignments('scout1');
    expect(cached).toEqual([]);
    expect(await db.cachedAssignments.where('event_key').equals('2026other').count()).toBe(1);
  });

  it('replaces cached assignments when the server returns fresh rows', async () => {
    await db.cachedAssignments.bulkPut([
      assignmentRow('scout1', '2026event_qm1'),
      assignmentRow('other-scout', '2026other_qm1', '2026other'),
    ]);

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
    expect(await db.cachedAssignments.where('event_key').equals('2026other').count()).toBe(1);
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

  it('keeps same-team pit assignments distinct when scouts share a crew', async () => {
    tableResults['pit_assignment'] = {
      data: [pitAssignmentRow('scout1')],
      error: null,
    };
    await preloadEventData({ eventKey: '2026event', scoutId: 'scout1' });

    tableResults['pit_assignment'] = {
      data: [pitAssignmentRow('scout1'), pitAssignmentRow('scout2')],
      error: null,
    };
    await preloadEventData({ eventKey: '2026event', scoutId: 'scout2' });

    expect(await getCachedPitAssignments('scout1')).toMatchObject([
      { id: '2026event:254:scout1', team_number: 254, scout_id: 'scout1' },
    ]);
    expect(await getCachedPitAssignments('scout2')).toMatchObject([
      { id: '2026event:254:scout2', team_number: 254, scout_id: 'scout2' },
    ]);
  });

  it('treats an empty pit crew response as authoritative and updates metadata atomically', async () => {
    await db.cachedPitAssignments.bulkPut([
      {
        ...pitAssignmentRow('scout1'),
        id: '2026event:254:scout1',
      },
      {
        ...pitAssignmentRow('other-scout'),
        id: '2026other:254:other-scout',
        event_key: '2026other',
      },
    ]);
    tableResults['pit_assignment'] = { data: [], error: null };
    await preloadEventData({ eventKey: '2026event', scoutId: 'scout1' });

    expect(await getCachedPitAssignmentsForEvent('2026event')).toEqual([]);
    expect(await getCachedPitAssignmentsForEvent('2026other')).toHaveLength(1);
    expect((await getPreloadMeta('2026event'))?.counts.pitAssignments).toBe(0);
  });

  it('preserves last-success metadata for sections that fail on a partial refresh', async () => {
    await db.preloadMeta.put({
      key: '2026event',
      lastPreloadAt: '2026-01-01T00:00:00.000Z',
      counts: { matches: 2, assignments: 5, pitAssignments: 1, roster: 3, teams: 20 },
    });
    tableResults['assignment'] = { data: null, error: { message: 'offline' } };
    await preloadEventData({ eventKey: '2026event', scoutId: 'scout1' });

    const meta = await getPreloadMeta('2026event');
    expect(meta?.lastPreloadAt).toBe('2026-01-01T00:00:00.000Z');
    expect(meta?.counts.assignments).toBe(5);
  });
});
