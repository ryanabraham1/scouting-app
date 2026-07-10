// tests/e2e/global-setup.ts
// Seed a dedicated, joinable test event so the live join + capture E2E flows
// have a stable join code. The event need not be active — join_event only
// resolves event_secret.join_code (see supabase/migrations/0004_rpcs.sql).
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  assertDedicatedRemoteTestProject,
  assertRunScopedEventKey,
} from '../remoteTestSafety';

export const E2E_RUN_ID = (process.env.E2E_RUN_ID ?? 'local').replace(/[^a-zA-Z0-9_]/g, '_');
export const E2E_EVENT_KEY = `_e2etest_${E2E_RUN_ID}`;
// FK chain for the online-sync round-trip (sync.spec): a match + team the
// uploaded report can reference. Synthetic team number avoids colliding with
// real imported teams.
export const E2E_MATCH_KEY = `${E2E_EVENT_KEY}_qm1`;
const RUN_HASH = [...E2E_RUN_ID].reduce((sum, char) => (sum + char.charCodeAt(0)) % 9000, 0);
export const E2E_TEAM = 900000 + RUN_HASH;
export const E2E_TEAMS = Array.from({ length: 6 }, (_, index) => E2E_TEAM + index);
export const E2E_AUTH_STATE_PATH = 'test-results/e2e-auth-state.json';
export const E2E_RUN_STATE_PATH = 'test-results/e2e-run-state.json';

// Roster names the live E2E flows pick from (auth was removed; scouters select a
// name instead of joining with a code).
export const E2E_ROSTER_NAMES = ['E2E Capture Scout', 'E2E Sync Scout'];

export default async function globalSetup(): Promise<void> {
  loadEnv({ path: '.env.local' });
  assertDedicatedRemoteTestProject();
  assertRunScopedEventKey(E2E_EVENT_KEY, E2E_RUN_ID);
  const url = process.env.VITE_SUPABASE_URL;
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const authState: {
    cookies: never[];
    origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  } = { cookies: [], origins: [] };
  if (url && publishableKey) {
    const authClient = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await authClient.auth.signInAnonymously();
    if (error || !data.session) {
      throw new Error(`seed browser auth failed: ${error?.message ?? 'missing session'}`);
    }
    const projectRef = new URL(url).hostname.split('.')[0];
    authState.origins.push({
      origin: 'http://localhost:5173',
      localStorage: [
        {
          name: `sb-${projectRef}-auth-token`,
          value: JSON.stringify(data.session),
        },
      ],
    });
  }
  await mkdir('test-results', { recursive: true });
  await writeFile(E2E_AUTH_STATE_PATH, JSON.stringify(authState));
  // Live flows gate on url+secret (service key). Nothing to seed without them.
  if (!url || !secret) return;

  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const active = await admin
    .from('event')
    .select('event_key')
    .eq('is_active', true)
    .maybeSingle();
  if (active.error) throw new Error(`snapshot active event failed: ${active.error.message}`);
  await writeFile(
    E2E_RUN_STATE_PATH,
    JSON.stringify({ originalActiveEventKey: active.data?.event_key ?? null }),
  );

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
    .upsert(
      E2E_TEAMS.map((team_number, index) => ({
        team_number,
        nickname: `E2E Test Team ${index + 1}`,
      })),
      { onConflict: 'team_number' },
    );
  if (team.error) throw new Error(`seed team failed: ${team.error.message}`);

  const eventTeams = await admin.from('event_team').upsert(
    E2E_TEAMS.map((team_number) => ({ event_key: E2E_EVENT_KEY, team_number })),
    { onConflict: 'event_key,team_number' },
  );
  if (eventTeams.error) throw new Error(`seed event teams failed: ${eventTeams.error.message}`);

  const match = await admin
    .from('match')
    .upsert(
      {
        match_key: E2E_MATCH_KEY,
        event_key: E2E_EVENT_KEY,
        comp_level: 'qm',
        match_number: 1,
        red1: E2E_TEAMS[0],
        red2: E2E_TEAMS[1],
        red3: E2E_TEAMS[2],
        blue1: E2E_TEAMS[3],
        blue2: E2E_TEAMS[4],
        blue3: E2E_TEAMS[5],
      },
      { onConflict: 'match_key' },
    );
  if (match.error) throw new Error(`seed match failed: ${match.error.message}`);
}
