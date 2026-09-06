// tests/db/select_scouter_switch.test.ts
// Regression for migration 0036: scouting as one name then switching to another
// on the SAME device must NOT relabel the first name's reports. Before 0036,
// select_scouter upserted on (event_key, auth_uid) and overwrote display_name in
// place, so picking a second name retroactively reassigned every report from the
// first. Runs against the deployed DB (the function lives server-side).
//
// Fixtures use the legitimate granted paths: a throwaway event via the
// `promote_event_import` definer RPC, and match reports written through the real
// `upsert_match_report` RPC (direct `service_role`/anon table inserts are no
// longer granted). Reads use the anon member client, which can see its event's
// rows under RLS.
import { it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminClient,
  anonClient,
  signInAnon,
  seedEvent,
  dropEvent,
  uniqueEventKey,
} from './seedHelpers';

const EVENT = uniqueEventKey('ss36');
const TEAM = 999036;
const MATCH = `${EVENT}_qm1`;
const NAME_A = 'Test 5';
const NAME_B = 'Test 2';

let admin: SupabaseClient;

beforeAll(async () => {
  admin = adminClient();
  await seedEvent(admin, {
    eventKey: EVENT,
    name: 'SS36',
    teams: [{ team_number: TEAM, nickname: 'SS36' }],
    matches: [{ match_key: MATCH, match_number: 1, red1: TEAM }],
  });
}, 90_000);

afterAll(async () => {
  await dropEvent(admin, EVENT);
});

it('switching names on a device keeps the first name its own row + reports', async () => {
  const device = anonClient();
  await signInAnon(device);

  // 1. Pick "Test 5" and scout a match under it (through the real RPC).
  const { data: a, error: aErr } = await device.rpc('select_scouter', {
    p_event_key: EVENT,
    p_name: NAME_A,
  });
  expect(aErr, aErr?.message).toBeNull();
  const rowA = a!.id as string;

  const reportId = crypto.randomUUID();
  const { error: rErr } = await device.rpc('upsert_match_report', {
    p: {
      id: reportId,
      schema_version: 1,
      event_key: EVENT,
      match_key: MATCH,
      scout_id: rowA,
      target_team_number: TEAM,
      alliance_color: 'red',
      station: 1,
      inactive_first: false,
      row_revision: 1,
      fuel_bursts: [],
    },
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

  // The device is still an event member (now via "Test 2"'s row), so it can read
  // the event's scout + report rows under RLS.
  // "Test 5"'s row still exists, still named "Test 5".
  const { data: keptA } = await device
    .from('scout')
    .select('id,display_name')
    .eq('id', rowA)
    .single();
  expect(keptA?.display_name).toBe(NAME_A);

  // The report stays attributed to "Test 5"'s row — NOT transferred to "Test 2".
  const { data: rep } = await device
    .from('match_scouting_report')
    .select('scout_id')
    .eq('id', reportId)
    .single();
  expect(rep?.scout_id).toBe(rowA);

  await device.auth.signOut();
}, 60_000);
