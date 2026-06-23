// tests/e2e/global-setup.ts
// Seed a dedicated, joinable test event so the live join + capture E2E flows
// have a stable join code. The event need not be active — join_event only
// resolves event_secret.join_code (see supabase/migrations/0004_rpcs.sql).
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

export const E2E_EVENT_KEY = '_e2etest';
// FK chain for the online-sync round-trip (sync.spec): a match + team the
// uploaded report can reference. Synthetic team number avoids colliding with
// real imported teams.
export const E2E_MATCH_KEY = '_e2etest_qm1';
export const E2E_TEAM = 9999;

export default async function globalSetup(): Promise<void> {
  loadEnv({ path: '.env.local' });
  const url = process.env.VITE_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const code = process.env.E2E_JOIN_CODE;
  // Tests that depend on the live join flow skip themselves when these are
  // unset; nothing to seed in that case.
  if (!url || !secret || !code) return;

  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const ev = await admin
    .from('event')
    .upsert(
      { event_key: E2E_EVENT_KEY, name: 'E2E Test Event', is_active: false },
      { onConflict: 'event_key' },
    );
  if (ev.error) throw new Error(`seed event failed: ${ev.error.message}`);

  const sec = await admin
    .from('event_secret')
    .upsert({ event_key: E2E_EVENT_KEY, join_code: code }, { onConflict: 'event_key' });
  if (sec.error) throw new Error(`seed event_secret failed: ${sec.error.message}`);

  const team = await admin
    .from('team')
    .upsert({ team_number: E2E_TEAM, nickname: 'E2E Test Team' }, { onConflict: 'team_number' });
  if (team.error) throw new Error(`seed team failed: ${team.error.message}`);

  const match = await admin
    .from('match')
    .upsert(
      { match_key: E2E_MATCH_KEY, event_key: E2E_EVENT_KEY, comp_level: 'qm', match_number: 1 },
      { onConflict: 'match_key' },
    );
  if (match.error) throw new Error(`seed match failed: ${match.error.message}`);
}
