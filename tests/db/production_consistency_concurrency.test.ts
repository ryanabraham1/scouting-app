import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL ?? '';
const SECRET = process.env.SUPABASE_SECRET_KEY ?? '';
const PUBLISHABLE = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';
const LOCAL_ONLY = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/.test(URL);
const localDescribe = LOCAL_ONLY ? describe : describe.skip;
const RID = crypto.randomUUID().slice(0, 8);
const EVENT = `consistency_${RID}`;
const MATCH = `${EVENT}_qm1`;
const TEAM_BASE = 800_000 + Math.floor(Math.random() * 100_000);
const TEAMS = Array.from({ length: 6 }, (_, i) => TEAM_BASE + i);

let admin: SupabaseClient;
let publicClient: SupabaseClient;
let scoutA = '';
let scoutB = '';

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    schema_version: 2,
    app_version: 'concurrency-test',
    device_id: 'local-vitest',
    row_revision: 1,
    deleted: false,
    event_key: EVENT,
    match_key: MATCH,
    scout_id: scoutA,
    scout_name: `Concurrency A ${RID}`,
    target_team_number: TEAMS[0],
    alliance_color: 'red',
    station: 1,
    inactive_first: false,
    inactive_first_source: 'derived',
    fuel_bursts: [],
    feeding_bursts: [],
    climb_level: 0,
    climb_attempted: false,
    climb_success: false,
    auto_left_starting_line: false,
    auto_climb_level1: false,
    intake_sources: [],
    defense_rating: 0,
    driver_skill: 0,
    agility: 0,
    no_show: false,
    notes: '',
    defense_intervals: [],
    defended_intervals: [],
    ...overrides,
  };
}

localDescribe('production consistency concurrency (local Supabase only)', () => {
  beforeAll(async () => {
    expect(SECRET).toBeTruthy();
    expect(PUBLISHABLE).toBeTruthy();
    admin = createClient(URL, SECRET, { auth: { persistSession: false } });
    publicClient = createClient(URL, PUBLISHABLE, { auth: { persistSession: false } });

    const event = await admin.from('event').insert({
      event_key: EVENT,
      name: 'Concurrency test',
      is_active: false,
    });
    if (event.error) throw event.error;
    const teams = await admin.from('team').insert(
      TEAMS.map((team_number) => ({
        team_number,
        nickname: `Concurrency ${team_number}`,
      })),
    );
    if (teams.error) throw teams.error;
    const eventTeams = await admin.from('event_team').insert(
      TEAMS.map((team_number) => ({ event_key: EVENT, team_number })),
    );
    if (eventTeams.error) throw eventTeams.error;
    const match = await admin.from('match').insert({
      match_key: MATCH,
      event_key: EVENT,
      comp_level: 'qm',
      match_number: 1,
      red1: TEAMS[0],
      red2: TEAMS[1],
      red3: TEAMS[2],
      blue1: TEAMS[3],
      blue2: TEAMS[4],
      blue3: TEAMS[5],
    });
    if (match.error) throw match.error;
    const scouts = await admin
      .from('scout')
      .insert([
        {
          event_key: EVENT,
          display_name: `Concurrency A ${RID}`,
          auth_uid: crypto.randomUUID(),
        },
        {
          event_key: EVENT,
          display_name: `Concurrency B ${RID}`,
          auth_uid: crypto.randomUUID(),
        },
      ])
      .select('id');
    if (scouts.error) throw scouts.error;
    [scoutA, scoutB] = scouts.data.map((row) => row.id);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.rpc('delete_event', { p_event_key: EVENT });
    await admin.from('team').delete().in('team_number', TEAMS);
  });

  it('never regresses revision under concurrent updates', async () => {
    const id = crypto.randomUUID();
    const initial = await publicClient.rpc('upsert_match_report', {
      p: report({ id, row_revision: 1 }),
    });
    expect(initial.error).toBeNull();

    const [revision2, revision3] = await Promise.all([
      publicClient.rpc('upsert_match_report', {
        p: report({ id, row_revision: 2, notes: 'revision two' }),
      }),
      publicClient.rpc('upsert_match_report', {
        p: report({ id, row_revision: 3, notes: 'revision three' }),
      }),
    ]);
    expect(revision2.error).toBeNull();
    expect(revision3.error).toBeNull();
    expect(revision3.data.status).toBe('applied');
    expect(['applied', 'stale']).toContain(revision2.data.status);

    const stored = await admin
      .from('match_scouting_report')
      .select('row_revision, notes')
      .eq('id', id)
      .single();
    expect(stored.data).toEqual({ row_revision: 3, notes: 'revision three' });
  });

  it('distinguishes equal-revision idempotency from content conflict', async () => {
    const id = crypto.randomUUID();
    const payload = report({
      id,
      scout_id: scoutB,
      scout_name: `Concurrency B ${RID}`,
      target_team_number: TEAMS[1],
      station: 2,
      row_revision: 7,
      notes: 'canonical',
    });
    const first = await publicClient.rpc('upsert_match_report', { p: payload });
    const same = await publicClient.rpc('upsert_match_report', { p: payload });
    const changed = await publicClient.rpc('upsert_match_report', {
      p: { ...payload, notes: 'different' },
    });
    expect(first.data.status).toBe('applied');
    expect(same.data.status).toBe('idempotent');
    expect(changed.data.status).toBe('conflict');
    expect(changed.data.current_revision).toBe(7);
  });

  it('serializes concurrent first writes to the same active slot', async () => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const [first, second] = await Promise.all([
      publicClient.rpc('upsert_match_report', {
        p: report({ id: firstId, row_revision: 1 }),
      }),
      publicClient.rpc('upsert_match_report', {
        p: report({ id: secondId, row_revision: 1 }),
      }),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    const active = await admin
      .from('match_scouting_report')
      .select('id')
      .eq('match_key', MATCH)
      .eq('scout_id', scoutA)
      .eq('deleted', false);
    expect(active.error).toBeNull();
    expect(active.data).toHaveLength(1);
  });

  it('rejects malformed bursts without changing stored content', async () => {
    const id = crypto.randomUUID();
    const valid = report({
      id,
      scout_id: scoutB,
      scout_name: `Concurrency B ${RID}`,
      target_team_number: TEAMS[1],
      station: 2,
      row_revision: 20,
      notes: 'preserve',
    });
    expect((await publicClient.rpc('upsert_match_report', { p: valid })).error).toBeNull();
    const invalid = await publicClient.rpc('upsert_match_report', {
      p: {
        ...valid,
        row_revision: 21,
        fuel_bursts: [{ rate: -1, startMs: 0, endMs: 1000, window: 'auto' }],
      },
    });
    expect(invalid.error?.code).toBe('22023');
    const stored = await admin
      .from('match_scouting_report')
      .select('row_revision, notes')
      .eq('id', id)
      .single();
    expect(stored.data).toEqual({ row_revision: 20, notes: 'preserve' });
  });

  it('allows exactly one concurrent assignment CAS replacement', async () => {
    const firstRows = [
      { match_key: MATCH, scout_id: scoutA, team_number: TEAMS[0], station: 1 },
    ];
    const secondRows = [
      { match_key: MATCH, scout_id: scoutB, team_number: TEAMS[1], station: 2 },
    ];
    const [first, second] = await Promise.all([
      publicClient.rpc('set_assignments', {
        p_event_key: EVENT,
        p_assignments: firstRows,
        p_base_revision: 0,
      }),
      publicClient.rpc('set_assignments', {
        p_event_key: EVENT,
        p_assignments: secondRows,
        p_base_revision: 0,
      }),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect([first.data.status, second.data.status].sort()).toEqual([
      'applied',
      'conflict',
    ]);
    const stored = await admin.from('assignment').select('*').eq('match_key', MATCH);
    expect(stored.data).toHaveLength(1);
  });

  it('returns conflict for a different equal-revision pit report', async () => {
    const id = crypto.randomUUID();
    const payload = {
      id,
      event_key: EVENT,
      team_number: TEAMS[0],
      drivetrain: 'swerve',
      mechanisms: ['intake'],
      capabilities: { score: true },
      notes: 'first',
      author_scout_id: scoutA,
      row_revision: 5,
      deleted: false,
    };
    const first = await publicClient.rpc('upsert_pit_report', { p: payload });
    const same = await publicClient.rpc('upsert_pit_report', { p: payload });
    const changed = await publicClient.rpc('upsert_pit_report', {
      p: { ...payload, notes: 'different' },
    });
    expect(first.data.status).toBe('applied');
    expect(same.data.status).toBe('idempotent');
    expect(changed.data.status).toBe('conflict');
    expect(changed.data.current_revision).toBe(5);
  });
});
