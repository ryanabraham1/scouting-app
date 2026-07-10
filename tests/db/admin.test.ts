// tests/db/admin.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL!;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;
const PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const rid = Math.random().toString(36).slice(2, 8);
const ADMIN_EMAIL = `db-admin-${rid}@example.com`;
const ADMIN_PASSWORD = `Pw-${rid}-Aa1!`;
const EVENT_KEY = `dbtest_${rid}`;
const M1 = `${EVENT_KEY}_qm1`;
const M2 = `${EVENT_KEY}_qm2`;
const OTHER_MATCH = `dbtest_other_${rid}_qm1`;

let adminUserId = '';
let adminScoutId = '';
let secondScoutId = '';
let otherScoutId = '';
let adminClient: SupabaseClient;
let anonClient: SupabaseClient;

async function adminApiCreateUser(email: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SECRET_KEY,
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`create user failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.id as string;
}

beforeAll(async () => {
  // 1. Seed admin auth user.
  adminUserId = await adminApiCreateUser(ADMIN_EMAIL, ADMIN_PASSWORD);

  // 2. Admins are NOT scouts: profile holds only (auth_uid, role). No scout_id column.
  const profIns = await admin.from('profile').insert({
    auth_uid: adminUserId,
    role: 'admin',
  });
  if (profIns.error) throw profIns.error;

  // 2b. Seed team rows referenced by match team slots and assignment target_team_number.
  const teamNums = [1, 2, 3, 4, 5, 6, 100, 101, 102, 110, 111, 112, 200, 201, 202, 210, 211, 212];
  const teamIns = await admin.from('team').upsert(
    teamNums.map((n) => ({ team_number: n, nickname: `Team ${n}` })),
    { onConflict: 'team_number', ignoreDuplicates: true }
  );
  if (teamIns.error) throw teamIns.error;

  // 3. Seed events (must exist before scout/match FKs).
  const evIns = await admin.from('event').insert({ event_key: EVENT_KEY, name: `DB Test ${rid}` });
  if (evIns.error) throw evIns.error;
  const ev2Ins = await admin
    .from('event')
    .insert({ event_key: `dbtest_other_${rid}`, name: `DB Other ${rid}` });
  if (ev2Ins.error) throw ev2Ins.error;

  const eventTeamIns = await admin.from('event_team').insert([
    ...[100, 101, 102, 110, 111, 112, 200, 201, 202, 210, 211, 212].map(
      (team_number) => ({ event_key: EVENT_KEY, team_number }),
    ),
    ...[1, 2, 3, 4, 5, 6].map((team_number) => ({
      event_key: `dbtest_other_${rid}`,
      team_number,
    })),
  ]);
  if (eventTeamIns.error) throw eventTeamIns.error;

  // 4. Seed a real scout (a scouter) to reference in assignments. scout PK is `id`;
  //    requires event_key + a UNIQUE auth_uid (use a random uuid, distinct from the admin).
  const scoutIns = await admin
    .from('scout')
    .insert({ event_key: EVENT_KEY, display_name: `Scouter ${rid}`, auth_uid: crypto.randomUUID() })
    .select('id')
    .single();
  if (scoutIns.error) throw scoutIns.error;
  adminScoutId = scoutIns.data.id;
  const secondScoutIns = await admin
    .from('scout')
    .insert({
      event_key: EVENT_KEY,
      display_name: `Pit Partner ${rid}`,
      auth_uid: crypto.randomUUID(),
    })
    .select('id')
    .single();
  if (secondScoutIns.error) throw secondScoutIns.error;
  secondScoutId = secondScoutIns.data.id;
  const otherScoutIns = await admin
    .from('scout')
    .insert({
      event_key: `dbtest_other_${rid}`,
      display_name: `Other Event Scout ${rid}`,
      auth_uid: crypto.randomUUID(),
    })
    .select('id')
    .single();
  if (otherScoutIns.error) throw otherScoutIns.error;
  otherScoutId = otherScoutIns.data.id;

  const mIns = await admin.from('match').insert([
    {
      match_key: M1,
      event_key: EVENT_KEY,
      comp_level: 'qm',
      match_number: 1,
      red1: 100, red2: 101, red3: 102, blue1: 200, blue2: 201, blue3: 202,
    },
    {
      match_key: M2,
      event_key: EVENT_KEY,
      comp_level: 'qm',
      match_number: 2,
      red1: 110, red2: 111, red3: 112, blue1: 210, blue2: 211, blue3: 212,
    },
    {
      match_key: OTHER_MATCH,
      event_key: `dbtest_other_${rid}`,
      comp_level: 'qm',
      match_number: 1,
      red1: 1, red2: 2, red3: 3, blue1: 4, blue2: 5, blue3: 6,
    },
  ]);
  if (mIns.error) throw mIns.error;

  // 4. Sign in the admin (password) to get a JWT-scoped client.
  adminClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signIn = await adminClient.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (signIn.error) throw signIn.error;

  // 5. A brand-new anon client (no session, no membership, no role).
  anonClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
});

afterAll(async () => {
  // FK-safe order: assignment -> match -> scout -> event -> profile -> auth user.
  await admin.from('assignment').delete().eq('event_key', EVENT_KEY);
  await admin.from('assignment').delete().eq('event_key', `dbtest_other_${rid}`);
  await admin.from('pit_assignment').delete().eq('event_key', EVENT_KEY);
  await admin.from('pit_assignment').delete().eq('event_key', `dbtest_other_${rid}`);
  await admin.from('match').delete().in('match_key', [M1, M2, OTHER_MATCH]);
  await admin.from('scout').delete().in('id', [adminScoutId, secondScoutId, otherScoutId]);
  await admin.from('event_team').delete().in('event_key', [EVENT_KEY, `dbtest_other_${rid}`]);
  await admin.from('event').delete().in('event_key', [EVENT_KEY, `dbtest_other_${rid}`]);
  await admin.from('profile').delete().eq('auth_uid', adminUserId);
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${adminUserId}`, {
    method: 'DELETE',
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
  });
});

describe('is_staff / is_admin helpers', () => {
  it('returns true for the seeded admin', async () => {
    const staff = await adminClient.rpc('is_staff');
    expect(staff.error).toBeNull();
    expect(staff.data).toBe(true);
    const adm = await adminClient.rpc('is_admin');
    expect(adm.error).toBeNull();
    expect(adm.data).toBe(true);
  });

  it('returns false for a no-session anon caller', async () => {
    const staff = await anonClient.rpc('is_staff');
    expect(staff.error).toBeNull();
    expect(staff.data).toBe(false);
    const adm = await anonClient.rpc('is_admin');
    expect(adm.error).toBeNull();
    expect(adm.data).toBe(false);
  });
});

describe('staff read policies', () => {
  it('lets a staff user SELECT event and match', async () => {
    const ev = await adminClient.from('event').select('event_key').eq('event_key', EVENT_KEY);
    expect(ev.error).toBeNull();
    expect(ev.data?.length).toBe(1);
    const m = await adminClient.from('match').select('match_key').eq('event_key', EVENT_KEY);
    expect(m.error).toBeNull();
    expect(m.data?.length).toBe(2);
  });

  // Auth was removed (2026-06-23 overhaul): migration 0009 added open SELECT so the
  // login-less lead/drive-coach dashboard (an anonymous session with no membership /
  // role) can read event data. Previously this returned 0 rows.
  it('lets a brand-new anon read events (open dashboard RLS)', async () => {
    const ev = await anonClient.from('event').select('event_key').eq('event_key', EVENT_KEY);
    expect(ev.error).toBeNull();
    expect(ev.data?.length).toBe(1);
  });
});

describe('set_assignments RPC', () => {
  it('atomically rejects malformed/cross-event rows and accepts a valid batch', async () => {
    const malformed = await adminClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [{
        match_key: M1,
        scout_id: null,
        alliance_color: 'red',
        station: 2,
        target_team_number: 101,
      }],
    });
    expect(malformed.error?.code).toBe('22023');

    const crossEvent = await adminClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [{
        match_key: OTHER_MATCH,
        scout_id: adminScoutId,
        alliance_color: 'red',
        station: 3,
        target_team_number: 3,
      }],
    });
    expect(crossEvent.error?.code).toBe('23503');

    const payload = [
      {
        match_key: M1,
        scout_id: adminScoutId,
        alliance_color: 'red',
        station: 1,
        target_team_number: 100,
      },
      {
        match_key: M2,
        scout_id: adminScoutId,
        alliance_color: 'blue',
        station: 2,
        target_team_number: 211,
      },
    ];
    const res = await adminClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: payload,
    });
    expect(res.error).toBeNull();
    expect(res.data).toBe(2);

    const rows = await admin
      .from('assignment')
      .select('match_key, source')
      .eq('event_key', EVENT_KEY);
    expect(rows.error).toBeNull();
    expect(rows.data?.length).toBe(2);
    expect(rows.data?.every((r) => r.source === 'auto')).toBe(true);
  });

  it('replaces prior assignments on re-publish', async () => {
    const res = await adminClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [
        {
          match_key: M1,
          scout_id: adminScoutId,
          alliance_color: 'red',
          station: 1,
          target_team_number: 100,
        },
      ],
    });
    expect(res.error).toBeNull();
    expect(res.data).toBe(1);
    const rows = await admin.from('assignment').select('match_key').eq('event_key', EVENT_KEY);
    expect(rows.data?.length).toBe(1);
  });

  // Auth was removed: migration 0009 dropped the admin gate on set_assignments so the
  // open lead view can publish. A non-admin (anon) caller now SUCCEEDS (empty payload
  // → 0 rows inserted) instead of being rejected with 42501.
  it('allows a non-admin caller now that the lead view is open', async () => {
    const res = await anonClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [],
    });
    expect(res.error).toBeNull();
    expect(res.data).toBe(0);
  });

  it('an empty publish deletes only the addressed event', async () => {
    const otherEvent = `dbtest_other_${rid}`;
    const seeded = await admin.from('assignment').insert({
      event_key: otherEvent,
      match_key: OTHER_MATCH,
      scout_id: otherScoutId,
      alliance_color: 'red',
      station: 1,
      target_team_number: 1,
      source: 'manual',
    });
    expect(seeded.error).toBeNull();

    const cleared = await anonClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [],
    });
    expect(cleared.error).toBeNull();

    const untouched = await admin
      .from('assignment')
      .select('match_key')
      .eq('event_key', otherEvent);
    expect(untouched.data).toEqual([{ match_key: OTHER_MATCH }]);
  });
});

describe('set_pit_assignments RPC', () => {
  it('rejects duplicate or cross-event memberships before replacing the batch', async () => {
    const duplicate = await anonClient.rpc('set_pit_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [
        { team_number: 100, scout_id: adminScoutId, source: 'auto' },
        { team_number: 100, scout_id: adminScoutId, source: 'manual' },
      ],
    });
    expect(duplicate.error?.code).toBe('22023');

    const crossEvent = await anonClient.rpc('set_pit_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [
        { team_number: 1, scout_id: adminScoutId, source: 'auto' },
      ],
    });
    expect(crossEvent.error?.code).toBe('23503');

    const res = await anonClient.rpc('set_pit_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [
        { team_number: 100, scout_id: adminScoutId, source: 'manual' },
        { team_number: 100, scout_id: secondScoutId, source: 'auto' },
      ],
    });
    expect(res.error).toBeNull();
    expect(res.data).toBe(2);

    const rows = await admin
      .from('pit_assignment')
      .select('team_number,scout_id,source')
      .eq('event_key', EVENT_KEY);
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(2);
    expect(rows.data).toEqual(expect.arrayContaining([
      { team_number: 100, scout_id: adminScoutId, source: 'manual' },
      { team_number: 100, scout_id: secondScoutId, source: 'auto' },
    ]));
  });

  it('atomically replaces prior pit assignments', async () => {
    const res = await anonClient.rpc('set_pit_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [{ team_number: 101, scout_id: adminScoutId, source: 'manual' }],
    });
    expect(res.error).toBeNull();
    expect(res.data).toBe(1);
    const rows = await admin
      .from('pit_assignment')
      .select('team_number')
      .eq('event_key', EVENT_KEY);
    expect(rows.data).toEqual([{ team_number: 101 }]);
  });

  it('an empty pit publish deletes only the addressed event', async () => {
    const otherEvent = `dbtest_other_${rid}`;
    const seeded = await admin.from('pit_assignment').insert({
      event_key: otherEvent,
      team_number: 1,
      scout_id: otherScoutId,
      source: 'manual',
    });
    expect(seeded.error).toBeNull();

    const cleared = await anonClient.rpc('set_pit_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [],
    });
    expect(cleared.error).toBeNull();

    const untouched = await admin
      .from('pit_assignment')
      .select('team_number,scout_id')
      .eq('event_key', otherEvent);
    expect(untouched.data).toEqual([{ team_number: 1, scout_id: otherScoutId }]);
  });
});
