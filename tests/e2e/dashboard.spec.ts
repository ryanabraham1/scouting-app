// tests/e2e/dashboard.spec.ts
// Staff dashboard: an admin (admin >= lead) opens /dashboard, the next-match
// preview renders a confidence-weighted prediction (resilient to a live
// Statbotics outage), and a picklist entry persists to the shared server table.
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD;

const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let eventKey = '2026casnv';

test.beforeAll(async () => {
  const { data } = await admin
    .from('event')
    .select('event_key')
    .eq('is_active', true)
    .maybeSingle();
  eventKey = (data?.event_key as string) ?? '2026casnv';
  await admin.from('picklist').delete().eq('event_key', eventKey);
});
test.afterAll(async () => {
  await admin.from('picklist').delete().eq('event_key', eventKey);
});

test('lead sees a next-match prediction and builds a persisted picklist', async ({ page }) => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set TEST_ADMIN_EMAIL/PASSWORD in .env.local.');

  // Log in as admin (admin >= lead, so /dashboard's RequireRole lead admits).
  await page.goto('/login');
  await page.getByTestId('admin-email').fill(ADMIN_EMAIL as string);
  await page.getByTestId('admin-password').fill(ADMIN_PASSWORD as string);
  await page.getByTestId('admin-login-submit').click();
  await expect(page).toHaveURL(/\/admin$/, { timeout: 15_000 });

  // Open the dashboard.
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('dash-tab-next')).toBeVisible();

  // Next-match preview renders a confidence-weighted prediction. This must hold
  // whether or not Statbotics is reachable (the proxy degrades to unavailable).
  await page.getByTestId('dash-tab-next').click();
  await expect(page.getByTestId('dash-next')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('dash-next-red-score')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('dash-next-red-winprob')).toBeVisible();

  // Picklist: add a team, save, and confirm it persisted to the server table.
  await page.getByTestId('dash-tab-picklist').click();
  await expect(page.getByTestId('dash-picklist')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('pick-add-input').fill('254');
  await page.getByTestId('pick-add').click();
  await expect(page.getByTestId('pick-row-254')).toBeVisible();
  await page.getByTestId('pick-save').click();
  await expect(page.getByTestId('pick-saved')).toBeVisible({ timeout: 10_000 });

  const { data, error } = await admin
    .from('picklist')
    .select('entries')
    .eq('event_key', eventKey)
    .maybeSingle();
  expect(error).toBeNull();
  const entries = (data?.entries ?? []) as { teamNumber: number }[];
  expect(entries.some((e) => e.teamNumber === 254)).toBe(true);
});
