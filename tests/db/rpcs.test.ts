// tests/db/rpcs.test.ts
//
// Live RPC behavior against the deployed backend. Fixtures are seeded through
// the legitimate, currently-granted paths (see ./seedHelpers): a throwaway event
// via the `promote_event_import` definer RPC and an event-member scout via the
// anon `select_scouter` RPC. Direct `service_role` table seeding and the
// `join_event` join-code RPC are intentionally no longer client-callable, so
// those stale assertions have been replaced with the real `select_scouter`
// membership path the app uses.
import { it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminClient,
  joinAsScout,
  seedEvent,
  dropEvent,
  uniqueEventKey,
} from './seedHelpers';

const EVENT = uniqueEventKey('rpc');
const TEAM = 999004;
const MATCH = `${EVENT}_qm1`;
const MATCH2 = `${EVENT}_qm2`; // avoids the (match_key, scout_id) active-report unique index
const NAME = 'C4 scout';

let admin: SupabaseClient;
let device: SupabaseClient; // anon, event member
let myUid = '';
let myScoutId = '';

beforeAll(async () => {
  admin = adminClient();
  // MATCH puts TEAM at red1; MATCH2 puts TEAM at blue2 (the seats the tests use).
  await seedEvent(admin, {
    eventKey: EVENT,
    name: 'C4',
    teams: [{ team_number: TEAM, nickname: 'C4' }],
    matches: [
      { match_key: MATCH, match_number: 1, red1: TEAM },
      { match_key: MATCH2, match_number: 2, blue2: TEAM },
    ],
  });

  const member = await joinAsScout(EVENT, NAME);
  device = member.client;
  myUid = member.uid;
  myScoutId = member.scoutId;
}, 90_000);

afterAll(async () => {
  await dropEvent(admin, EVENT);
  await device?.auth.signOut();
});

it('select_scouter provisions an event-member scout row bound to the caller uid', async () => {
  expect(myScoutId, 'select_scouter must return a scout id').toBeTruthy();
  const { data, error } = await device.rpc('select_scouter', {
    p_event_key: EVENT,
    p_name: NAME,
  });
  expect(error, error?.message).toBeNull();
  expect(data?.id).toBe(myScoutId);
  expect(data?.auth_uid).toBe(myUid);
});

it('select_scouter is idempotent for the same uid + name', async () => {
  const { data, error } = await device.rpc('select_scouter', {
    p_event_key: EVENT,
    p_name: NAME,
  });
  expect(error, error?.message).toBeNull();
  expect(data?.id).toBe(myScoutId);
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
  let res = await device.rpc('upsert_match_report', { p: base });
  expect(res.error, res.error?.message).toBeNull();
  let row = await device.from('match_scouting_report')
    .select('row_revision,auto_fuel,fuel_points').eq('id', reportId).single();
  expect(row.data!.auto_fuel).toBe(20);   // recompute ran
  expect(row.data!.fuel_points).toBe(20);

  // stale write at revision 3 must be IGNORED
  res = await device.rpc('upsert_match_report', {
    p: { ...base, row_revision: 3, fuel_bursts: [{ startMs: 0, endMs: 10000, rate: 5, window: 'auto' }] },
  });
  expect(res.error).toBeNull();
  row = await device.from('match_scouting_report').select('auto_fuel').eq('id', reportId).single();
  expect(row.data!.auto_fuel).toBe(20);    // unchanged — stale rejected

  // newer write at revision 9 wins
  res = await device.rpc('upsert_match_report', {
    p: { ...base, row_revision: 9, fuel_bursts: [{ startMs: 0, endMs: 10000, rate: 4, window: 'auto' }] },
  });
  expect(res.error).toBeNull();
  row = await device.from('match_scouting_report').select('auto_fuel,row_revision').eq('id', reportId).single();
  expect(row.data!.auto_fuel).toBe(40);    // 10s*4 = 40
  expect(row.data!.row_revision).toBe(9);
});

it('upsert_match_report SUCCEEDS for scout owned by caller (forge guard - self)', async () => {
  const reportId = crypto.randomUUID();
  const selfReport = {
    id: reportId,
    schema_version: 1,
    event_key: EVENT,
    match_key: MATCH2, // use MATCH2 to avoid collision with existing MATCH+myScoutId row
    scout_id: myScoutId,     // owned by this anon user
    target_team_number: TEAM,
    alliance_color: 'blue',
    station: 2,
    inactive_first: false,
    row_revision: 1,
    fuel_bursts: [{ startMs: 0, endMs: 5000, rate: 1.0, window: 'auto' }],
  };
  const { error } = await device.rpc('upsert_match_report', { p: selfReport });
  expect(error, `own report should succeed: ${error?.message}`).toBeNull();
});

it('upsert_match_report RE-RESOLVES a non-existent scout_id to the caller (BUG-1, migrations 0030/0032)', async () => {
  // PREVIOUS behavior (0012): a non-existent scout_id raised 23503. That hard
  // reject is exactly what permanently dead-lettered a scout's matches when
  // select_scouter consolidation deleted the scout row a queued report referenced
  // (e.g. the same name picked on a second device) — silent data loss.
  //
  // NEW behavior (0030 + 0032): a missing scout_id is RE-RESOLVED instead of
  // rejected — by scout_name, else to the authenticated caller's OWN scout row for
  // the event, else provisioned — so the capture always lands. Here the anon caller
  // already joined the event, so the report is re-attributed to their own row.
  const reportId = crypto.randomUUID();
  const forgedReport = {
    id: reportId,
    schema_version: 1,
    event_key: EVENT,
    match_key: MATCH2,
    scout_id: crypto.randomUUID(), // references no scout row
    target_team_number: TEAM,
    alliance_color: 'blue',
    station: 2,
    inactive_first: false,
    row_revision: 1,
    fuel_bursts: [],
  };
  const { error } = await device.rpc('upsert_match_report', { p: forgedReport });
  expect(error, `re-resolved report should succeed: ${error?.message}`).toBeNull();
  // Attributed to the caller's OWN scout row, not the forged id — and never lost.
  const row = await device
    .from('match_scouting_report')
    .select('scout_id')
    .eq('id', reportId)
    .single();
  expect(row.data!.scout_id).toBe(myScoutId);
});
