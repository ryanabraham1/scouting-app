// tests/db/upsert_match_report_contract.test.ts
//
// LIVE client<->server CONTRACT / ROUND-TRIP test for match reports, against the
// DEPLOYED Supabase backend. This is the layer the earlier review skipped: it
// exercises the REAL wire path a scout's save takes —
//
//   LocalMatchReport --toUpsertPayload()--> upsert_match_report RPC --recompute-->
//     match_scouting_report row --anon SELECT--> aggregates
//
// and asserts (1) the server ACCEPTS the client-produced payload (no validation
// dead-letter) and (2) the server-recomputed aggregates EQUAL the client's
// computeAggregates() for the same raw inputs (the "byte-equivalence" invariant in
// docs/game-migration/04-scoring-sync-contract.md, actually EXECUTED, not eyeballed).
//
// It also pins the exact regression that shipped: a report with a tri-state
// inactive_first = null AND a feeding burst tagged with the 'auto' window must be
// ACCEPTED (before the fix these were terminal-rejected: "inactive_first must be a
// JSON boolean" / "feeding burst is malformed").
//
// SEEDING NOTE: the recent explicit-grants migration reduced service_role to
// near-zero direct table access, so the classic `admin.from('event'/'match'/'scout')`
// fixture seeding no longer works. This test therefore seeds ONLY through the
// currently-granted, real user paths: the open import-event Edge Function creates
// the event + schedule, and the anon `select_scouter` RPC provisions a scout row.
// Reports are written to the real Phase-1 event (2026casnv) under a UNIQUE throwaway
// scout name and SOFT-DELETED in cleanup, so no real event data is mutated.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { toUpsertPayload } from '../../src/sync/mapReport';
import { computeAggregates } from '../../src/scoring/compute';
import { SCHEMA_VERSION } from '../../src/scoring/constants';
import type { LocalMatchReport } from '../../src/db/types';
import type { FuelBurst } from '../../src/scoring/types';

config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const EVENT_KEY = '2026casnv';
const IMPORT_URL = `${URL}/functions/v1/import-event`;

let anon: SupabaseClient;
let scoutId = '';
let matchKey = '';
let targetTeam = 0;
const createdReportIds: string[] = [];
// Unique, throwaway identity so select_scouter's same-name consolidation can never
// touch a real scout row for this event.
const SCOUT_NAME = `_contracttest_${crypto.randomUUID().slice(0, 8)}`;

/** Raw inputs shared by a report body + the client-side aggregate expectation. */
interface RawInputs {
  fuelBursts: FuelBurst[];
  feedingBursts: FuelBurst[];
  inactiveFirst: boolean | null;
}

function buildReport(inputs: RawInputs): LocalMatchReport {
  return {
    id: crypto.randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    appVersion: 'contract-test',
    deviceId: 'contract-test-device',
    createdAt: new Date().toISOString(),
    eventKey: EVENT_KEY,
    matchKey,
    scoutId,
    scoutName: SCOUT_NAME,
    targetTeamNumber: targetTeam,
    allianceColor: 'red',
    station: 1,
    inactiveFirst: inputs.inactiveFirst,
    inactiveFirstSource: inputs.inactiveFirst == null ? null : 'scout',
    teleopClockUnconfirmed: false,
    fuelBursts: inputs.fuelBursts,
    feedingBursts: inputs.feedingBursts,
    autoFuel: 0,
    teleopFuelActive: 0,
    teleopFuelInactive: 0,
    endgameFuel: 0,
    fuelByShift: [0, 0, 0, 0],
    fuelPoints: 0,
    fuelEstimateConfidence: 1,
    climbLevel: 0,
    climbAttempted: false,
    climbSuccess: false,
    autoStartPosition: null,
    autoPath: null,
    autoLeftStartingLine: true,
    autoClimbLevel1: false,
    intakeSources: ['ground'],
    maxFuelCapacityObserved: 0,
    defenseRating: 0,
    driverSkill: 0,
    agility: 0,
    defenseDurationMs: 0,
    defendedDurationMs: 0,
    defenseIntervals: [],
    defendedIntervals: [],
    pins: 0,
    foulsMinor: 0,
    foulsMajor: 0,
    foulReasons: [],
    noShow: false,
    died: false,
    tipped: false,
    droppedFuel: false,
    fedCorral: inputs.feedingBursts.length > 0,
    notes: 'contract round-trip',
    syncState: 'dirty',
    rowRevision: 1,
    syncAttempts: 0,
    lastSyncError: null,
  };
}

beforeAll(async () => {
  // (1) Ensure the event + schedule exist. import-event is open (login-less) and
  //     idempotent; it also creates the join code + teams + qm matches.
  const res = await fetch(IMPORT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
    },
    body: JSON.stringify({ event_key: EVENT_KEY }),
  });
  if (res.status !== 200) {
    throw new Error(`import-event seed failed: ${res.status} ${await res.text()}`);
  }

  // (2) Anonymous session — satisfies RLS and gives select_scouter an auth.uid().
  anon = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signErr } = await anon.auth.signInAnonymously();
  expect(signErr, signErr?.message).toBeNull();

  // (3) Provision a scout row via the real RPC the app uses (definer; works even
  //     though anon has no direct `scout` table grant). This also makes the caller
  //     a member of the event so match/report reads pass RLS.
  const { data: scout, error: scoutErr } = await anon.rpc('select_scouter', {
    p_event_key: EVENT_KEY,
    p_name: SCOUT_NAME,
  });
  expect(scoutErr, scoutErr?.message).toBeNull();
  scoutId = (scout as { id: string }).id;
  expect(scoutId).toBeTruthy();

  // (4) Pick a real qm match + a real team on it (now readable as a member).
  const { data: match, error: matchErr } = await anon
    .from('match')
    .select('match_key,red1')
    .eq('event_key', EVENT_KEY)
    .eq('comp_level', 'qm')
    .not('red1', 'is', null)
    .order('match_number', { ascending: true })
    .limit(1)
    .single();
  expect(matchErr, matchErr?.message).toBeNull();
  matchKey = (match as { match_key: string }).match_key;
  targetTeam = (match as { red1: number }).red1;
  expect(matchKey).toBeTruthy();
  expect(targetTeam).toBeGreaterThan(0);
}, 90_000);

afterAll(async () => {
  // Non-destructive cleanup: soft-delete every report we created (bump the
  // revision so the guard applies the delete). Leaves real event data untouched.
  for (const id of createdReportIds) {
    await anon.rpc('upsert_match_report', {
      p: {
        id,
        schema_version: SCHEMA_VERSION,
        event_key: EVENT_KEY,
        match_key: matchKey,
        scout_id: scoutId,
        scout_name: SCOUT_NAME,
        target_team_number: targetTeam,
        alliance_color: 'red',
        station: 1,
        inactive_first: false,
        row_revision: 99,
        deleted: true,
        fuel_bursts: [],
      },
    });
  }
});

describe('upsert_match_report live client<->server contract', () => {
  it('accepts a real mapReport payload and recomputes aggregates == client computeAggregates', async () => {
    const inputs: RawInputs = {
      inactiveFirst: false,
      feedingBursts: [],
      fuelBursts: [
        { startMs: 0, endMs: 10000, rate: 1, window: 'auto' },
        { startMs: 0, endMs: 5000, rate: 2, window: 'transition' },
        { startMs: 20000, endMs: 30000, rate: 1, window: 'shift1' },
        { startMs: 30000, endMs: 40000, rate: 2, window: 'shift2' },
        { startMs: 40000, endMs: 50000, rate: 1, window: 'shift3' },
        { startMs: 50000, endMs: 60000, rate: 2, window: 'shift4' },
        { startMs: 130000, endMs: 140000, rate: 1, window: 'endgame' },
      ],
    };
    const report = buildReport(inputs);
    createdReportIds.push(report.id);

    const { data, error } = await anon.rpc('upsert_match_report', {
      p: toUpsertPayload(report),
    });
    expect(error, `server rejected a valid mapReport payload: ${error?.message}`).toBeNull();
    expect((data as { status?: string })?.status).toBe('applied');

    // Server recomputed the aggregates from the raw bursts. Read them back as a
    // member (service_role can no longer SELECT this table) and compare to the
    // client's pure computeAggregates for the SAME inputs.
    const { data: row, error: readErr } = await anon
      .from('match_scouting_report')
      .select('auto_fuel,teleop_fuel_active,teleop_fuel_inactive,endgame_fuel,fuel_by_shift,fuel_points')
      .eq('id', report.id)
      .single();
    expect(readErr, readErr?.message).toBeNull();

    const expected = computeAggregates({
      schemaVersion: SCHEMA_VERSION,
      inactiveFirst: inputs.inactiveFirst ?? false,
      fuelBursts: inputs.fuelBursts,
      climbLevel: 0,
      autoClimbLevel1: false,
      noShow: false,
    });

    const server = row as {
      auto_fuel: number;
      teleop_fuel_active: number;
      teleop_fuel_inactive: number;
      endgame_fuel: number;
      fuel_by_shift: number[];
      fuel_points: number;
    };
    expect(server.auto_fuel).toBe(expected.autoFuel);
    expect(server.teleop_fuel_active).toBe(expected.teleopFuelActive);
    expect(server.teleop_fuel_inactive).toBe(expected.teleopFuelInactive);
    expect(server.endgame_fuel).toBe(expected.endgameFuel);
    expect(server.fuel_by_shift).toEqual(expected.fuelByShift);
    expect(server.fuel_points).toBe(expected.fuelPoints);
  }, 60_000);

  it('accepts a tri-state inactive_first=null report with an auto-window feeding burst (shipped-bug regression)', async () => {
    // The EXACT class that dead-lettered: inactive_first null + feeding burst in
    // the auto window. Must be accepted (not terminal-rejected).
    const report = buildReport({
      inactiveFirst: null,
      feedingBursts: [{ startMs: 0, endMs: 5000, rate: 1, window: 'auto' }],
      fuelBursts: [{ startMs: 0, endMs: 8000, rate: 1, window: 'auto' }],
    });
    createdReportIds.push(report.id);

    const { data, error } = await anon.rpc('upsert_match_report', {
      p: toUpsertPayload(report),
    });
    expect(
      error,
      `server rejected the tri-state/auto-feeding report (fix not deployed?): ${error?.message}`,
    ).toBeNull();
    expect((data as { status?: string })?.status).toBe('applied');

    // null inactive_first coalesces to false server-side; aggregates still match.
    const { data: row, error: readErr } = await anon
      .from('match_scouting_report')
      .select('auto_fuel,fuel_points')
      .eq('id', report.id)
      .single();
    expect(readErr, readErr?.message).toBeNull();
    const expected = computeAggregates({
      schemaVersion: SCHEMA_VERSION,
      inactiveFirst: false,
      fuelBursts: report.fuelBursts,
      climbLevel: 0,
      autoClimbLevel1: false,
      noShow: false,
    });
    expect((row as { auto_fuel: number }).auto_fuel).toBe(expected.autoFuel);
    expect((row as { fuel_points: number }).fuel_points).toBe(expected.fuelPoints);
  }, 60_000);

  it('accepts a client-repaired late fuel burst and oversized auto path', async () => {
    const report = buildReport({
      inactiveFirst: false,
      feedingBursts: [],
      fuelBursts: [
        { startMs: 19_999.6, endMs: 20_120.4, rate: 31, window: 'auto' },
      ],
    });
    report.autoPath = Array.from({ length: 400 }, (_, index) => ({
      x: index / 399,
      y: 1 - index / 399,
    }));
    createdReportIds.push(report.id);

    const payload = toUpsertPayload(report);
    expect(payload.fuel_bursts).toEqual([
      { startMs: 20_000, endMs: 20_000, rate: 30, window: 'auto' },
    ]);
    expect(payload.auto_path).toHaveLength(256);

    const { data, error } = await anon.rpc('upsert_match_report', { p: payload });
    expect(error, `server rejected the repaired payload: ${error?.message}`).toBeNull();
    expect((data as { status?: string })?.status).toBe('applied');
  }, 60_000);
});
