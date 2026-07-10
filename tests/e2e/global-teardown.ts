// tests/e2e/global-teardown.ts
// Remove every scout that joined the seeded test event, then the event itself
// (which cascades event_secret). Leaves the live event (2026casnv) untouched.
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import {
  E2E_EVENT_KEY,
  E2E_RUN_ID,
  E2E_RUN_STATE_PATH,
  E2E_TEAMS,
} from './global-setup';
import {
  assertDedicatedRemoteTestProject,
  assertRunScopedEventKey,
} from '../remoteTestSafety';

export default async function globalTeardown(): Promise<void> {
  loadEnv({ path: '.env.local' });
  assertDedicatedRemoteTestProject();
  assertRunScopedEventKey(E2E_EVENT_KEY, E2E_RUN_ID);
  const url = process.env.VITE_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) return;

  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const state = JSON.parse(await readFile(E2E_RUN_STATE_PATH, 'utf8')) as {
    originalActiveEventKey: string | null;
  };
  if (state.originalActiveEventKey) {
    const restored = await admin.rpc('set_active_event', {
      p_event_key: state.originalActiveEventKey,
    });
    if (restored.error) {
      throw new Error(`restore active event failed: ${restored.error.message}`);
    }
  }

  const deleted = await admin.rpc('delete_event', { p_event_key: E2E_EVENT_KEY });
  if (deleted.error) throw new Error(`delete E2E event failed: ${deleted.error.message}`);
  await admin.from('team').delete().in('team_number', E2E_TEAMS);
}
