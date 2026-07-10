import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const PUBLISHABLE = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const EVENT = `seed_guard_${Math.random().toString(36).slice(2, 9)}`;

let admin: SupabaseClient;
let accessToken = '';

beforeAll(async () => {
  expect(URL).toBeTruthy();
  expect(SECRET).toBeTruthy();
  expect(PUBLISHABLE).toBeTruthy();
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  const marker = await admin.from('event').insert({
    event_key: EVENT,
    name: 'Seed guard marker',
    is_active: false,
  });
  if (marker.error) throw marker.error;

  const authClient = createClient(URL, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await authClient.auth.signInAnonymously();
  if (signedIn.error || !signedIn.data.session) {
    throw signedIn.error ?? new Error('anonymous session missing');
  }
  accessToken = signedIn.data.session.access_token;
});

afterAll(async () => {
  if (admin) await admin.from('event').delete().eq('event_key', EVENT);
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
