import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;

const EVENT = 'TESTC3evt';
const TEAM = 999003;
const MATCH = 'TESTC3evt_qm1';
let admin: SupabaseClient;
let anon: SupabaseClient;
let myScoutId = '';
let foreignScoutId = '';
let myUid = '';

beforeAll(async () => {
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  await admin.from('event').upsert({ event_key: EVENT, name: 'C3', is_active: true });
  await admin.from('event_secret').upsert({ event_key: EVENT, join_code: 'SECRET99' });
  await admin.from('team').upsert({ team_number: TEAM, nickname: 'C3' });
  await admin.from('match').upsert({ match_key: MATCH, event_key: EVENT, comp_level: 'qm', match_number: 1 });

  // anon client signs in anonymously to obtain a real auth.uid().
  anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: signin, error: sErr } = await anon.auth.signInAnonymously();
  expect(sErr, sErr?.message).toBeNull();
  myUid = signin!.user!.id;

  // bind a scout row to that uid (membership).
  const { data: s } = await admin.from('scout')
    .insert({ event_key: EVENT, display_name: 'me', auth_uid: myUid }).select().single();
  myScoutId = s!.id;

  // a foreign scout (different uid) used to prove impersonation is rejected.
  const { data: fs } = await admin.from('scout')
    .insert({ event_key: EVENT, display_name: 'other', auth_uid: crypto.randomUUID() }).select().single();
  foreignScoutId = fs!.id;
});

afterAll(async () => {
  await admin.from('match_scouting_report').delete().eq('event_key', EVENT);
  await admin.from('scout').delete().eq('event_key', EVENT);
  await admin.from('match').delete().eq('match_key', MATCH);
  await admin.from('team').delete().eq('team_number', TEAM);
  await admin.from('event_secret').delete().eq('event_key', EVENT);
  await admin.from('event').delete().eq('event_key', EVENT);
});

it('anon member can read its event', async () => {
  const { data, error } = await anon.from('event').select('event_key,name').eq('event_key', EVENT);
  expect(error).toBeNull();
  expect(data?.length).toBe(1);
});

it('anon CANNOT read event_secret (join_code hidden)', async () => {
  const { data, error } = await anon.from('event_secret').select('join_code').eq('event_key', EVENT);
  // RLS default-deny => empty result set (no rows), not an error.
  expect(error).toBeNull();
  expect(data?.length).toBe(0);
});

it('anon member can read its event matches', async () => {
  const { data, error } = await anon.from('match').select('match_key').eq('event_key', EVENT);
  expect(error).toBeNull();
  expect(data?.length).toBe(1);
});

it('anon can insert a report for its OWN scout_id', async () => {
  const { error } = await anon.from('match_scouting_report').insert({
    schema_version: 1, event_key: EVENT, match_key: MATCH, scout_id: myScoutId,
    target_team_number: TEAM, alliance_color: 'red', station: 1, fuel_bursts: [],
  });
  expect(error, error?.message).toBeNull();
});

it('anon CANNOT insert a report with a FOREIGN scout_id', async () => {
  const { error } = await anon.from('match_scouting_report').insert({
    schema_version: 1, event_key: EVENT, match_key: MATCH, scout_id: foreignScoutId,
    target_team_number: TEAM, alliance_color: 'blue', station: 2, fuel_bursts: [],
  });
  expect(error, 'foreign insert must be rejected by WITH CHECK').not.toBeNull();
  expect(error?.code).toBe('42501'); // RLS violation
});
