// tests/db/data_audit_hardening.test.ts
//
// The `explicit_browser_data_api_grants` migration reduced `service_role` to a
// narrow allowlist (SELECT on event/event_secret, SELECT+INSERT+UPDATE on
// match), so the classic direct `admin.from(...).insert()` fixture seeding no
// longer works. The event/team/match fixture is now created through the
// `promote_event_import` definer RPC (never activated), scout rows through the
// anon `select_scouter` RPC, and everything is torn down through `delete_event`
// (see ./seedHelpers). Verification reads that previously used `service_role`
// (pit_scouting_report, pit_assignment, strategy_canvas, match_scouting_report)
// now use the anon client, since those tables are browser-readable (grant +
// open read policy) but carry no `service_role` grant. `service_role` retains
// SELECT on `event`, so is_active authority reads stay on `admin`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminClient,
  anonClient,
  provisionScouts,
  seedEvent,
  dropEvent,
  uniqueEventKey,
} from './seedHelpers';

const EVENT = uniqueEventKey('hard');
const MATCH = `${EVENT}_qm1`;
const TEAMS = [9701, 9702, 9703];

let admin: SupabaseClient;
let publicClient: SupabaseClient;
let memberClient: SupabaseClient;
let scoutA = '';
let scoutB = '';

beforeAll(async () => {
  admin = adminClient();
  publicClient = anonClient();

  await seedEvent(admin, {
    eventKey: EVENT,
    name: 'Data audit hardening test',
    teams: TEAMS.map((team_number) => ({
      team_number,
      nickname: `Hardening ${team_number}`,
    })),
    matches: [
      {
        match_key: MATCH,
        match_number: 1,
        red1: TEAMS[0],
        red2: TEAMS[1],
        blue1: TEAMS[2],
      },
    ],
  });

  const provisioned = await provisionScouts(EVENT, ['Hardening A', 'Hardening B']);
  memberClient = provisioned.client;
  scoutA = provisioned.scouts['Hardening A'];
  scoutB = provisioned.scouts['Hardening B'];
}, 90_000);

afterAll(async () => {
  if (admin) await dropEvent(admin, EVENT);
  await memberClient?.auth.signOut();
});

describe('active-event authority', () => {
  it('rejects a missing target without changing the current active event', async () => {
    const before = await admin
      .from('event')
      .select('event_key')
      .eq('is_active', true)
      .maybeSingle();
    const result = await publicClient.rpc('set_active_event', {
      p_event_key: `${EVENT}_missing`,
    });
    expect(result.error?.code).toBe('23503');
    const after = await admin
      .from('event')
      .select('event_key')
      .eq('is_active', true)
      .maybeSingle();
    expect(after.data).toEqual(before.data);
  });

  it('denies broad direct public updates while preserving reads', async () => {
    const read = await publicClient.from('event').select('event_key').eq('event_key', EVENT);
    expect(read.error).toBeNull();
    expect(read.data).toHaveLength(1);
    const direct = await publicClient
      .from('event')
      .update({ is_active: true })
      .eq('event_key', EVENT);
    expect(direct.error).not.toBeNull();
  });

  // REFRAMED: the original test forced a `23505` unique-index violation by
  // directly setting a SECOND event `is_active = true` as `service_role`, then
  // toggled the global active-event singleton back. Both moves are no longer
  // valid: the least-privilege grants revoked direct UPDATE on `event` from
  // every Data API role (anon AND service_role), and this shared-project harness
  // must never toggle the live `is_active` singleton. So the single-active
  // invariant is no longer reachable through any granted client path — the only
  // granted mutator is the `set_active_event` RPC, which moves the singleton
  // atomically and can never transiently create two active rows. The
  // `event_single_active_idx` partial unique index remains in the schema as the
  // server-side guard for that RPC's internal two-statement update. What we can
  // still assert is the reachable contract: NO Data API role can flip
  // `is_active` directly, so a client can never create a second active event.
  it('makes is_active unwritable directly by every Data API role (single-active is RPC-only)', async () => {
    const anonDirect = await publicClient
      .from('event')
      .update({ is_active: true })
      .eq('event_key', EVENT);
    expect(anonDirect.error, 'anon must not write is_active directly').not.toBeNull();

    // service_role keeps SELECT on event but no UPDATE grant, so even the
    // backend role cannot manufacture a second active row via the table API.
    const serviceDirect = await admin
      .from('event')
      .update({ is_active: true })
      .eq('event_key', EVENT);
    expect(serviceDirect.error, 'service_role must not write is_active directly').not.toBeNull();

    // The event is still readable (open dashboard RLS) and was never activated.
    const still = await admin
      .from('event')
      .select('is_active')
      .eq('event_key', EVENT)
      .single();
    expect(still.error).toBeNull();
    expect(still.data?.is_active).toBe(false);
  });
});

describe('rolling pit clients and first-write races', () => {
  it('preserves omitted photos and clears only an explicit empty manifest', async () => {
    const photo = { id: 'one', path: `${EVENT}/one.jpg`, order: 0 };
    const first = await publicClient.rpc('upsert_pit_report', {
      p: {
        event_key: EVENT,
        team_number: TEAMS[0],
        drivetrain: 'swerve',
        photos: [photo],
        row_revision: 100,
      },
    });
    expect(first.error).toBeNull();

    const legacyUpdate = await publicClient.rpc('upsert_pit_report', {
      p: {
        event_key: EVENT,
        team_number: TEAMS[0],
        drivetrain: 'tank',
        photo_path: null,
        row_revision: 101,
      },
    });
    expect(legacyUpdate.error).toBeNull();
    const preserved = await publicClient
      .from('pit_scouting_report')
      .select('photos,photo_path')
      .eq('event_key', EVENT)
      .eq('team_number', TEAMS[0])
      .single();
    expect(preserved.data?.photos).toEqual([photo]);
    expect(preserved.data?.photo_path).toBe(photo.path);

    const clear = await publicClient.rpc('upsert_pit_report', {
      p: {
        event_key: EVENT,
        team_number: TEAMS[0],
        drivetrain: 'tank',
        photos: [],
        row_revision: 102,
      },
    });
    expect(clear.error).toBeNull();
    const cleared = await publicClient
      .from('pit_scouting_report')
      .select('photos,photo_path')
      .eq('event_key', EVENT)
      .eq('team_number', TEAMS[0])
      .single();
    expect(cleared.data).toMatchObject({ photos: [], photo_path: null });
  });

  it('serializes concurrent first pit-report inserts', async () => {
    const [a, b] = await Promise.all([
      publicClient.rpc('upsert_pit_report', {
        p: { event_key: EVENT, team_number: TEAMS[1], notes: 'older', row_revision: 200 },
      }),
      publicClient.rpc('upsert_pit_report', {
        p: { event_key: EVENT, team_number: TEAMS[1], notes: 'newer', row_revision: 201 },
      }),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const row = await publicClient
      .from('pit_scouting_report')
      .select('notes,row_revision')
      .eq('event_key', EVENT)
      .eq('team_number', TEAMS[1])
      .single();
    expect(row.data).toMatchObject({ notes: 'newer', row_revision: 201 });
  });

  it('serializes complete pit-assignment replacements per event', async () => {
    const [a, b] = await Promise.all([
      publicClient.rpc('set_pit_assignments', {
        p_event_key: EVENT,
        p_assignments: [{ team_number: TEAMS[0], scout_id: scoutA, source: 'manual' }],
        p_base_revision: null,
      }),
      publicClient.rpc('set_pit_assignments', {
        p_event_key: EVENT,
        p_assignments: [{ team_number: TEAMS[1], scout_id: scoutB, source: 'manual' }],
        p_base_revision: null,
      }),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const rows = await publicClient
      .from('pit_assignment')
      .select('team_number,scout_id')
      .eq('event_key', EVENT);
    expect(rows.data).toHaveLength(1);
    expect(rows.data?.[0]).toEqual(
      expect.objectContaining(
        rows.data?.[0].team_number === TEAMS[0]
          ? { team_number: TEAMS[0], scout_id: scoutA }
          : { team_number: TEAMS[1], scout_id: scoutB },
      ),
    );
  });
});

describe('strategy and rating compatibility', () => {
  it('merges concurrent first canvas writes instead of raising a PK race', async () => {
    const stroke = (id: string, seq: number) => ({
      id,
      seq,
      color: '#fff',
      size: 2,
      points: [[0.1, 0.1, 0.5]],
    });
    const [a, b] = await Promise.all([
      publicClient.rpc('upsert_strategy_canvas', {
        p: {
          event_key: EVENT,
          match_key: MATCH,
          phase: 'auto',
          strokes: [stroke('a', 1)],
          deleted_ids: [],
          robots: [],
          row_revision: 1,
        },
      }),
      publicClient.rpc('upsert_strategy_canvas', {
        p: {
          event_key: EVENT,
          match_key: MATCH,
          phase: 'auto',
          strokes: [stroke('b', 2)],
          deleted_ids: [],
          robots: [],
          row_revision: 2,
        },
      }),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const canvas = await publicClient
      .from('strategy_canvas')
      .select('strokes')
      .eq('event_key', EVENT)
      .eq('match_key', MATCH)
      .eq('phase', 'auto')
      .single();
    expect((canvas.data?.strokes as Array<{ id: string }>).map((item) => item.id).sort())
      .toEqual(['a', 'b']);
  });

  it('maps schema-v1 ordinals but preserves schema-v2 literal ratings', async () => {
    const oldId = crypto.randomUUID();
    const newId = crypto.randomUUID();
    const base = {
      event_key: EVENT,
      match_key: MATCH,
      scout_id: scoutA,
      target_team_number: TEAMS[0],
      alliance_color: 'red',
      station: 1,
      inactive_first: false,
      fuel_bursts: [],
      row_revision: 1,
    };
    const old = await publicClient.rpc('upsert_match_report', {
      p: {
        ...base,
        id: oldId,
        schema_version: 1,
        defense_rating: 1,
        driver_skill: 2,
        agility: 3,
      },
    });
    expect(old.error).toBeNull();
    const modern = await publicClient.rpc('upsert_match_report', {
      p: {
        ...base,
        id: newId,
        schema_version: 2,
        defense_rating: 1,
        driver_skill: 2,
        agility: 3,
        row_revision: 2,
      },
    });
    expect(modern.error).toBeNull();
    const rows = await publicClient
      .from('match_scouting_report')
      .select('id,defense_rating,driver_skill,agility')
      .in('id', [oldId, newId]);
    expect(rows.data?.find((row) => row.id === oldId)).toMatchObject({
      defense_rating: 3,
      driver_skill: 7,
      agility: 10,
    });
    expect(rows.data?.find((row) => row.id === newId)).toMatchObject({
      defense_rating: 1,
      driver_skill: 2,
      agility: 3,
    });
  });
});
