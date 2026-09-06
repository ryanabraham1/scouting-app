// tests/db/matchup_notes.test.ts
//
// The `explicit_browser_data_api_grants` migration revoked `service_role`'s
// broad table privileges, so the event fixture is now created through the
// `promote_event_import` definer RPC (never activated) and torn down through
// `delete_event` (which cascades `matchup_note` via its `on delete cascade` FK
// and explicitly deletes `matchup_note_history`). Verification reads use the
// anon client: `matchup_note` is browser-readable (grant + open read policy),
// while `service_role` no longer has any table grant on it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminClient,
  anonClient,
  seedEvent,
  dropEvent,
  uniqueEventKey,
} from './seedHelpers';

const EVENT_KEY = uniqueEventKey('note');
const TARGET_TEAM = 9254;

let admin: SupabaseClient;
let publicClient: SupabaseClient;

beforeAll(async () => {
  admin = adminClient();
  publicClient = anonClient();
  await seedEvent(admin, {
    eventKey: EVENT_KEY,
    name: 'Matchup note DB test',
    teams: [{ team_number: TARGET_TEAM }],
    matches: [],
  });
}, 90_000);

afterAll(async () => {
  if (admin) await dropEvent(admin, EVENT_KEY);
});

describe('event-scoped team strategy notes', () => {
  it('accepts the collision-free team namespace and is openly readable', async () => {
    const first = await publicClient.rpc('upsert_matchup_note', {
      p: {
        event_key: EVENT_KEY,
        our_team: -1,
        opp_team: TARGET_TEAM,
        note: 'initial team strategy',
        row_revision: 100,
        author_scout_id: null,
      },
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ status: 'applied', current_revision: 100 });

    const read = await publicClient
      .from('matchup_note')
      .select('our_team,opp_team,note,row_revision')
      .eq('event_key', EVENT_KEY)
      .eq('our_team', -1)
      .eq('opp_team', TARGET_TEAM)
      .single();
    expect(read.error).toBeNull();
    expect(read.data).toMatchObject({
      our_team: -1,
      opp_team: TARGET_TEAM,
      note: 'initial team strategy',
      row_revision: 100,
    });
  });

  it('keeps the strict revision guard for team-scoped rows', async () => {
    const stale = await publicClient.rpc('upsert_matchup_note', {
      p: {
        event_key: EVENT_KEY,
        our_team: -1,
        opp_team: TARGET_TEAM,
        note: 'must not overwrite',
        row_revision: 99,
      },
    });
    expect(stale.error).toBeNull();
    expect(stale.data).toMatchObject({ status: 'stale', current_revision: 100 });

    const afterStale = await publicClient
      .from('matchup_note')
      .select('note,row_revision')
      .eq('event_key', EVENT_KEY)
      .eq('our_team', -1)
      .eq('opp_team', TARGET_TEAM)
      .single();
    expect(afterStale.data).toMatchObject({
      note: 'initial team strategy',
      row_revision: 100,
    });

    const newer = await publicClient.rpc('upsert_matchup_note', {
      p: {
        event_key: EVENT_KEY,
        our_team: -1,
        opp_team: TARGET_TEAM,
        note: 'newer team strategy',
        row_revision: 101,
      },
    });
    expect(newer.error).toBeNull();
    expect(newer.data).toMatchObject({ status: 'applied', current_revision: 101 });
    const afterNewer = await publicClient
      .from('matchup_note')
      .select('note,row_revision')
      .eq('event_key', EVENT_KEY)
      .eq('our_team', -1)
      .eq('opp_team', TARGET_TEAM)
      .single();
    expect(afterNewer.data).toMatchObject({
      note: 'newer team strategy',
      row_revision: 101,
    });
  });

  it('still denies direct public writes outside the RPC', async () => {
    const direct = await publicClient.from('matchup_note').insert({
      event_key: EVENT_KEY,
      our_team: -1,
      opp_team: TARGET_TEAM + 1,
      note: 'bypass',
      row_revision: 1,
    });
    expect(direct.error).not.toBeNull();
  });

  it('serializes concurrent first writes and reports the losing equal-revision conflict', async () => {
    const team = TARGET_TEAM + 2;
    const [a, b] = await Promise.all([
      publicClient.rpc('upsert_matchup_note', {
        p: {
          event_key: EVENT_KEY,
          our_team: -1,
          opp_team: team,
          note: 'device a',
          row_revision: 200,
        },
      }),
      publicClient.rpc('upsert_matchup_note', {
        p: {
          event_key: EVENT_KEY,
          our_team: -1,
          opp_team: team,
          note: 'device b',
          row_revision: 200,
        },
      }),
    ]);

    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect([a.data?.status, b.data?.status].sort()).toEqual(['applied', 'conflict']);
    const rows = await publicClient
      .from('matchup_note')
      .select('note,row_revision')
      .eq('event_key', EVENT_KEY)
      .eq('our_team', -1)
      .eq('opp_team', team);
    expect(rows.data).toHaveLength(1);
    expect(rows.data?.[0].row_revision).toBe(200);
  });
});
