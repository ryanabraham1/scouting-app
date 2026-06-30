// tests/e2e/defense-analytics.spec.ts
// Defense analytics surfaces: the Ranking tab gains two sortable defense columns
// ("Def ↓" / "Defender") and the Team tab gains two defense Stat cards. Defense
// data is sparse on the live event, so we assert PRESENCE + INTERACTION, not
// magnitudes. Self-contained: sets the global event.is_active singleton itself
// (the dashboard reads it) so the test never depends on a prior test's state.
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

test('defense analytics surface in Ranking and Team tabs', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, eventKey); // do NOT rely on a prior test's is_active
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('tab', { name: 'Ranking' }).click();
  await expect(page.getByTestId('dash-ranking')).toBeVisible({ timeout: 25_000 });

  // New sortable headers exist and are clickable (md+ viewport so sm: cells show).
  await page.setViewportSize({ width: 1280, height: 900 });
  const defSupp = page.getByTestId('sort-fuelSuppression');
  await expect(defSupp).toBeVisible();
  await defSupp.click(); // sort by suppression
  await expect(page.getByTestId('sort-defenderEffectiveness')).toBeVisible();

  // Open a team from the ranking; assert the two Stat cards render (value or —).
  const firstTeamBtn = page.locator('[data-testid^="ranking-team-"]').first();
  await firstTeamBtn.click();
  await expect(page.getByTestId('team-detail')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('team-defended-suppression')).toBeVisible();
  await expect(page.getByTestId('team-defender-effectiveness')).toBeVisible();

  // Compare panel shows the new rows when two teams are selected.
  await page.getByRole('tab', { name: 'Ranking' }).click();
  await expect(page.getByTestId('dash-ranking')).toBeVisible({ timeout: 25_000 });
  const boxes = page.locator('[data-testid^="cmp-"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const cmp = page.getByTestId('compare-panel');
  await expect(cmp).toContainText('Def ↓');
  await expect(cmp).toContainText('Defender');
});
