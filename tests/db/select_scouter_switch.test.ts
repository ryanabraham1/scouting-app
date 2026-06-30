// tests/db/select_scouter_switch.test.ts
// Regression for migration 0036: scouting as one name then switching to another
// on the SAME device must NOT relabel the first name's reports. Before 0036,
// select_scouter upserted on (event_key, auth_uid) and overwrote display_name in
// place, so picking a second name retroactively reassigned every report from the
// first. Runs against the deployed DB (the function lives server-side).
import { it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;

const EVENT = 'TESTSS36evt';
const TEAM = 999036;
const MATCH = 'TESTSS36evt_qm1';
const NAME_A = 'Test 5';
const NAME_B = 'Test 2';

let admin: SupabaseClient;

beforeAll(async () => {
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  await admin.from('event').upsert({ event_key: EVENT, name: 'SS36', is_active: false });
  await admin.from('team').upsert({ team_number: TEAM, nickname: 'SS36' });
  await admin
    .from('match')
    .upsert({ match_key: MATCH, event_key: EVENT, comp_level: 'qm', match_number: 1 });
});

afterAll(async () => {
  await admin.from('match_scouting_report').delete().eq('event_key', EVENT);
  await admin.from('scout').delete().eq('event_key', EVENT);
  await admin.from('match').delete().eq('match_key', MATCH);
  await admin.from('team').delete().eq('team_number', TEAM);
  await admin.from('event').delete().eq('event_key', EVENT);
});

it('switching names on a device keeps the first name its own row + reports', async () => {
  const device = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: sErr } = await device.auth.signInAnonymously();
  expect(sErr, sErr?.message).toBeNull();

  // 1. Pick "Test 5" and scout a match under it.
  const { data: a, error: aErr } = await device.rpc('select_scouter', {
    p_event_key: EVENT,
    p_name: NAME_A,
  });
  expect(aErr, aErr?.message).toBeNull();
  const rowA = a!.id as string;

  const reportId = crypto.randomUUID();
  const { error: rErr } = await admin.from('match_scouting_report').insert({
    id: reportId,
    schema_version: 1,
    event_key: EVENT,
    match_key: MATCH,
    scout_id: rowA,
    target_team_number: TEAM,
    alliance_color: 'red',
    station: 1,
    deleted: false,
  });
  expect(rErr, rErr?.message).toBeNull();

  // 2. Switch the SAME device to "Test 2".
  const { data: b, error: bErr } = await device.rpc('select_scouter', {
    p_event_key: EVENT,
    p_name: NAME_B,
  });
  expect(bErr, bErr?.message).toBeNull();
  const rowB = b!.id as string;

  // The switch creates a DISTINCT row — it does not reuse/rename "Test 5"'s row.
  expect(rowB).not.toBe(rowA);

  // "Test 5"'s row still exists, still named "Test 5".
  const { data: keptA } = await admin
    .from('scout')
    .select('id,display_name')
    .eq('id', rowA)
    .single();
  expect(keptA?.display_name).toBe(NAME_A);

  // The report stays attributed to "Test 5"'s row — NOT transferred to "Test 2".
  const { data: rep } = await admin
    .from('match_scouting_report')
    .select('scout_id')
    .eq('id', reportId)
    .single();
  expect(rep?.scout_id).toBe(rowA);

  await device.auth.signOut();
});
