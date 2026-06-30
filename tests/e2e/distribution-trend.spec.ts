// tests/e2e/distribution-trend.spec.ts
// Distribution (variance) + recent-form trend: the dashboard surfaces per-team
// std-dev / floor-ceiling spread and a last-3-matches form trend in both the
// Ranking compare panel (Fuel σ / Recent Form rows) and the Team tab's
// Distribution card. Purely client-side display over data already read into the
// dashboard — no network dependency, degrades to "—" with sparse data.
//
// Live-data tolerant: no hard-coded team numbers/values. Recommended local run
// path is the deterministic demo event (toggle demo mode in Setup, which seeds
// 2026demo with full multi-match data) so Recent Form shows a real trend; the
// regex assertions still pass on "—" when live data is sparse.
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { setActiveEvent } from './helpers';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;

const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const eventKey = '2026casnv';

test.beforeAll(async () => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (open RLS) to run the login-less dashboard flows.');
});

test('distribution + recent-form surface in Team and Ranking', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  // Set active immediately before navigating (shared flag — avoid cross-spec races).
  await setActiveEvent(admin, eventKey);

  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });

  // --- Ranking tab FIRST: it lists only SCOUTED teams; pick one with data. ---
  await page.getByRole('tab', { name: 'Ranking' }).click();
  await expect(page.getByTestId('dash-ranking')).toBeVisible({ timeout: 15_000 });
  // First scouted team's number (ranking-team-{n} text == the team number).
  const firstRankedTeam = (
    await page.locator('[data-testid^="ranking-team-"]').first().textContent()
  )?.trim();
  expect(firstRankedTeam, 'event has at least one scouted team').toBeTruthy();

  // Select the first two compare checkboxes (sufficient to render the panel).
  const checks = page.locator('[data-testid^="cmp-"]');
  await checks.nth(0).check();
  await checks.nth(1).check();
  const panel = page.getByTestId('compare-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Fuel σ');
  await expect(panel).toContainText('Recent Form');
  // The Fuel σ row must contain a digit so a regression that NaNs/zeroes-out σ
  // for every team is caught. Scope to the row (a <tr> whose first <td> is the
  // label). σ renders "0" even at n=1, which still contains a digit.
  const fuelSigmaRow = panel.locator('tr', { hasText: 'Fuel σ' });
  await expect(fuelSigmaRow).toContainText(/\d/);

  // --- Team tab: select the SCOUTED team we found, so TeamDetail mounts. ---
  await page.getByRole('tab', { name: 'Team' }).click();
  const select = page.getByTestId('team-select');
  await expect(select).toBeVisible({ timeout: 15_000 });
  await select.selectOption(firstRankedTeam!);

  // Distribution card renders with mean ± σ and a range hint.
  await expect(page.getByTestId('team-distribution')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('team-dist-fuel')).toContainText('±');
  await expect(page.getByTestId('team-recent-form')).toBeVisible();
  // Recent form is one of the four allowed states.
  await expect(page.getByTestId('team-recent-form')).toContainText(
    /Improving|Fading|Stable|—/,
  );
});
