// tests/db/admin.test.ts
//
// Assignment / pit-assignment control-plane RPCs under the login-less,
// shared-trust model. Rewritten for the least-privilege Data API surface
// introduced by `explicit_browser_data_api_grants`:
//
//   * Fixtures (two events, their rosters, and the qm schedule) are seeded
//     through the `promote_event_import` definer RPC — direct
//     `admin.from('event'|'team'|'event_team'|'match'|'scout').insert()` is no
//     longer granted to service_role. Scout rows are minted through the anon
//     `select_scouter` RPC. Teardown is `delete_event`. (See ./seedHelpers.)
//   * Verification reads of `assignment` / `pit_assignment` use the anon client:
//     both are browser-readable (grant + open read policy) and service_role no
//     longer has any grant on them.
//
// Two REFRAMED areas target intentionally-removed capabilities, NOT stale bugs:
//   * The old `is_staff` / `is_admin` describe block asserted these role helpers
//     return true/false. This is a deliberately login-less, role-gate-free app
//     (see AGENTS.md), and the grants migration REVOKED EXECUTE on both from
//     anon+authenticated. We now assert they are no longer client-callable.
//   * The old "staff read policies" block created an admin auth user to prove a
//     role-scoped SELECT path. There are no role gates; reads are open. We keep
//     the open-dashboard read assertion and drop the staff machinery.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminClient,
  anonClient,
  provisionScouts,
  selectScoutsWith,
  seedEvent,
  dropEvent,
  uniqueEventKey,
} from './seedHelpers';

const EVENT_KEY = uniqueEventKey('dbt');
const OTHER_EVENT = uniqueEventKey('dbo');
const M1 = `${EVENT_KEY}_qm1`;
const M2 = `${EVENT_KEY}_qm2`;
const OTHER_MATCH = `${OTHER_EVENT}_qm1`;

const EVENT_TEAMS = [100, 101, 102, 110, 111, 112, 200, 201, 202, 210, 211, 212];
const OTHER_TEAMS = [1, 2, 3, 4, 5, 6];

let adminScoutId = '';
let secondScoutId = '';
let otherScoutId = '';
let admin: SupabaseClient;
let publicClient: SupabaseClient; // role `anon`, no session
let memberClient: SupabaseClient; // authenticated event member (from select_scouter)

beforeAll(async () => {
  admin = adminClient();
  publicClient = anonClient();

  // Two events with rosters + schedule via the import definer RPC (never active).
  await seedEvent(admin, {
    eventKey: EVENT_KEY,
    name: 'DB Test',
    teams: EVENT_TEAMS.map((team_number) => ({ team_number })),
    matches: [
      {
        match_key: M1, match_number: 1,
        red1: 100, red2: 101, red3: 102, blue1: 200, blue2: 201, blue3: 202,
      },
      {
        match_key: M2, match_number: 2,
        red1: 110, red2: 111, red3: 112, blue1: 210, blue2: 211, blue3: 212,
      },
    ],
  });
  await seedEvent(admin, {
    eventKey: OTHER_EVENT,
    name: 'DB Other',
    teams: OTHER_TEAMS.map((team_number) => ({ team_number })),
    matches: [
      {
        match_key: OTHER_MATCH, match_number: 1,
        red1: 1, red2: 2, red3: 3, blue1: 4, blue2: 5, blue3: 6,
      },
    ],
  });

  // Real event-member scout rows (one anon sign-in for the whole batch).
  const provisioned = await provisionScouts(EVENT_KEY, ['Scouter', 'Pit Partner']);
  memberClient = provisioned.client;
  adminScoutId = provisioned.scouts['Scouter'];
  secondScoutId = provisioned.scouts['Pit Partner'];
  const otherScouts = await selectScoutsWith(provisioned.client, OTHER_EVENT, [
    'Other Event Scout',
  ]);
  otherScoutId = otherScouts['Other Event Scout'];
}, 120_000);

afterAll(async () => {
  if (admin) {
    await dropEvent(admin, EVENT_KEY);
    await dropEvent(admin, OTHER_EVENT);
  }
  await memberClient?.auth.signOut();
});

describe('role helpers removed from the client surface', () => {
  // Intentional model (AGENTS.md): login-less, no staff/admin/role gates. The
  // grants migration revoked EXECUTE on is_staff/is_admin from anon+authenticated,
  // so neither an anon session nor a signed-in member can call them.
  it('is_staff / is_admin are no longer executable by any browser role', async () => {
    for (const fn of ['is_staff', 'is_admin']) {
      const anonRes = await publicClient.rpc(fn);
      expect(anonRes.error?.code, `${fn} must be revoked for anon`).toBe('42501');
      const memberRes = await memberClient.rpc(fn);
      expect(memberRes.error?.code, `${fn} must be revoked for authenticated`).toBe('42501');
    }
  });
});

describe('open dashboard reads (no role gate)', () => {
  it('lets any anon session read event and match rows', async () => {
    const ev = await publicClient.from('event').select('event_key').eq('event_key', EVENT_KEY);
    expect(ev.error).toBeNull();
    expect(ev.data?.length).toBe(1);
    const m = await publicClient.from('match').select('match_key').eq('event_key', EVENT_KEY);
    expect(m.error).toBeNull();
    expect(m.data?.length).toBe(2);
  });
});

describe('set_assignments RPC', () => {
  it('atomically rejects malformed/cross-event rows and accepts a valid batch', async () => {
    const malformed = await publicClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [{
        match_key: M1,
        scout_id: null,
        alliance_color: 'red',
        station: 2,
        target_team_number: 101,
      }],
      p_base_revision: null,
    });
    expect(malformed.error?.code).toBe('22023');

    const crossEvent = await publicClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [{
        match_key: OTHER_MATCH,
        scout_id: adminScoutId,
        alliance_color: 'red',
        station: 3,
        target_team_number: 3,
      }],
      p_base_revision: null,
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
    const res = await publicClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: payload,
      p_base_revision: null,
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ status: 'applied', count: 2 });

    const rows = await publicClient
      .from('assignment')
      .select('match_key, source')
      .eq('event_key', EVENT_KEY);
    expect(rows.error).toBeNull();
    expect(rows.data?.length).toBe(2);
    expect(rows.data?.every((r) => r.source === 'auto')).toBe(true);
  });

  it('replaces prior assignments on re-publish', async () => {
    const res = await publicClient.rpc('set_assignments', {
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
      p_base_revision: null,
    });
    expect(res.error).toBeNull();
    expect(res.data?.count).toBe(1);
    const rows = await publicClient.from('assignment').select('match_key').eq('event_key', EVENT_KEY);
    expect(rows.data?.length).toBe(1);
  });

  // Login-less lead view: set_assignments has no role gate, so ANY caller (a
  // scouter-less anon session) succeeds. Empty payload => 0 rows inserted.
  it('allows a scouter-less anon caller now that the lead view is open', async () => {
    const res = await publicClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [],
      p_base_revision: null,
    });
    expect(res.error).toBeNull();
    expect(res.data?.count).toBe(0);
  });

  it('an empty publish deletes only the addressed event', async () => {
    const seeded = await publicClient.rpc('set_assignments', {
      p_event_key: OTHER_EVENT,
      p_assignments: [{
        match_key: OTHER_MATCH,
        scout_id: otherScoutId,
        alliance_color: 'red',
        station: 1,
        target_team_number: 1,
      }],
      p_base_revision: null,
    });
    expect(seeded.error).toBeNull();
    expect(seeded.data?.count).toBe(1);

    const cleared = await publicClient.rpc('set_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [],
      p_base_revision: null,
    });
    expect(cleared.error).toBeNull();

    const untouched = await publicClient
      .from('assignment')
      .select('match_key')
      .eq('event_key', OTHER_EVENT);
    expect(untouched.data).toEqual([{ match_key: OTHER_MATCH }]);
  });
});

describe('set_pit_assignments RPC', () => {
  it('rejects duplicate or cross-event memberships before replacing the batch', async () => {
    const duplicate = await publicClient.rpc('set_pit_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [
        { team_number: 100, scout_id: adminScoutId, source: 'auto' },
        { team_number: 100, scout_id: adminScoutId, source: 'manual' },
      ],
      p_base_revision: null,
    });
    expect(duplicate.error?.code).toBe('22023');

    const crossEvent = await publicClient.rpc('set_pit_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [
        { team_number: 1, scout_id: adminScoutId, source: 'auto' },
      ],
      p_base_revision: null,
    });
    expect(crossEvent.error?.code).toBe('23503');

    const res = await publicClient.rpc('set_pit_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [
        { team_number: 100, scout_id: adminScoutId, source: 'manual' },
        { team_number: 100, scout_id: secondScoutId, source: 'auto' },
      ],
      p_base_revision: null,
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ status: 'applied', count: 2 });

    const rows = await publicClient
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
    const res = await publicClient.rpc('set_pit_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [{ team_number: 101, scout_id: adminScoutId, source: 'manual' }],
      p_base_revision: null,
    });
    expect(res.error).toBeNull();
    expect(res.data?.count).toBe(1);
    const rows = await publicClient
      .from('pit_assignment')
      .select('team_number')
      .eq('event_key', EVENT_KEY);
    expect(rows.data).toEqual([{ team_number: 101 }]);
  });

  it('an empty pit publish deletes only the addressed event', async () => {
    const seeded = await publicClient.rpc('set_pit_assignments', {
      p_event_key: OTHER_EVENT,
      p_assignments: [{ team_number: 1, scout_id: otherScoutId, source: 'manual' }],
      p_base_revision: null,
    });
    expect(seeded.error).toBeNull();
    expect(seeded.data?.count).toBe(1);

    const cleared = await publicClient.rpc('set_pit_assignments', {
      p_event_key: EVENT_KEY,
      p_assignments: [],
      p_base_revision: null,
    });
    expect(cleared.error).toBeNull();

    const untouched = await publicClient
      .from('pit_assignment')
      .select('team_number,scout_id')
      .eq('event_key', OTHER_EVENT);
    expect(untouched.data).toEqual([{ team_number: 1, scout_id: otherScoutId }]);
  });
});
