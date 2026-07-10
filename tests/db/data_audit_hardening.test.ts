import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const PUBLISHABLE = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const RID = Math.random().toString(36).slice(2, 9);
const EVENT = `hardening_${RID}`;
const MATCH = `${EVENT}_qm1`;
const TEAMS = [9701, 9702, 9703];

let admin: SupabaseClient;
let publicClient: SupabaseClient;
let scoutA = '';
let scoutB = '';

beforeAll(async () => {
  expect(URL).toBeTruthy();
  expect(SECRET).toBeTruthy();
  expect(PUBLISHABLE).toBeTruthy();
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  publicClient = createClient(URL, PUBLISHABLE, { auth: { persistSession: false } });

  const event = await admin.from('event').insert({
    event_key: EVENT,
    name: 'Data audit hardening test',
    is_active: false,
  });
  if (event.error) throw event.error;
  const teams = await admin.from('team').upsert(
    TEAMS.map((team_number) => ({ team_number, nickname: `Hardening ${team_number}` })),
    { onConflict: 'team_number' },
  );
  if (teams.error) throw teams.error;
  const joins = await admin.from('event_team').insert(
    TEAMS.map((team_number) => ({ event_key: EVENT, team_number })),
  );
  if (joins.error) throw joins.error;
  const match = await admin.from('match').insert({
    match_key: MATCH,
    event_key: EVENT,
    comp_level: 'qm',
    match_number: 1,
    red1: TEAMS[0],
    red2: TEAMS[1],
    blue1: TEAMS[2],
  });
  if (match.error) throw match.error;
  const scouts = await admin
    .from('scout')
    .insert([
      { event_key: EVENT, display_name: `Hardening A ${RID}`, auth_uid: crypto.randomUUID() },
      { event_key: EVENT, display_name: `Hardening B ${RID}`, auth_uid: crypto.randomUUID() },
    ])
    .select('id');
  if (scouts.error) throw scouts.error;
  [scoutA, scoutB] = scouts.data.map((row) => row.id);
});

afterAll(async () => {
  if (!admin) return;
  await admin.from('matchup_note_history').delete().eq('event_key', EVENT);
  await admin.from('pit_report_history').delete().eq('event_key', EVENT);
  await admin.from('event').delete().eq('event_key', EVENT);
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

  it('enforces the single-active partial unique index and restores authority', async () => {
    const original = await admin
      .from('event')
      .select('event_key')
      .eq('is_active', true)
      .maybeSingle();
    expect(original.error).toBeNull();
    if (!original.data) return;

    try {
      const selected = await admin.rpc('set_active_event', { p_event_key: EVENT });
      expect(selected.error).toBeNull();
      const second = await admin
        .from('event')
        .update({ is_active: true })
        .eq('event_key', original.data.event_key);
      expect(second.error?.code).toBe('23505');
    } finally {
      const restored = await admin.rpc('set_active_event', {
        p_event_key: original.data.event_key,
      });
      expect(restored.error).toBeNull();
    }
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
    const preserved = await admin
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
    const cleared = await admin
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
    const row = await admin
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
      }),
      publicClient.rpc('set_pit_assignments', {
        p_event_key: EVENT,
        p_assignments: [{ team_number: TEAMS[1], scout_id: scoutB, source: 'manual' }],
      }),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const rows = await admin
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
    const canvas = await admin
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
    const rows = await admin
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
