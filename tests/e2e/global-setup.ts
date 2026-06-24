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

// Roster names the live E2E flows pick from (auth was removed; scouters select a
// name instead of joining with a code).
export const E2E_ROSTER_NAMES = ['E2E Capture Scout', 'E2E Sync Scout'];

export default async function globalSetup(): Promise<void> {
  loadEnv({ path: '.env.local' });
  const url = process.env.VITE_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  // Live flows gate on url+secret (service key). Nothing to seed without them.
  if (!url || !secret) return;

  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Seed roster names for the login-less scouter onboarding. Tolerate a DB that
  // hasn't had migration 0009 applied yet (table absent) — the roster-dependent
  // specs skip themselves in that case.
  for (const name of E2E_ROSTER_NAMES) {
    // The unique index is on lower(name) (expression index), so on_conflict can't
    // target it — plain insert, ignore the duplicate (23505), like the app does.
    const r = await admin.from('scouter_roster').insert({ name });
    if (r.error && r.error.code !== '23505') {
      const missingTable = r.error.code === '42P01' || /scouter_roster/.test(r.error.message);
      if (!missingTable) throw new Error(`seed roster failed: ${r.error.message}`);
      break; // table not deployed; nothing to seed
    }
  }

  const ev = await admin
    .from('event')
    .upsert(
      { event_key: E2E_EVENT_KEY, name: 'E2E Test Event', is_active: false },
      { onConflict: 'event_key' },
    );
  if (ev.error) throw new Error(`seed event failed: ${ev.error.message}`);

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
