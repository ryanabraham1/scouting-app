// tests/e2e/smoke.spec.ts
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

// Auth was removed: the root is a landing chooser (no login gate) that forks
// between scouting and the lead dashboard. From there a scout tap reaches the
// open scouter home shell (name picker or "no active event" message).
test('app loads on the landing chooser and Scout reaches /scout (no login)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('home-go-scout').click();
  await expect(page).toHaveURL(/\/scout$/, { timeout: 10_000 });
  await expect(page.getByTestId('scout-home')).toBeVisible({ timeout: 10_000 });
});

test('Lead Dashboard unlocks with the team code', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByTestId('lead-dashboard-lock')).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('Lead dashboard code').fill('12345');
  await page.getByRole('button', { name: 'Unlock dashboard' }).click();
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
});

test('/admin redirects into Lead Dashboard Settings', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/dashboard\?tab=settings$/, { timeout: 10_000 });
  await page.getByLabel('Lead dashboard code').fill('12345');
  await page.getByRole('button', { name: 'Unlock dashboard' }).click();
  await expect(page.getByTestId('setup-tab')).toBeVisible({ timeout: 10_000 });
});

test('Analysis is open and includes Alliance', async ({ page }) => {
  await page.goto('/analysis');
  await expect(page.getByTestId('analysis')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('tab', { name: 'Alliance' })).toBeVisible();
});
