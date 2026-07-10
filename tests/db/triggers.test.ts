import { it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
let admin: SupabaseClient;

const EVENT = 'TESTC2evt';
const TEAM = 999001;
const MATCH = 'TESTC2evt_qm1';
const MATCH2 = 'TESTC2evt_qm2';
let scoutId = '';
let reportId = '';

beforeAll(async () => {
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  await admin.from('event').upsert({ event_key: EVENT, name: 'C2 Test', is_active: false });
  await admin.from('team').upsert({ team_number: TEAM, nickname: 'C2' });
  await admin.from('match').upsert({ match_key: MATCH, event_key: EVENT, comp_level: 'qm', match_number: 1 });
  await admin.from('match').upsert({ match_key: MATCH2, event_key: EVENT, comp_level: 'qm', match_number: 2 });
  // Conflict on the per-event composite (the legacy global UNIQUE(auth_uid) was
  // dropped in migration 0029). auth_uid is random here, so this is effectively a
  // plain insert; the target just needs to be a real unique constraint.
  const { data: s } = await admin.from('scout')
    .upsert({ event_key: EVENT, display_name: 'C2 scout', auth_uid: crypto.randomUUID() }, { onConflict: 'event_key,auth_uid' })
    .select().single();
  scoutId = s!.id;
});

afterAll(async () => {
  if (reportId) await admin.from('match_scouting_report').delete().eq('id', reportId);
  await admin.from('scout').delete().eq('id', scoutId);
  await admin.from('match').delete().eq('match_key', MATCH);
  await admin.from('match').delete().eq('match_key', MATCH2);
  await admin.from('event_team').delete().eq('event_key', EVENT);
  await admin.from('team').delete().eq('team_number', TEAM);
  await admin.from('event').delete().eq('event_key', EVENT);
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
  const { data: r, error: insErr } = await admin.from('match_scouting_report').insert({
    schema_version: 1, event_key: EVENT, match_key: MATCH, scout_id: scoutId,
    target_team_number: TEAM, alliance_color: 'red', station: 1,
    inactive_first: true, fuel_bursts: bursts,
  }).select().single();
  expect(insErr, insErr?.message).toBeNull();
  reportId = r!.id;

  const { error: rcErr } = await admin.rpc('recompute_match_report_aggregates', { p_report_id: reportId });
  expect(rcErr, rcErr?.message).toBeNull();

  const { data: out } = await admin.from('match_scouting_report')
    .select('auto_fuel,teleop_fuel_active,teleop_fuel_inactive,endgame_fuel,fuel_by_shift,fuel_points')
    .eq('id', reportId).single();

  // auto burst classified to auto window only.
  expect(out!.auto_fuel).toBe(20);
  // fuel_by_shift indexes 0..3 = shift1..shift4 rounded per window.
  // shift1: 25s*2=50 ; shift2: 25s*2=50 ; shift3: 3s*0.5=1.5 -> 2 ; shift4: burst start 105000 -> window shift4, 10s*1=10
  expect(out!.fuel_by_shift).toEqual([50, 50, 2, 10]);
  // endgame_fuel: no burst with startMs>=110000 -> 0
  expect(out!.endgame_fuel).toBe(0);
  // teleop_fuel_active = transition(5) + active shifts(shift2=50, shift4=10) = 65
  expect(out!.teleop_fuel_active).toBe(65);
  // teleop_fuel_inactive = inactive shifts shift1(50)+shift3(2) = 52
  expect(out!.teleop_fuel_inactive).toBe(52);
  // fuel_points = active windows: auto(20)+transition(5)+endgame(0)+shift2(50)+shift4(10) = 85, *1
  expect(out!.fuel_points).toBe(85);
});

it('BEFORE UPDATE bumps row_revision and updated_at', async () => {
  const before = await admin.from('match_scouting_report')
    .select('row_revision,updated_at').eq('id', reportId).single();
  await admin.from('match_scouting_report').update({ notes: 'touch' }).eq('id', reportId);
  const after = await admin.from('match_scouting_report')
    .select('row_revision,updated_at').eq('id', reportId).single();
  expect(after.data!.row_revision).toBe(before.data!.row_revision + 1);
  expect(new Date(after.data!.updated_at).getTime())
    .toBeGreaterThanOrEqual(new Date(before.data!.updated_at).getTime());
});

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
  const { data: r, error: insErr } = await admin.from('match_scouting_report').insert({
    schema_version: 1, event_key: EVENT, match_key: MATCH2, scout_id: scoutId,
    target_team_number: TEAM, alliance_color: 'blue', station: 2,
    inactive_first: true, fuel_bursts: bursts,
  }).select().single();
  expect(insErr, insErr?.message).toBeNull();
  const b3Id = r!.id as string;

  try {
    const { error: rcErr } = await admin.rpc('recompute_match_report_aggregates', { p_report_id: b3Id });
    expect(rcErr, rcErr?.message).toBeNull();

    const { data: out } = await admin.from('match_scouting_report')
      .select('auto_fuel,teleop_fuel_active,teleop_fuel_inactive,endgame_fuel,fuel_by_shift,fuel_points')
      .eq('id', b3Id).single();

    expect(out!.auto_fuel).toBe(5);
    expect(out!.fuel_by_shift).toEqual([6, 4, 3, 2]);
    expect(out!.endgame_fuel).toBe(7);
    // teleop_fuel_active = transition(3) + active shifts shift2(4)+shift4(2) = 9
    expect(out!.teleop_fuel_active).toBe(9);
    // teleop_fuel_inactive = inactive shifts shift1(6)+shift3(3) = 9
    expect(out!.teleop_fuel_inactive).toBe(9);
    // fuel_points = auto(5)+transition(3)+endgame(7)+shift2(4)+shift4(2) = 21, *1
    expect(out!.fuel_points).toBe(21);
  } finally {
    await admin.from('match_scouting_report').delete().eq('id', b3Id);
  }
});

it('recompute clamps a negative-duration burst to ZERO fuel (0040 parity with TS)', async () => {
  // Mirrors src/scoring/__tests__/compute.test.ts "negative-duration bursts
  // contribute ZERO fuel": a corrupt/merged burst with endMs < startMs must
  // count as 0 on the server too, never subtract from its window.
  const bursts = [
    { startMs: 0, endMs: 4000, rate: 1.0, window: 'auto' }, // 4.0 fuel
    { startMs: 9000, endMs: 3000, rate: 2.0, window: 'auto' }, // corrupt: would be -12
    { startMs: 5000, endMs: 1000, rate: 5.0, window: 'shift1' }, // corrupt: would be -20
  ];
  const { data: r, error: insErr } = await admin.from('match_scouting_report').insert({
    schema_version: 1, event_key: EVENT, match_key: MATCH2, scout_id: scoutId,
    target_team_number: TEAM, alliance_color: 'red', station: 3,
    inactive_first: false, fuel_bursts: bursts,
  }).select().single();
  expect(insErr, insErr?.message).toBeNull();
  const negId = r!.id as string;

  try {
    const { error: rcErr } = await admin.rpc('recompute_match_report_aggregates', { p_report_id: negId });
    expect(rcErr, rcErr?.message).toBeNull();

    const { data: out } = await admin.from('match_scouting_report')
      .select('auto_fuel,fuel_by_shift,fuel_points')
      .eq('id', negId).single();

    expect(out!.auto_fuel).toBe(4); // 4.0 + 0, NOT 4.0 - 12
    expect(out!.fuel_by_shift).toEqual([0, 0, 0, 0]); // 0, NOT -20
    expect(out!.fuel_points).toBe(4);
  } finally {
    await admin.from('match_scouting_report').delete().eq('id', negId);
  }
});
