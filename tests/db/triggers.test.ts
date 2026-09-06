// tests/db/triggers.test.ts
//
// Server-side scoring parity (the byte-equivalence contract) + the report
// revision/timestamp guard, exercised through the CURRENTLY-REACHABLE paths.
//
// The `explicit_browser_data_api_grants` migration revoked `service_role`'s
// broad table privileges, so the old fixture pattern — direct
// `admin.from('match_scouting_report').insert(...)` of hand-crafted rows, a
// direct `admin.update(...)` to trip the BEFORE UPDATE trigger, and direct
// deletes — is no longer possible for ANY Data API role (anon holds only
// SELECT on the report table; service_role holds none). Reports are now created
// through the `upsert_match_report` definer RPC, which runs the SAME
// `recompute_match_report_aggregates` these tests assert on, so the golden
// cases become an end-to-end proof of the server math. `recompute` is also
// invoked directly (still service_role-executable) on the RPC-written row to
// prove the standalone entrypoint agrees. Aggregates are read back with the
// anon client (open read policy + grant).
//
// Two assertions were REFRAMED to the reachable contract:
//   * The "BEFORE UPDATE bumps row_revision" trigger fires only on DIRECT
//     table updates, which no client can issue anymore. We instead assert the
//     observable guarantee the RPC provides: a newer revision advances
//     row_revision and updated_at monotonically.
//   * The negative-duration burst clamp inside `recompute` is now unreachable
//     because `validate_match_report_payload` (run by the RPC) REJECTS a burst
//     with endMs < startMs at ingress (22023) — corrupt bursts can no longer be
//     written at all. We assert that ingress rejection; the recompute clamp
//     remains as defense-in-depth (its TS twin is still covered by
//     src/scoring/__tests__/compute.test.ts).
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

const EVENT = uniqueEventKey('c2');
const TEAM = 999001;
// Distinct matches so each report occupies a distinct (match_key, scout_id)
// active slot and never supersedes another via the RPC's slot guard.
const MATCH1 = `${EVENT}_qm1`; // TEAM at red1  (test 1: parity + revision guard)
const MATCH2 = `${EVENT}_qm2`; // TEAM at blue2 (test 2: B3 golden)
const MATCH3 = `${EVENT}_qm3`; // TEAM at red3  (test 3: negative-burst rejection)

let admin: SupabaseClient;
let anon: SupabaseClient;
let device: SupabaseClient; // event member, drives upsert_match_report
let scoutId = '';

beforeAll(async () => {
  admin = adminClient();
  anon = anonClient();
  await seedEvent(admin, {
    eventKey: EVENT,
    name: 'C2 Test',
    teams: [{ team_number: TEAM, nickname: 'C2' }],
    matches: [
      { match_key: MATCH1, match_number: 1, red1: TEAM },
      { match_key: MATCH2, match_number: 2, blue2: TEAM },
      { match_key: MATCH3, match_number: 3, red3: TEAM },
    ],
  });
  const provisioned = await provisionScouts(EVENT, ['C2 scout']);
  device = provisioned.client;
  scoutId = provisioned.scouts['C2 scout'];
}, 90_000);

afterAll(async () => {
  if (admin) await dropEvent(admin, EVENT);
  await device?.auth.signOut();
});

it('recompute mirrors TS fuel-by-window math; inactiveFirst parity + boundary + rounding', async () => {
  // inactive_first = true => shift1,shift3 inactive; shift2,shift4 active.
  // Bursts attributed by their declared window field (recompute mirrors TS by-window sum):
  //  auto: 20s @ rate 1.0     -> 20 fuel (active)
  //  transition: 10s @ 0.5    -> 5 fuel (active)
  //  shift1 (inactive): 25s @ 2 -> 50 fuel (NOT counted in points; in teleop_fuel_inactive)
  //  shift2 (active): 25s @ 2 -> 50 fuel
  //  burst straddling 1:45 endgame boundary: start 105000 end 115000 @ 1.0 -> 10 fuel; startMs=105000 is shift4 (active)
  //  rounding: 3s @ 0.5 = 1.5 -> rounds half-up to 2 (its own window)
  const bursts = [
    { startMs: 0, endMs: 20000, rate: 1.0, window: 'auto' },
    { startMs: 0, endMs: 10000, rate: 0.5, window: 'transition' },
    { startMs: 10000, endMs: 35000, rate: 2.0, window: 'shift1' },
    { startMs: 35000, endMs: 60000, rate: 2.0, window: 'shift2' },
    { startMs: 105000, endMs: 115000, rate: 1.0, window: 'shift4' },
    { startMs: 60000, endMs: 63000, rate: 0.5, window: 'shift3' },
  ];
  const reportId = crypto.randomUUID();
  const { error: upErr } = await device.rpc('upsert_match_report', {
    p: {
      id: reportId,
      schema_version: 1,
      event_key: EVENT,
      match_key: MATCH1,
      scout_id: scoutId,
      target_team_number: TEAM,
      alliance_color: 'red',
      station: 1,
      inactive_first: true,
      fuel_bursts: bursts,
      row_revision: 1,
    },
  });
  expect(upErr, upErr?.message).toBeNull();

  const { data: out } = await anon
    .from('match_scouting_report')
    .select('auto_fuel,teleop_fuel_active,teleop_fuel_inactive,endgame_fuel,fuel_by_shift,fuel_points')
    .eq('id', reportId)
    .single();

  // auto burst classified to auto window only.
  expect(out!.auto_fuel).toBe(20);
  // fuel_by_shift indexes 0..3 = shift1..shift4 rounded per window.
  // shift1: 25s*2=50 ; shift2: 25s*2=50 ; shift3: 3s*0.5=1.5 -> 2 ; shift4: burst start 105000 -> window shift4, 10s*1=10
  expect(out!.fuel_by_shift).toEqual([50, 50, 2, 10]);
  // endgame_fuel: no burst with window 'endgame' -> 0
  expect(out!.endgame_fuel).toBe(0);
  // teleop_fuel_active = transition(5) + active shifts(shift2=50, shift4=10) = 65
  expect(out!.teleop_fuel_active).toBe(65);
  // teleop_fuel_inactive = inactive shifts shift1(50)+shift3(2) = 52
  expect(out!.teleop_fuel_inactive).toBe(52);
  // fuel_points = active windows: auto(20)+transition(5)+endgame(0)+shift2(50)+shift4(10) = 85, *1
  expect(out!.fuel_points).toBe(85);

  // REFRAMED revision/timestamp guard: the BEFORE UPDATE trigger's auto-bump is
  // only reachable through a direct table UPDATE, which no client can issue.
  // The observable contract is the RPC's monotonic revision + advancing
  // updated_at, so assert that instead.
  const before = await anon
    .from('match_scouting_report')
    .select('row_revision,updated_at')
    .eq('id', reportId)
    .single();
  const { error: bumpErr } = await device.rpc('upsert_match_report', {
    p: {
      id: reportId,
      schema_version: 1,
      event_key: EVENT,
      match_key: MATCH1,
      scout_id: scoutId,
      target_team_number: TEAM,
      alliance_color: 'red',
      station: 1,
      inactive_first: true,
      fuel_bursts: bursts,
      row_revision: 2,
      notes: 'touch',
    },
  });
  expect(bumpErr, bumpErr?.message).toBeNull();
  const after = await anon
    .from('match_scouting_report')
    .select('row_revision,updated_at')
    .eq('id', reportId)
    .single();
  expect(after.data!.row_revision).toBeGreaterThan(before.data!.row_revision);
  expect(new Date(after.data!.updated_at).getTime())
    .toBeGreaterThanOrEqual(new Date(before.data!.updated_at).getTime());
}, 30_000);

it('recompute matches the B3 TS computeAggregates golden case (declared-window attribution + straddle)', async () => {
  // FROZEN B3 golden input, inactive_first = true => shift1,shift3 inactive; shift2,shift4 active.
  // Critical: bursts are attributed by their DECLARED window field, NOT re-derived from startMs.
  // The shift1 burst startMs=8000 straddles into transition's [0,10000) ms range but is
  // declared "shift1" and must count toward shift1 (TS: floatByWindow[b.window]).
  // Per-window float -> round-half-up once:
  //  auto:       0.5*(9000-0)/1000      = 4.5  -> 5
  //  transition: 0.5*(5000-0)/1000      = 2.5  -> 3
  //  shift1:     1.0*(12000-8000)/1000  = 4.0 + 0.5*(18000-15000)/1000 = 1.5 => 5.5 -> 6
  //  shift2:     0.5*(42000-35000)/1000 = 3.5  -> 4
  //  shift3:     0.5*(65000-60000)/1000 = 2.5  -> 3
  //  shift4:     0.5*(88000-85000)/1000 = 1.5  -> 2
  //  endgame:    0.5*(123000-110000)/1000 = 6.5 -> 7
  const bursts = [
    { startMs: 0, endMs: 9000, rate: 0.5, window: 'auto' },
    { startMs: 0, endMs: 5000, rate: 0.5, window: 'transition' },
    { startMs: 8000, endMs: 12000, rate: 1.0, window: 'shift1' },
    { startMs: 15000, endMs: 18000, rate: 0.5, window: 'shift1' },
    { startMs: 35000, endMs: 42000, rate: 0.5, window: 'shift2' },
    { startMs: 60000, endMs: 65000, rate: 0.5, window: 'shift3' },
    { startMs: 85000, endMs: 88000, rate: 0.5, window: 'shift4' },
    { startMs: 110000, endMs: 123000, rate: 0.5, window: 'endgame' },
  ];
  const b3Id = crypto.randomUUID();
  const { error: upErr } = await device.rpc('upsert_match_report', {
    p: {
      id: b3Id,
      schema_version: 1,
      event_key: EVENT,
      match_key: MATCH2,
      scout_id: scoutId,
      target_team_number: TEAM,
      alliance_color: 'blue',
      station: 2,
      inactive_first: true,
      fuel_bursts: bursts,
      row_revision: 1,
    },
  });
  expect(upErr, upErr?.message).toBeNull();

  // The standalone recompute entrypoint is still service_role-executable; invoke
  // it directly on the RPC-written row to prove it agrees with the recompute the
  // RPC already ran (it recomputes aggregates identically; the row_revision bump
  // from its direct UPDATE is irrelevant here — this test asserts only math).
  const { error: rcErr } = await admin.rpc('recompute_match_report_aggregates', { p_report_id: b3Id });
  expect(rcErr, rcErr?.message).toBeNull();

  const { data: out } = await anon
    .from('match_scouting_report')
    .select('auto_fuel,teleop_fuel_active,teleop_fuel_inactive,endgame_fuel,fuel_by_shift,fuel_points')
    .eq('id', b3Id)
    .single();

  expect(out!.auto_fuel).toBe(5);
  expect(out!.fuel_by_shift).toEqual([6, 4, 3, 2]);
  expect(out!.endgame_fuel).toBe(7);
  // teleop_fuel_active = transition(3) + active shifts shift2(4)+shift4(2) = 9
  expect(out!.teleop_fuel_active).toBe(9);
  // teleop_fuel_inactive = inactive shifts shift1(6)+shift3(3) = 9
  expect(out!.teleop_fuel_inactive).toBe(9);
  // fuel_points = auto(5)+transition(3)+endgame(7)+shift2(4)+shift4(2) = 21, *1
  expect(out!.fuel_points).toBe(21);
}, 30_000);

it('rejects a negative-duration burst at ingress (0040 clamp moved to write validation)', async () => {
  // Mirrors src/scoring/__tests__/compute.test.ts "negative-duration bursts
  // contribute ZERO fuel". The recompute clamp still exists as defense-in-depth,
  // but a corrupt burst (endMs < startMs) can no longer be WRITTEN: the RPC's
  // validate_match_report_payload rejects it up front with 22023, so the clamp
  // is now an unreachable safety net rather than an observable behavior.
  const bursts = [
    { startMs: 0, endMs: 4000, rate: 1.0, window: 'auto' }, // 4.0 fuel
    { startMs: 9000, endMs: 3000, rate: 2.0, window: 'auto' }, // corrupt: endMs < startMs
  ];
  const negId = crypto.randomUUID();
  const { error } = await device.rpc('upsert_match_report', {
    p: {
      id: negId,
      schema_version: 1,
      event_key: EVENT,
      match_key: MATCH3,
      scout_id: scoutId,
      target_team_number: TEAM,
      alliance_color: 'red',
      station: 3,
      inactive_first: false,
      fuel_bursts: bursts,
      row_revision: 1,
    },
  });
  expect(error, 'a negative-duration burst must be rejected before it can be stored').not.toBeNull();
  expect(error?.code).toBe('22023');

  // Nothing was persisted for the corrupt payload.
  const { data } = await anon
    .from('match_scouting_report')
    .select('id')
    .eq('id', negId)
    .maybeSingle();
  expect(data).toBeNull();
}, 30_000);
