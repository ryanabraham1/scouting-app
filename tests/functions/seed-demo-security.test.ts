// tests/functions/seed-demo-security.test.ts
//
// The `explicit_browser_data_api_grants` migration revoked `service_role`'s
// broad table privileges, so the marker event can no longer be seeded with a
// direct `admin.from('event').insert()`. It is now created through the
// `promote_event_import` definer RPC (never activated) and torn down through
// `delete_event`, exactly like the rest of the DB harness (see ../db/seedHelpers).
// The marker name is still read back with `service_role`, which retains SELECT
// on `event`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import {
  adminClient,
  anonClient,
  signInAnon,
  seedEvent,
  dropEvent,
  uniqueEventKey,
  URL,
  SECRET,
  ANON as PUBLISHABLE,
} from '../db/seedHelpers';
import type { SupabaseClient } from '@supabase/supabase-js';

config({ path: '.env.local' });

const EVENT = uniqueEventKey('seedguard');
const MARKER_NAME = 'Seed guard marker';

let admin: SupabaseClient;
let accessToken = '';

beforeAll(async () => {
  expect(URL).toBeTruthy();
  expect(SECRET).toBeTruthy();
  expect(PUBLISHABLE).toBeTruthy();
  admin = adminClient();
  await seedEvent(admin, {
    eventKey: EVENT,
    name: MARKER_NAME,
    teams: [{ team_number: 9990 }],
    matches: [],
  });

  const authClient = anonClient();
  await signInAnon(authClient);
  const { data } = await authClient.auth.getSession();
  if (!data.session) throw new Error('anonymous session missing');
  accessToken = data.session.access_token;
}, 90_000);

afterAll(async () => {
  if (admin) await dropEvent(admin, EVENT);
});

describe('seed-demo event-key guard', () => {
  it('rejects an arbitrary destination before delete or seed can touch it', async () => {
    const response = await fetch(`${URL}/functions/v1/seed-demo`, {
      method: 'POST',
      headers: {
        apikey: PUBLISHABLE,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_event_key: '2026casnv',
        demo_event_key: EVENT,
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'demo_event_key must be 2026demo',
    });

    const marker = await admin
      .from('event')
      .select('name')
      .eq('event_key', EVENT)
      .single();
    expect(marker.error).toBeNull();
    expect(marker.data?.name).toBe('Seed guard marker');
  });
});
