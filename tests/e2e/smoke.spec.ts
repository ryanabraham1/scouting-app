// tests/e2e/smoke.spec.ts
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

const JOIN_CODE = process.env.E2E_JOIN_CODE;
const DISPLAY_NAME = process.env.E2E_DISPLAY_NAME ?? 'E2E Scout';

test('app loads and unauthenticated user lands on /join', async ({ page }) => {
  await page.goto('/');
  // Root redirects to a guarded route; unauthenticated -> /join.
  await expect(page).toHaveURL(/\/join$/, { timeout: 10_000 });
  await expect(page.getByTestId('join-submit')).toBeVisible();
  await expect(page.getByTestId('join-code')).toBeVisible();
  await expect(page.getByTestId('join-name')).toBeVisible();
});

test('join flow reaches /scout', async ({ page }) => {
  test.skip(!JOIN_CODE, 'Set E2E_JOIN_CODE in .env.local to run the live join flow.');

  await page.goto('/join');
  await page.getByTestId('join-code').fill(JOIN_CODE as string);
  await page.getByTestId('join-name').fill(DISPLAY_NAME);
  await page.getByTestId('join-submit').click();

  await expect(page).toHaveURL(/\/scout$/, { timeout: 15_000 });
  await expect(page.getByTestId('scout-screen')).toBeVisible();
});
