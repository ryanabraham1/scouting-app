// tests/db/select_scouter.test.ts
// Regression for migration 0016 + the production-hardening identity work:
// picking the SAME scouter name from a second device must converge on ONE
// canonical scout row and must never violate idx_msr_match_scout_active (the
// "one active report per (match, scout)" partial unique index) — even when the
// first device already scouted the match. Before 0016 the report re-point
// collided; the hardening migration then added a unique index on
// (event_key, lower(display_name)) so multiple same-name rows can no longer even
// exist. This test drives the modern, reachable equivalent through the real
// login-less path (select_scouter + upsert_match_report), since direct
// service_role table seeding of duplicate rows is both ungranted AND now
// forbidden by that unique index.
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

const EVENT = uniqueEventKey('ss16');
const TEAM = 999016;
const MATCH = `${EVENT}_qm1`;
const NAME = 'Dup Tester';

let admin: SupabaseClient;

beforeAll(async () => {
  admin = adminClient();
  await seedEvent(admin, {
    eventKey: EVENT,
    name: 'SS16',
    teams: [{ team_number: TEAM, nickname: 'SS16' }],
    matches: [{ match_key: MATCH, match_number: 1, red1: TEAM }],
  });
}, 90_000);

afterAll(async () => {
  await dropEvent(admin, EVENT);
});

it('a second device picking the same name converges on one row without violating idx_msr_match_scout_active', async () => {
  // Device A picks the name and scouts the match under it.
  const deviceA = anonClient();
  await signInAnon(deviceA);
  const { data: aScout, error: aErr } = await deviceA.rpc('select_scouter', {
    p_event_key: EVENT,
    p_name: NAME,
  });
  expect(aErr, aErr?.message).toBeNull();
  const rowId = aScout!.id as string;

  const reportId = crypto.randomUUID();
  const { error: rErr } = await deviceA.rpc('upsert_match_report', {
    p: {
      id: reportId,
      schema_version: 1,
      event_key: EVENT,
      match_key: MATCH,
      scout_id: rowId,
      target_team_number: TEAM,
      alliance_color: 'red',
      station: 1,
      inactive_first: false,
      row_revision: 1,
      fuel_bursts: [],
    },
  });
  expect(rErr, rErr?.message).toBeNull();

  // Device B (a different uid) picks the SAME name. This is the exact shape that
  // crashed the re-point before 0016; it must succeed and re-bind the one row.
  const deviceB = anonClient();
  const uidB = await signInAnon(deviceB);
  const { data: bScout, error: bErr } = await deviceB.rpc('select_scouter', {
    p_event_key: EVENT,
    p_name: NAME,
  });
  expect(bErr, `select_scouter must not violate the unique index: ${bErr?.message}`).toBeNull();
  // Converges on the SAME canonical row, now bound to device B's uid.
  expect(bScout?.id).toBe(rowId);
  expect(bScout?.auth_uid).toBe(uidB);

  // Exactly ONE scout row survives for the name (read as the member device B).
  const { data: scouts, error: scoutsErr } = await deviceB
    .from('scout')
    .select('id')
    .eq('event_key', EVENT)
    .ilike('display_name', NAME);
  expect(scoutsErr, scoutsErr?.message).toBeNull();
  expect(scouts!.length).toBe(1);
  expect(scouts![0].id).toBe(rowId);

  // Exactly ONE active report survives for the match, still owned by that row —
  // the report was never lost across the identity re-bind.
  const { data: active, error: activeErr } = await deviceB
    .from('match_scouting_report')
    .select('id,scout_id')
    .eq('match_key', MATCH)
    .eq('deleted', false);
  expect(activeErr, activeErr?.message).toBeNull();
  expect(active!.length).toBe(1);
  expect(active![0].scout_id).toBe(rowId);
  expect(active![0].id).toBe(reportId);

  await deviceA.auth.signOut();
  await deviceB.auth.signOut();
}, 60_000);
