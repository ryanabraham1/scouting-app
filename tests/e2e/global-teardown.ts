// tests/e2e/global-teardown.ts
// Remove every scout that joined the seeded test event, then the event itself
// (which cascades event_secret). Leaves the live event (2026casnv) untouched.
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { E2E_EVENT_KEY } from './global-setup';

export default async function globalTeardown(): Promise<void> {
  loadEnv({ path: '.env.local' });
  const url = process.env.VITE_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) return;

  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // FK-safe order: scouts reference event(event_key) with no cascade.
  await admin.from('scout').delete().eq('event_key', E2E_EVENT_KEY);
  await admin.from('event').delete().eq('event_key', E2E_EVENT_KEY);
}
