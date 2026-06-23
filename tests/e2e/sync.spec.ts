// tests/e2e/sync.spec.ts
// Online outbox round-trip: a joined scout captures a match, and the report is
// uploaded via the revision-guarded `upsert_match_report` RPC — the queue drains
// to zero and exactly one row lands on the server, with no duplicate on re-sync.
// The FK chain (event/match/team/scout) is seeded by global-setup.
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { E2E_EVENT_KEY, E2E_MATCH_KEY, E2E_TEAM } from './global-setup';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;
const JOIN_CODE = process.env.E2E_JOIN_CODE;

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

test.beforeAll(clearReports);
test.afterAll(clearReports);

test('captured report syncs to the server on reconnect with no duplicate', async ({ page }) => {
  test.skip(!JOIN_CODE, 'Set E2E_JOIN_CODE in .env.local to run the live sync flow.');

  // --- Join, then capture a match against the seeded match/team. ---
  await page.goto('/join');
  await page.getByTestId('join-code').fill(JOIN_CODE as string);
  await page.getByTestId('join-name').fill('E2E Sync Scout');
  await page.getByTestId('join-submit').click();

  await expect(page).toHaveURL(/\/scout$/, { timeout: 15_000 });
  await expect(page.getByTestId('scout-home')).toBeVisible();

  await page.locator('#mp-event').fill(E2E_EVENT_KEY);
  await page.locator('#mp-match').fill(E2E_MATCH_KEY);
  await page.locator('#mp-team').fill(String(E2E_TEAM));
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
