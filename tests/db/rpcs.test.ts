import { it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;

const EVENT = 'TESTC4evt';
const TEAM = 999004;
const MATCH = 'TESTC4evt_qm1';
const CODE = 'JOINC4';
let admin: SupabaseClient;
let anon: SupabaseClient;
let myUid = '';
let myScoutId = '';

beforeAll(async () => {
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  await admin.from('event').upsert({ event_key: EVENT, name: 'C4', is_active: true });
  await admin.from('event_secret').upsert({ event_key: EVENT, join_code: CODE });
  await admin.from('team').upsert({ team_number: TEAM, nickname: 'C4' });
  await admin.from('match').upsert({ match_key: MATCH, event_key: EVENT, comp_level: 'qm', match_number: 1 });
  anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
});

afterAll(async () => {
  await admin.from('match_scouting_report').delete().eq('event_key', EVENT);
  await admin.from('scout').delete().eq('event_key', EVENT);
  await admin.from('match').delete().eq('match_key', MATCH);
  await admin.from('team').delete().eq('team_number', TEAM);
  await admin.from('event_secret').delete().eq('event_key', EVENT);
  await admin.from('event').delete().eq('event_key', EVENT);
});

it('anon sign-in + join_event creates a scout row', async () => {
  const { data: signin, error: sErr } = await anon.auth.signInAnonymously();
  expect(sErr, sErr?.message).toBeNull();
  myUid = signin!.user!.id;
  const { data, error } = await anon.rpc('join_event', { p_code: CODE, p_display_name: 'C4 scout' });
  expect(error, error?.message).toBeNull();
  expect(data?.event_key).toBe(EVENT);
  expect(data?.auth_uid).toBe(myUid);
  myScoutId = data!.id;
});

it('join_event is idempotent for same uid+event', async () => {
  const { data, error } = await anon.rpc('join_event', { p_code: CODE, p_display_name: 'C4 scout' });
  expect(error).toBeNull();
  expect(data?.id).toBe(myScoutId);
});

it('join_event rejects a wrong code', async () => {
  const { error } = await anon.rpc('join_event', { p_code: 'WRONG', p_display_name: 'x' });
  expect(error).not.toBeNull();
});

it('upsert_match_report is revision-guarded and triggers recompute', async () => {
  const reportId = crypto.randomUUID();
  const base = {
    id: reportId, schema_version: 1, event_key: EVENT, match_key: MATCH,
    scout_id: myScoutId, target_team_number: TEAM, alliance_color: 'red',
    station: 1, inactive_first: false, row_revision: 5,
    fuel_bursts: [{ startMs: 0, endMs: 20000, rate: 1.0, window: 'auto' }],
  };
  // initial insert at revision 5
  let res = await anon.rpc('upsert_match_report', { p: base });
  expect(res.error, res.error?.message).toBeNull();
  let row = await admin.from('match_scouting_report')
    .select('row_revision,auto_fuel,fuel_points').eq('id', reportId).single();
  expect(row.data!.auto_fuel).toBe(20);   // recompute ran
  expect(row.data!.fuel_points).toBe(20);

  // stale write at revision 3 must be IGNORED
  res = await anon.rpc('upsert_match_report', {
    p: { ...base, row_revision: 3, fuel_bursts: [{ startMs: 0, endMs: 10000, rate: 5, window: 'auto' }] },
  });
  expect(res.error).toBeNull();
  row = await admin.from('match_scouting_report').select('auto_fuel').eq('id', reportId).single();
  expect(row.data!.auto_fuel).toBe(20);    // unchanged — stale rejected

  // newer write at revision 9 wins
  res = await anon.rpc('upsert_match_report', {
    p: { ...base, row_revision: 9, fuel_bursts: [{ startMs: 0, endMs: 10000, rate: 4, window: 'auto' }] },
  });
  expect(res.error).toBeNull();
  row = await admin.from('match_scouting_report').select('auto_fuel,row_revision').eq('id', reportId).single();
  expect(row.data!.auto_fuel).toBe(40);    // 10s*4 = 40
  expect(row.data!.row_revision).toBe(9);
});
