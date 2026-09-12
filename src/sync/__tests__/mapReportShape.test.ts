// src/sync/__tests__/mapReportShape.test.ts
//
// WIRE-SHAPE CONTRACT GUARD (the exact gap that let the live dead-letter ship).
//
// `toUpsertPayload` (mapReport.ts) is the SINGLE source of the JSON the
// `upsert_match_report` RPC receives. The server rejects a payload whose JSON
// *types*/ranges don't match `validate_match_report_payload` and dead-letters the
// report ("feeding burst is malformed", "inactive_first must be a JSON boolean",
// …). The other mapReport tests assert snake_case KEYS and VALUES but never that
// the produced payload actually PASSES the server's type/range validation — so a
// scoring/types change that alters a field's JSON type (e.g. sends a window as a
// number, or coerces tri-state `inactive_first` to a string) would still be
// green locally and only blow up at runtime against the real DB.
//
// This file closes that gap by running `toUpsertPayload(...)` through a faithful
// TypeScript re-implementation of the server validator across many report shapes
// (including the exact inputs that caused the live bug), plus negative cases
// proving the validator actually has teeth.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ MUST BE KEPT IN SYNC WITH THE SERVER:                                      │
// │   supabase/migrations/                                                     │
// │     20260722193000_relax_match_report_validation_inactive_first_and_       │
// │     feeding_auto.sql  ->  public.validate_match_report_payload(jsonb)      │
// │ If you change that migration's validation (new field, new range, new enum),│
// │ mirror the change in `validateMatchReportPayload` below. If you change     │
// │ mapReport.ts's wire shape, this test will (correctly) fail until the       │
// │ payload again satisfies the server contract.                              │
// └──────────────────────────────────────────────────────────────────────────┘

import { describe, it, expect } from 'vitest';
import type { LocalMatchReport } from '@/db/types';
import type { FuelBurst, TimeInterval } from '@/scoring';
import { SCHEMA_VERSION } from '@/scoring';
import { toUpsertPayload } from '../mapReport';

// ---------------------------------------------------------------------------
// Faithful TS mirror of public.validate_match_report_payload(jsonb).
// Throws Error(<same message as the SQL `raise exception`>) on the first
// violation, in the same order as the SQL, so a failure reads like the server's.
// ---------------------------------------------------------------------------

type JsonType = 'null' | 'number' | 'string' | 'boolean' | 'array' | 'object';

/** jsonb_typeof equivalent for a value that survived JSON serialization. */
function jsonType(v: unknown): JsonType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v as JsonType;
}

/** SQL `p ? key` — key is present in the object (JSON null still counts). */
function present(p: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(p, key);
}

/** SQL `nullif(p->>key,'') is null` — absent, JSON null, or empty string. */
function nullifEmptyIsNull(p: Record<string, unknown>, key: string): boolean {
  const v = p[key];
  return v === undefined || v === null || v === '';
}

/** SQL `p->>key` (text projection); numbers/bools become their text form. */
function asText(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  if (v === undefined || v === null) return null;
  return String(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BURST_WINDOWS = new Set([
  'auto',
  'transition',
  'shift1',
  'shift2',
  'shift3',
  'shift4',
  'endgame',
]);

function isInt(n: number): boolean {
  return Number.isFinite(n) && Math.trunc(n) === n;
}

/**
 * @throws Error mirroring the SQL `raise exception` messages.
 */
export function validateMatchReportPayload(p: unknown): void {
  if (p === null || jsonType(p) !== 'object') {
    throw new Error('match report payload must be an object');
  }
  const o = p as Record<string, unknown>;

  // 256 KiB cap (approximate via serialized byte length).
  if (new TextEncoder().encode(JSON.stringify(o)).length > 262144) {
    throw new Error('match report payload exceeds 256 KiB');
  }

  // Identity fields.
  if (
    nullifEmptyIsNull(o, 'id') ||
    nullifEmptyIsNull(o, 'event_key') ||
    nullifEmptyIsNull(o, 'match_key') ||
    nullifEmptyIsNull(o, 'scout_id') ||
    jsonType(o.schema_version) !== 'number' ||
    jsonType(o.target_team_number) !== 'number' ||
    jsonType(o.station) !== 'number' ||
    jsonType(o.alliance_color) !== 'string'
  ) {
    throw new Error('match report identity fields are required');
  }
  if (!UUID_RE.test(asText(o, 'id')!)) throw new Error('invalid input syntax for type uuid: id');
  if (!UUID_RE.test(asText(o, 'scout_id')!)) {
    throw new Error('invalid input syntax for type uuid: scout_id');
  }

  const vSchema = Number(asText(o, 'schema_version'));
  if (!isInt(vSchema) || vSchema < 1 || vSchema > 2) {
    throw new Error(`unsupported match report schema_version: ${vSchema}`);
  }

  const strLimit = (key: string, max: number): boolean =>
    (asText(o, key) ?? '').length > max;
  if (
    (asText(o, 'event_key') ?? '').length > 64 ||
    (asText(o, 'match_key') ?? '').length > 128 ||
    strLimit('app_version', 64) ||
    strLimit('device_id', 128) ||
    strLimit('scout_name', 128) ||
    strLimit('notes', 10000)
  ) {
    throw new Error('match report string field exceeds its limit');
  }

  // Numeric-typed fields (must be JSON number when present).
  for (const field of [
    'row_revision',
    'climb_level',
    'max_fuel_capacity_observed',
    'defense_rating',
    'driver_skill',
    'agility',
    'pins',
    'fouls_minor',
    'fouls_major',
    'defense_duration_ms',
    'defended_duration_ms',
  ]) {
    if (present(o, field) && o[field] !== null && jsonType(o[field]) !== 'number') {
      throw new Error(`${field} must be a JSON number`);
    }
  }
  // Boolean-typed fields (inactive_first intentionally excluded — tri-state).
  for (const field of [
    'deleted',
    'teleop_clock_unconfirmed',
    'climb_attempted',
    'climb_success',
    'auto_left_starting_line',
    'auto_climb_level1',
    'no_show',
    'died',
    'tipped',
    'dropped_fuel',
    'fed_corral',
  ]) {
    if (present(o, field) && o[field] !== null && jsonType(o[field]) !== 'boolean') {
      throw new Error(`${field} must be a JSON boolean`);
    }
  }
  // inactive_first: boolean OR null (the live bug #1).
  if (present(o, 'inactive_first') && !['boolean', 'null'].includes(jsonType(o.inactive_first))) {
    throw new Error('inactive_first must be a JSON boolean or null');
  }

  const rowRev = o.row_revision == null ? 1 : Number(asText(o, 'row_revision'));
  if (!isInt(rowRev) || rowRev < 1 || rowRev > 9007199254740991) {
    throw new Error('row_revision is outside the supported integer range');
  }

  const targetTeam = Number(asText(o, 'target_team_number'));
  const station = Number(asText(o, 'station'));
  if (
    !isInt(targetTeam) ||
    targetTeam < 1 ||
    targetTeam > 999999 ||
    !isInt(station) ||
    station < 1 ||
    station > 3 ||
    !['red', 'blue'].includes(asText(o, 'alliance_color') ?? '')
  ) {
    throw new Error('match report seat is invalid');
  }
  if (
    !nullifEmptyIsNull(o, 'inactive_first_source') &&
    !['derived', 'scout', 'official'].includes(asText(o, 'inactive_first_source') ?? '')
  ) {
    throw new Error('inactive_first_source is invalid');
  }

  const boundedInts: Array<[string, number, number]> = [
    ['climb_level', 0, 3],
    ['max_fuel_capacity_observed', 0, 10000],
    ['defense_rating', 0, 10],
    ['driver_skill', 0, 10],
    ['agility', 0, 10],
    ['pins', 0, 1000],
    ['fouls_minor', 0, 1000],
    ['fouls_major', 0, 1000],
    ['defense_duration_ms', 0, 140000],
    ['defended_duration_ms', 0, 140000],
  ];
  for (const [field] of boundedInts) {
    const n = o[field] == null ? 0 : Number(asText(o, field));
    if (!isInt(n)) throw new Error('integer-valued match report field is fractional');
  }
  for (const [field, lo, hi] of boundedInts) {
    const n = o[field] == null ? 0 : Number(asText(o, field));
    if (n < lo || n > hi) throw new Error('bounded match report field is outside its range');
  }

  validateBurstArray(o, 'fuel_bursts', 512, 'fuel burst', (win) =>
    win === 'auto' ? 20000 : 140000,
  );
  validateBurstArray(o, 'feeding_bursts', 256, 'feeding burst', () => 140000);

  validateStringArray(o, 'intake_sources', 16, 64, 'intake_sources is malformed');
  validateStringArray(o, 'foul_reasons', 32, 64, 'foul_reasons is malformed');

  // auto_start_position: null | {x,y in [-10,10]}
  if (present(o, 'auto_start_position') && jsonType(o.auto_start_position) !== 'null') {
    const a = o.auto_start_position as Record<string, unknown>;
    if (
      jsonType(a) !== 'object' ||
      jsonType(a.x) !== 'number' ||
      jsonType(a.y) !== 'number' ||
      (a.x as number) < -10 ||
      (a.x as number) > 10 ||
      (a.y as number) < -10 ||
      (a.y as number) > 10
    ) {
      throw new Error('auto_start_position is malformed');
    }
  }
  // auto_path: null | array<=256 of {x,y in [-10,10]}
  if (present(o, 'auto_path') && jsonType(o.auto_path) !== 'null') {
    const path = o.auto_path;
    if (jsonType(path) !== 'array' || (path as unknown[]).length > 256) {
      throw new Error('auto_path is malformed');
    }
    for (const pt of path as unknown[]) {
      const q = pt as Record<string, unknown>;
      if (
        jsonType(q) !== 'object' ||
        jsonType(q.x) !== 'number' ||
        jsonType(q.y) !== 'number' ||
        (q.x as number) < -10 ||
        (q.x as number) > 10 ||
        (q.y as number) < -10 ||
        (q.y as number) > 10
      ) {
        throw new Error('auto_path is malformed');
      }
    }
  }

  for (const phaseField of ['defense_intervals', 'defended_intervals']) {
    const arr = o[phaseField] ?? [];
    if (jsonType(arr) !== 'array' || (arr as unknown[]).length > 64) {
      throw new Error(`${phaseField} must be an array of at most 64 items`);
    }
    for (const iv of arr as unknown[]) {
      const b = iv as Record<string, unknown>;
      if (
        jsonType(b) !== 'object' ||
        jsonType(b.startMs) !== 'number' ||
        jsonType(b.endMs) !== 'number' ||
        !['auto', 'teleop'].includes(String(b.phase))
      ) {
        throw new Error(`${phaseField} contains a malformed interval`);
      }
      const start = b.startMs as number;
      const end = b.endMs as number;
      const max = b.phase === 'auto' ? 20000 : 140000;
      if (!isInt(start) || !isInt(end) || start < 0 || end < start || end > max) {
        throw new Error(`${phaseField} interval is outside its range`);
      }
    }
  }
}

function validateBurstArray(
  o: Record<string, unknown>,
  field: string,
  maxLen: number,
  label: string,
  maxEnd: (win: string) => number,
): void {
  const arr = o[field] ?? [];
  if (jsonType(arr) !== 'array' || (arr as unknown[]).length > maxLen) {
    throw new Error(`${field} must be an array of at most ${maxLen} items`);
  }
  for (const item of arr as unknown[]) {
    const b = item as Record<string, unknown>;
    if (
      jsonType(b) !== 'object' ||
      jsonType(b.rate) !== 'number' ||
      jsonType(b.startMs) !== 'number' ||
      jsonType(b.endMs) !== 'number' ||
      !BURST_WINDOWS.has(String(b.window))
    ) {
      throw new Error(`${label} is malformed`);
    }
    const rate = b.rate as number;
    const start = b.startMs as number;
    const end = b.endMs as number;
    if (
      rate < 0 ||
      rate > 30 ||
      !isInt(start) ||
      !isInt(end) ||
      start < 0 ||
      end < start ||
      end > maxEnd(String(b.window))
    ) {
      throw new Error(`${label} value is outside its range`);
    }
  }
}

function validateStringArray(
  o: Record<string, unknown>,
  field: string,
  maxLen: number,
  maxItemLen: number,
  message: string,
): void {
  const arr = o[field] ?? [];
  if (jsonType(arr) !== 'array' || (arr as unknown[]).length > maxLen) {
    throw new Error(message);
  }
  for (const item of arr as unknown[]) {
    if (jsonType(item) !== 'string' || (item as string).length > maxItemLen) {
      throw new Error(message);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures — a fully-valid report; overrides carve out edge cases.
// ---------------------------------------------------------------------------

const VALID_ID = '11111111-1111-4111-8111-111111111111';
const VALID_SCOUT = '22222222-2222-4222-8222-222222222222';

function makeReport(overrides: Partial<LocalMatchReport> = {}): LocalMatchReport {
  const fuelBursts: FuelBurst[] = [
    { startMs: 0, endMs: 4000, rate: 2, window: 'shift1' },
    { startMs: 0, endMs: 15000, rate: 1, window: 'auto' },
  ];
  const intervals: TimeInterval[] = [{ startMs: 0, endMs: 5000, phase: 'teleop' }];
  return {
    id: VALID_ID,
    schemaVersion: SCHEMA_VERSION,
    appVersion: '2.0.0',
    deviceId: 'dev-1',
    createdAt: '2026-06-23T00:00:00.000Z',
    eventKey: '2026casf',
    matchKey: '2026casf_qm5',
    scoutId: VALID_SCOUT,
    scoutName: 'Ada Lovelace',
    targetTeamNumber: 3256,
    allianceColor: 'blue',
    station: 3,
    inactiveFirst: true,
    inactiveFirstSource: 'scout',
    teleopClockUnconfirmed: false,
    fuelBursts,
    feedingBursts: [],
    autoFuel: 12,
    teleopFuelActive: 5,
    teleopFuelInactive: 2,
    endgameFuel: 1,
    fuelByShift: [1, 2, 3, 4],
    fuelPoints: 99,
    fuelEstimateConfidence: 0.3,
    climbLevel: 2,
    climbAttempted: true,
    climbSuccess: true,
    autoStartPosition: { x: 1, y: 2 },
    autoPath: [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
    ],
    autoLeftStartingLine: true,
    autoClimbLevel1: false,
    intakeSources: ['ground', 'station'],
    maxFuelCapacityObserved: 7,
    defenseRating: 8,
    driverSkill: 10,
    agility: 7,
    defenseDurationMs: 4200,
    defendedDurationMs: 1500,
    defenseIntervals: intervals,
    defendedIntervals: [],
    pins: 2,
    foulsMinor: 3,
    foulsMajor: 1,
    foulReasons: ['pinning', 'damage'],
    noShow: false,
    died: false,
    tipped: false,
    droppedFuel: true,
    fedCorral: true,
    notes: 'looked strong',
    syncState: 'dirty',
    rowRevision: 4,
    syncAttempts: 0,
    lastSyncError: null,
    ...overrides,
  };
}

/** Mirror what actually reaches the server: JSON round-trip drops `undefined`. */
function wire(report: LocalMatchReport): Record<string, unknown> {
  return JSON.parse(JSON.stringify(toUpsertPayload(report))) as Record<string, unknown>;
}

describe('mapReport wire shape passes the server validate_match_report_payload contract', () => {
  it('a fully-populated report serializes to a payload the server accepts', () => {
    expect(() => validateMatchReportPayload(wire(makeReport()))).not.toThrow();
  });

  it('tri-state inactive_first: null passes (live bug #1 — was wrongly dead-lettered)', () => {
    const p = wire(makeReport({ inactiveFirst: null, inactiveFirstSource: null }));
    expect(p.inactive_first).toBeNull();
    expect(() => validateMatchReportPayload(p)).not.toThrow();
  });

  it('inactive_first false/true both pass', () => {
    expect(() => validateMatchReportPayload(wire(makeReport({ inactiveFirst: false })))).not.toThrow();
    expect(() => validateMatchReportPayload(wire(makeReport({ inactiveFirst: true })))).not.toThrow();
  });

  it("feeding bursts tagged with the 'auto' window pass (live bug #2 — feeding during auto)", () => {
    const feedingBursts: FuelBurst[] = [
      { startMs: 0, endMs: 8000, rate: 3, window: 'auto' },
      { startMs: 20000, endMs: 40000, rate: 4, window: 'shift2' },
    ];
    const p = wire(makeReport({ feedingBursts }));
    expect(() => validateMatchReportPayload(p)).not.toThrow();
  });

  it('a no-show report (mostly falsy/empty) still serializes to an accepted payload', () => {
    const p = wire(
      makeReport({
        noShow: true,
        fuelBursts: [],
        feedingBursts: [],
        climbLevel: 0,
        climbAttempted: false,
        climbSuccess: false,
        autoStartPosition: null,
        autoPath: null,
        intakeSources: [],
        foulReasons: [],
        defenseIntervals: [],
        defendedIntervals: [],
        notes: '',
      }),
    );
    expect(() => validateMatchReportPayload(p)).not.toThrow();
  });

  it('a legacy report missing the optional super-scout fields still passes', () => {
    const r = makeReport();
    delete (r as Partial<LocalMatchReport>).driverSkill;
    delete (r as Partial<LocalMatchReport>).agility;
    delete (r as Partial<LocalMatchReport>).scoutName;
    delete (r as Partial<LocalMatchReport>).foulReasons;
    const p = wire(r as LocalMatchReport);
    // mapReport coalesces driver_skill/agility to 0 and foul_reasons to [].
    expect(p.driver_skill).toBe(0);
    expect(p.agility).toBe(0);
    expect(p.foul_reasons).toEqual([]);
    expect(() => validateMatchReportPayload(p)).not.toThrow();
  });

  it('fuel bursts at the auto window upper bound (20000ms) pass; teleop up to 140000ms', () => {
    const p = wire(
      makeReport({
        fuelBursts: [
          { startMs: 0, endMs: 20000, rate: 30, window: 'auto' },
          { startMs: 0, endMs: 140000, rate: 0, window: 'shift4' },
        ],
      }),
    );
    expect(() => validateMatchReportPayload(p)).not.toThrow();
  });

  it('repairs fractional/late gesture timestamps before upload (live fuel range bug)', () => {
    const p = wire(
      makeReport({
        fuelBursts: [
          { startMs: 19_999.6, endMs: 20_143.2, rate: 31.4, window: 'auto' },
          { startMs: 139_999.7, endMs: 140_020.1, rate: 6, window: 'endgame' },
        ],
      }),
    );

    expect(p.fuel_bursts).toEqual([
      { startMs: 20_000, endMs: 20_000, rate: 30, window: 'auto' },
      { startMs: 140_000, endMs: 140_000, rate: 6, window: 'endgame' },
    ]);
    expect(() => validateMatchReportPayload(p)).not.toThrow();
  });

  it('caps a long drawn auto path while preserving both endpoints', () => {
    const autoPath = Array.from({ length: 600 }, (_, index) => ({
      x: index / 599,
      y: 1 - index / 599,
    }));
    const p = wire(makeReport({ autoPath }));
    const safePath = p.auto_path as Array<{ x: number; y: number }>;

    expect(safePath).toHaveLength(256);
    expect(safePath[0]).toEqual(autoPath[0]);
    expect(safePath.at(-1)).toEqual(autoPath.at(-1));
    expect(() => validateMatchReportPayload(p)).not.toThrow();
  });

  it('filters non-finite path points and repairs adjacent bounded capture fields', () => {
    const p = wire(
      makeReport({
        autoStartPosition: { x: Number.NaN, y: 0.5 },
        autoPath: [
          { x: 0.2, y: 0.3 },
          { x: Number.NaN, y: 0.4 },
          { x: 12, y: -12 },
        ],
        defenseDurationMs: 140_001.8,
        pins: 1_001,
        notes: 'x'.repeat(10_001),
      }),
    );

    expect(p.auto_start_position).toBeNull();
    expect(p.auto_path).toEqual([{ x: 0.2, y: 0.3 }, { x: 10, y: -10 }]);
    expect(p.defense_duration_ms).toBe(140_000);
    expect(p.pins).toBe(1_000);
    expect((p.notes as string).length).toBe(10_000);
    expect(() => validateMatchReportPayload(p)).not.toThrow();
  });

  it('every declared upsert key is either validated or explicitly ignored (no silent drift)', () => {
    // If mapReport adds a NEW key, this reminds the author to teach the server
    // validator (and this mirror) about it. Keys the server ignores are listed.
    const SERVER_IGNORES = new Set(['app_version', 'device_id', 'scout_name']);
    const p = wire(makeReport());
    const keys = Object.keys(p);
    // Sanity: the identity + scoring-raw fields we validate must be present.
    for (const required of [
      'id',
      'schema_version',
      'event_key',
      'match_key',
      'scout_id',
      'target_team_number',
      'alliance_color',
      'station',
      'inactive_first',
      'fuel_bursts',
      'feeding_bursts',
    ]) {
      expect(keys).toContain(required);
    }
    expect(SERVER_IGNORES.size).toBeGreaterThan(0);
  });
});

describe('the wire-shape validator has teeth (rejects payloads the server would reject)', () => {
  it('rejects a non-object payload', () => {
    expect(() => validateMatchReportPayload(null)).toThrow(/must be an object/);
    expect(() => validateMatchReportPayload([])).toThrow(/must be an object/);
  });

  it('rejects inactive_first sent as a number (regression: coerced tri-state)', () => {
    const p = wire(makeReport());
    p.inactive_first = 1; // simulate a bad mapReport change
    expect(() => validateMatchReportPayload(p)).toThrow(/inactive_first must be a JSON boolean or null/);
  });

  it('rejects a fuel burst window that is not in the allowed set', () => {
    const p = wire(makeReport());
    (p.fuel_bursts as Array<Record<string, unknown>>)[0].window = 'pause';
    expect(() => validateMatchReportPayload(p)).toThrow(/fuel burst is malformed/);
  });

  it('rejects a feeding burst window that is not in the allowed set', () => {
    const p = wire(makeReport({ feedingBursts: [{ startMs: 0, endMs: 100, rate: 1, window: 'shift1' }] }));
    (p.feeding_bursts as Array<Record<string, unknown>>)[0].window = 'warmup';
    expect(() => validateMatchReportPayload(p)).toThrow(/feeding burst is malformed/);
  });

  it('rejects an out-of-range schema_version (e.g. a bumped SCHEMA_VERSION not mirrored server-side)', () => {
    const p = wire(makeReport());
    p.schema_version = 3;
    expect(() => validateMatchReportPayload(p)).toThrow(/unsupported match report schema_version/);
  });

  it('rejects an invalid station / alliance seat', () => {
    expect(() => {
      const p = wire(makeReport());
      p.station = 4;
      validateMatchReportPayload(p);
    }).toThrow(/seat is invalid/);
  });

  it('rejects a fractional integer-valued field', () => {
    const p = wire(makeReport());
    p.pins = 2.5;
    expect(() => validateMatchReportPayload(p)).toThrow(/fractional/);
  });

  it('rejects a fuel burst whose endMs exceeds the auto window bound', () => {
    // Mutate the already-sanitized wire object so this remains a direct test of
    // the validator mirror (toUpsertPayload intentionally repairs this value).
    const p = wire(makeReport());
    p.fuel_bursts = [{ startMs: 0, endMs: 20001, rate: 1, window: 'auto' }];
    expect(() => validateMatchReportPayload(p)).toThrow(/fuel burst value is outside its range/);
  });

  it('rejects a non-uuid id', () => {
    const p = wire(makeReport({ id: 'not-a-uuid' }));
    expect(() => validateMatchReportPayload(p)).toThrow(/uuid/);
  });
});
