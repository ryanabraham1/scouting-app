// src/sync/__tests__/upsertPayloadContract.test.ts
//
// PURE (no-network) client<->server WIRE-SHAPE contract guard for match reports.
//
// WHY THIS EXISTS: a recent change shipped a bug that dead-lettered legitimate
// reports with SERVER-SIDE validation errors ("inactive_first must be a JSON
// boolean", "feeding burst is malformed") from upsert_match_report. The existing
// unit tests never caught it because they hand-build report objects and mock the
// Supabase RPC, so the REAL client mapReport (`toUpsertPayload`) output was never
// checked against what the server's `validate_match_report_payload` accepts.
//
// This test closes that gap WITHOUT a network round-trip (so it runs in the
// default `npm test` the earlier review DID run): it imports the REAL client
// `toUpsertPayload`, and it PARSES THE ACTUAL server validator SQL from the latest
// migration that (re)defines validate_match_report_payload. It then asserts the
// client's emitted wire shape is inside what the server accepts. If EITHER side
// drifts — the client starts emitting a window/type the server rejects, or the
// server tightens the validator below what the client emits — this test fails.
//
// The live remote round-trip lives in tests/db/upsert_match_report_contract.test.ts
// (integration); this pure test is the fast canary that gates every `npm test`.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toUpsertPayload } from '../mapReport';
import type { LocalMatchReport } from '@/db/types';
import type { FuelBurst } from '@/scoring';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');

/** The latest migration file that (re)defines validate_match_report_payload. */
function latestValidatorSql(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (/create\s+or\s+replace\s+function\s+public\.validate_match_report_payload/i.test(sql)) {
      found = { file, sql };
    }
  }
  if (!found) throw new Error('no migration defines validate_match_report_payload');
  return found;
}

/**
 * Extract the set of accepted burst `window` literals from the validator. Both
 * fuel_bursts and feeding_bursts are checked with `b->>'window' not in ( ... )`.
 * We collect the union across all such clauses so the test reflects exactly what
 * the deployed validator permits.
 */
function acceptedBurstWindows(sql: string): Set<string> {
  const windows = new Set<string>();
  const clause = /b->>'window'\s+not\s+in\s*\(([^)]*)\)/gis;
  let match: RegExpExecArray | null;
  while ((match = clause.exec(sql)) !== null) {
    for (const lit of match[1].matchAll(/'([^']+)'/g)) windows.add(lit[1]);
  }
  return windows;
}

/** True iff the validator accepts a JSON null for inactive_first. */
function acceptsInactiveFirstNull(sql: string): boolean {
  // The relaxed validator gates inactive_first with e.g.
  //   jsonb_typeof(p->'inactive_first') not in ('boolean', 'null')
  const clause = sql.match(
    /inactive_first'\s*\)\s*not\s+in\s*\(([^)]*)\)/is,
  );
  if (!clause) return false;
  return /'null'/i.test(clause[1]);
}

function baseReport(overrides: Partial<LocalMatchReport> = {}): LocalMatchReport {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    schemaVersion: 2,
    appVersion: 'test',
    deviceId: 'device-1',
    createdAt: new Date(0).toISOString(),
    eventKey: '2026casnv',
    matchKey: '2026casnv_qm1',
    scoutId: '22222222-2222-4222-8222-222222222222',
    scoutName: 'Contract Test',
    targetTeamNumber: 3256,
    allianceColor: 'red',
    station: 1,
    inactiveFirst: false,
    inactiveFirstSource: 'scout',
    teleopClockUnconfirmed: false,
    fuelBursts: [],
    feedingBursts: [],
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
    autoLeftStartingLine: false,
    autoClimbLevel1: false,
    intakeSources: [],
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
    fedCorral: false,
    notes: '',
    syncState: 'dirty',
    rowRevision: 1,
    syncAttempts: 0,
    lastSyncError: null,
    ...overrides,
  };
}

// A burst tagged with the AUTO window — exactly the shape windowForBurst() emits
// for balls captured during auto / the pre-GO pause. This is the shape that was
// being terminal-rejected for feeding_bursts before the fix.
const autoBurst: FuelBurst = { startMs: 0, endMs: 5000, rate: 1, window: 'auto' };

describe('upsert_match_report client wire-shape contract (pure)', () => {
  const { file, sql } = latestValidatorSql();
  const accepted = acceptedBurstWindows(sql);

  it(`derives the accepted burst window set from ${file}`, () => {
    // Sanity: the parse found a real, non-trivial set (guards a silent regex miss
    // that would make the assertions below vacuously pass).
    expect(accepted.size).toBeGreaterThan(3);
    expect(accepted.has('auto')).toBe(true);
  });

  it('emits fuel_bursts whose window the server validator accepts', () => {
    const payload = toUpsertPayload(
      baseReport({
        fuelBursts: [
          { startMs: 0, endMs: 10000, rate: 1, window: 'auto' },
          { startMs: 0, endMs: 5000, rate: 2, window: 'transition' },
          { startMs: 20000, endMs: 30000, rate: 1, window: 'shift1' },
          { startMs: 130000, endMs: 140000, rate: 1, window: 'endgame' },
        ],
      }),
    );
    const bursts = payload.fuel_bursts as FuelBurst[];
    expect(bursts.length).toBe(4);
    for (const b of bursts) {
      expect(typeof b.rate).toBe('number');
      expect(typeof b.startMs).toBe('number');
      expect(typeof b.endMs).toBe('number');
      expect(accepted.has(b.window)).toBe(true);
    }
  });

  it('emits feeding_bursts with the AUTO window the server must accept (regression)', () => {
    // This is the exact shape that dead-lettered ("feeding burst is malformed").
    const payload = toUpsertPayload(baseReport({ feedingBursts: [autoBurst] }));
    const bursts = payload.feeding_bursts as FuelBurst[];
    expect(bursts.length).toBe(1);
    expect(bursts[0].window).toBe('auto');
    // The server validator must accept every window the client can emit here.
    expect(
      accepted.has('auto'),
      `feeding_bursts emit window 'auto' but ${file} rejects it — client<->server contract drift`,
    ).toBe(true);
  });

  it('serializes inactive_first as boolean OR json null — never a string/undefined', () => {
    const asFalse = toUpsertPayload(baseReport({ inactiveFirst: false }));
    const asTrue = toUpsertPayload(baseReport({ inactiveFirst: true }));
    const asNull = toUpsertPayload(baseReport({ inactiveFirst: null }));
    expect(typeof asFalse.inactive_first).toBe('boolean');
    expect(typeof asTrue.inactive_first).toBe('boolean');
    expect(asNull.inactive_first).toBeNull();
    // A `null` in JS serializes to a JSON null (present key), which the relaxed
    // validator requires — NOT `undefined` (which would drop the key) or a string.
    expect(JSON.parse(JSON.stringify(asNull)).inactive_first).toBeNull();
  });

  it('server validator accepts the tri-state inactive_first null the client emits (regression)', () => {
    // This is the exact contract the shipped bug violated: the client emits a
    // JSON null for an unresolved inactive-first shift, and the server must accept
    // it (the column is nullable and the recompute coalesces null -> false).
    const payload = toUpsertPayload(baseReport({ inactiveFirst: null }));
    expect(payload.inactive_first).toBeNull();
    expect(
      acceptsInactiveFirstNull(sql),
      `client emits inactive_first: null but ${file} only accepts a boolean — client<->server contract drift`,
    ).toBe(true);
  });
});
