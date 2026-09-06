// tests/db/rls.test.ts
//
// RLS / least-privilege boundary for the login-less, shared-trust model.
//
// The `explicit_browser_data_api_grants` migration made the browser Data API
// least-privilege: anon/authenticated hold SELECT on the openly-readable tables
// (event, match, scout, match_scouting_report, ...) but have NO direct
// INSERT/UPDATE grant on match_scouting_report, and NO grant at all on
// event_secret. So two of the original assertions were REFRAMED to the current
// contract:
//   * "anon CANNOT read event_secret" used to expect an empty RLS result set;
//     event_secret is now Data-API-PRIVATE to anon, so the probe is denied
//     outright (42501). The join_code is hidden more strongly than before.
//   * "anon can/can't insert a report directly" — direct table writes are gone
//     for every browser role; all report writes flow through the
//     `upsert_match_report` definer RPC. We assert the direct insert is denied
//     (42501, own OR foreign scout_id alike) and that the RPC is the working
//     write path. Attributing a report to a *non-existent* scout_id is
//     re-resolved to the caller's own row (never forged, never lost) — the
//     modern equivalent of the old "no foreign scout" guard. (Writing to an
//     EXISTING foreign scout via the RPC is intentionally open under this
//     model; that accepted BOLA/IDOR posture is covered in rpcs.test.ts.)
import { it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminClient,
  anonClient,
  provisionScouts,
  seedEvent,
  dropEvent,
  uniqueEventKey,
} from './seedHelpers';

const EVENT = uniqueEventKey('c3');
const TEAM = 999003;
const MATCH = `${EVENT}_qm1`;

let admin: SupabaseClient;
let anon: SupabaseClient; // no session — role `anon`
let device: SupabaseClient; // event member, drives the RPC write path
let myScoutId = '';
let foreignScoutId = '';

beforeAll(async () => {
  admin = adminClient();
  anon = anonClient();
  await seedEvent(admin, {
    eventKey: EVENT,
    name: 'C3',
    teams: [{ team_number: TEAM, nickname: 'C3' }],
    matches: [{ match_key: MATCH, match_number: 1, red1: TEAM }],
  });

  // Two real event-member scout rows: "me" (bound to the device's uid) and a
  // "foreign" scout, provisioned through the login-less select_scouter path.
  const provisioned = await provisionScouts(EVENT, ['other', 'me']);
  device = provisioned.client; // bound to the LAST name ("me")
  foreignScoutId = provisioned.scouts['other'];
  myScoutId = provisioned.scouts['me'];
}, 90_000);

afterAll(async () => {
  if (admin) await dropEvent(admin, EVENT);
  await device?.auth.signOut();
});

it('anon can read its event (open dashboard RLS)', async () => {
  const { data, error } = await anon.from('event').select('event_key,name').eq('event_key', EVENT);
  expect(error).toBeNull();
  expect(data?.length).toBe(1);
});

it('anon CANNOT read event_secret — join_code is Data-API private', async () => {
  const { error } = await anon.from('event_secret').select('join_code').eq('event_key', EVENT);
  // No anon grant on event_secret: the table is present but permission-denied
  // (42501), a stronger hiding than the old RLS default-deny empty set.
  expect(error?.code, `expected event_secret to be private, got ${error?.message}`).toBe('42501');
});

it('anon can read its event matches (open dashboard RLS)', async () => {
  const { data, error } = await anon.from('match').select('match_key').eq('event_key', EVENT);
  expect(error).toBeNull();
  expect(data?.length).toBe(1);
});

it('direct table report writes are denied for the browser (RPC-only write plane)', async () => {
  // Own scout_id: still denied — anon holds only SELECT on the report table.
  const own = await anon.from('match_scouting_report').insert({
    schema_version: 1, event_key: EVENT, match_key: MATCH, scout_id: myScoutId,
    target_team_number: TEAM, alliance_color: 'red', station: 1, fuel_bursts: [],
  });
  expect(own.error, 'direct insert must be denied by the missing table grant').not.toBeNull();
  expect(own.error?.code).toBe('42501');

  // Foreign scout_id: denied for the same reason (no direct write plane at all).
  const foreign = await anon.from('match_scouting_report').insert({
    schema_version: 1, event_key: EVENT, match_key: MATCH, scout_id: foreignScoutId,
    target_team_number: TEAM, alliance_color: 'red', station: 1, fuel_bursts: [],
  });
  expect(foreign.error).not.toBeNull();
  expect(foreign.error?.code).toBe('42501');
});

it('the upsert_match_report RPC is the working write path for a member', async () => {
  const reportId = crypto.randomUUID();
  const { error } = await device.rpc('upsert_match_report', {
    p: {
      id: reportId, schema_version: 1, event_key: EVENT, match_key: MATCH,
      scout_id: myScoutId, target_team_number: TEAM, alliance_color: 'red',
      station: 1, inactive_first: false, fuel_bursts: [], row_revision: 1,
    },
  });
  expect(error, error?.message).toBeNull();
  const row = await device
    .from('match_scouting_report')
    .select('scout_id')
    .eq('id', reportId)
    .single();
  expect(row.data!.scout_id).toBe(myScoutId);
});

it('a report addressed to a NON-EXISTENT scout_id is re-resolved to the caller, never forged', async () => {
  // The modern equivalent of the old "no foreign scout" WITH CHECK: a scout_id
  // that references no row is re-attributed to the caller's own scout row so the
  // capture always lands (BUG-1, migrations 0030/0032) — it is never written
  // under a fabricated identity and never silently lost.
  const reportId = crypto.randomUUID();
  const { error } = await device.rpc('upsert_match_report', {
    p: {
      id: reportId, schema_version: 1, event_key: EVENT, match_key: MATCH,
      scout_id: crypto.randomUUID(), // references no scout row
      target_team_number: TEAM, alliance_color: 'red', station: 1,
      inactive_first: false, fuel_bursts: [], row_revision: 1,
    },
  });
  expect(error, error?.message).toBeNull();
  const row = await device
    .from('match_scouting_report')
    .select('scout_id')
    .eq('id', reportId)
    .single();
  expect(row.data!.scout_id).toBe(myScoutId);
});
