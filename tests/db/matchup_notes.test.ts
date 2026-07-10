import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const PUBLISHABLE = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const EVENT_KEY = `note_test_${Math.random().toString(36).slice(2, 9)}`;
const TARGET_TEAM = 9254;

let admin: SupabaseClient;
let publicClient: SupabaseClient;

beforeAll(async () => {
  expect(URL, 'VITE_SUPABASE_URL missing').toBeTruthy();
  expect(SECRET, 'SUPABASE_SECRET_KEY missing').toBeTruthy();
  expect(PUBLISHABLE, 'VITE_SUPABASE_PUBLISHABLE_KEY missing').toBeTruthy();
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  publicClient = createClient(URL, PUBLISHABLE, { auth: { persistSession: false } });
  const { error } = await admin.from('event').insert({
    event_key: EVENT_KEY,
    name: 'Matchup note DB test',
  });
  if (error) throw error;
});

afterAll(async () => {
  if (!admin) return;
  await admin.from('matchup_note_history').delete().eq('event_key', EVENT_KEY);
  await admin.from('event').delete().eq('event_key', EVENT_KEY);
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

    const afterStale = await admin
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
    const afterNewer = await admin
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
    const rows = await admin
      .from('matchup_note')
      .select('note,row_revision')
      .eq('event_key', EVENT_KEY)
      .eq('our_team', -1)
      .eq('opp_team', team);
    expect(rows.data).toHaveLength(1);
    expect(rows.data?.[0].row_revision).toBe(200);
  });
});
