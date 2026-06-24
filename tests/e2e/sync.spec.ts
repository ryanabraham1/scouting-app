// tests/e2e/sync.spec.ts
// Online outbox round-trip: a joined scout captures a match, and the report is
// uploaded via the revision-guarded `upsert_match_report` RPC — the queue drains
// to zero and exactly one row lands on the server, with no duplicate on re-sync.
// The FK chain (event/match/team/scout) is seeded by global-setup.
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { E2E_EVENT_KEY, E2E_MATCH_KEY, E2E_TEAM } from './global-setup';
import { setActiveEvent, ensureRosterName, pickScouter } from './helpers';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;
const SCOUTER = 'E2E Sync Scout';

const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function reportCount(): Promise<number> {
  const { count, error } = await admin
    .from('match_scouting_report')
    .select('*', { count: 'exact', head: true })
    .eq('event_key', E2E_EVENT_KEY)
    .eq('match_key', E2E_MATCH_KEY)
    .eq('target_team_number', E2E_TEAM);
  if (error) throw error;
  return count ?? 0;
}

// Start from a clean slate even if a prior run left a row behind.
async function clearReports(): Promise<void> {
  await admin
    .from('match_scouting_report')
    .delete()
    .eq('event_key', E2E_EVENT_KEY)
    .eq('match_key', E2E_MATCH_KEY)
    .eq('target_team_number', E2E_TEAM);
}

test.beforeAll(async () => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  // Needs migration 0009 (scouter_roster + select_scouter) on the target DB.
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (scouter_roster/select_scouter) to run this flow.');
  await ensureRosterName(admin, SCOUTER);
  await clearReports();
});
test.afterAll(clearReports);

test('captured report syncs to the server on reconnect with no duplicate', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  // Set active immediately before picking (shared flag — avoid cross-spec races).
  await setActiveEvent(admin, E2E_EVENT_KEY);

  // --- Pick a name (no login), then capture against the seeded match/team. ---
  await pickScouter(page, SCOUTER);

  await page.locator('#mp-match').fill(E2E_MATCH_KEY);
  await page.locator('#mp-team').fill(String(E2E_TEAM));
  await expect(page.getByTestId('scout-start-capture')).toBeEnabled();
  await page.getByTestId('scout-start-capture').click();

  await page.getByTestId('capture-start').click();
  await page.getByTestId('capture-go').click();
  await page.getByTestId('capture-inactive-no').click();
  const hold = page.getByTestId('capture-hold');
  await hold.dispatchEvent('pointerdown');
  await hold.dispatchEvent('pointerup');

  await page.getByTestId('capture-to-review').click();
  await page.getByTestId('review-climb').getByRole('button', { name: '3', exact: true }).click();
  await page.getByTestId('review-save').click();

  // Back on the scout home, online: the outbox (auto-sync) drains the queue.
  await expect(page.getByTestId('scout-home')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sync-queued')).toHaveText('↑0', { timeout: 20_000 });
  await expect(page.getByTestId('sync-deadletters')).toHaveText('⚠0');

  // Exactly one row on the server.
  expect(await reportCount()).toBe(1);

  // Re-trigger a sync: the queue is empty and the synced report is not re-sent,
  // so still exactly one row (no duplicate / no regression). Server-side
  // idempotency on an actual re-send is covered by tests/functions/ingest-reports.test.ts.
  const syncNow = page.getByTestId('sync-now');
  await expect(syncNow).toBeEnabled();
  await syncNow.click();
  await expect(page.getByTestId('sync-queued')).toHaveText('↑0');
  expect(await reportCount()).toBe(1);
});
