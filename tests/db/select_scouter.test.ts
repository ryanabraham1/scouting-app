// tests/db/select_scouter.test.ts
// Regression for migration 0016: switching scouter names quickly hit
//   duplicate key value violates unique constraint "idx_msr_match_scout_active"
// because select_scouter's report re-point collided when MULTIPLE same-name
// duplicate scout rows each held an ACTIVE report for the SAME match. The fix
// dedupes to at most one active report per match before re-pointing. Runs
// against the deployed DB (the function lives server-side).
import { it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;

const EVENT = 'TESTSS16evt';
const TEAM = 999016;
const MATCH = 'TESTSS16evt_qm1';
const NAME = 'Dup Tester';

let admin: SupabaseClient;

// A roster-seeded / login-less duplicate: its own scout row (distinct synthesized
// auth_uid, exactly like 0013 seeds and QR-ingested rows) owning one ACTIVE report
// for `matchKey`.
async function seedDuplicateScoutWithReport(matchKey: string): Promise<string> {
  const { data: scout, error: sErr } = await admin
    .from('scout')
    .insert({ event_key: EVENT, display_name: NAME, auth_uid: crypto.randomUUID() })
    .select()
    .single();
  if (sErr) throw new Error(`seed scout: ${sErr.message}`);
  const { error: rErr } = await admin.from('match_scouting_report').insert({
    id: crypto.randomUUID(),
    schema_version: 1,
    event_key: EVENT,
    match_key: matchKey,
    scout_id: scout.id,
    target_team_number: TEAM,
    alliance_color: 'red',
    station: 1,
    deleted: false,
  });
  if (rErr) throw new Error(`seed report: ${rErr.message}`);
  return scout.id as string;
}

beforeAll(async () => {
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  await admin.from('event').upsert({ event_key: EVENT, name: 'SS16', is_active: false });
  await admin.from('team').upsert({ team_number: TEAM, nickname: 'SS16' });
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

it('select_scouter consolidates duplicates that scouted the SAME match without violating idx_msr_match_scout_active', async () => {
  // Two duplicate rows, each with an ACTIVE report for the SAME match — the exact
  // shape that crashed the re-point before 0016.
  await seedDuplicateScoutWithReport(MATCH);
  await seedDuplicateScoutWithReport(MATCH);

  const device = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signin, error: sErr } = await device.auth.signInAnonymously();
  expect(sErr, sErr?.message).toBeNull();
  const uid = signin!.user!.id;

  const { data: scout, error } = await device.rpc('select_scouter', {
    p_event_key: EVENT,
    p_name: NAME,
  });
  expect(error, `select_scouter must not violate the unique index: ${error?.message}`).toBeNull();
  expect(scout?.auth_uid).toBe(uid);
  const deviceScoutId = scout!.id as string;

  // Exactly ONE active report survives for the match, owned by the device's row.
  const { data: active } = await admin
    .from('match_scouting_report')
    .select('id,scout_id')
    .eq('match_key', MATCH)
    .eq('deleted', false);
  expect(active!.length).toBe(1);
  expect(active![0].scout_id).toBe(deviceScoutId);

  // The duplicate rows are consolidated away — only the device row remains.
  const { data: scouts } = await admin
    .from('scout')
    .select('id')
    .eq('event_key', EVENT)
    .ilike('display_name', NAME);
  expect(scouts!.length).toBe(1);
  expect(scouts![0].id).toBe(deviceScoutId);

  await device.auth.signOut();
});
