// tests/e2e/admin.spec.ts — admin login -> import-already-done -> auto-generate -> publish
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD;
const EVENT = '2026casnv';

const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Scout ids seeded for the active event so auto-generate has a pool.
const seededScoutIds: string[] = [];

test.beforeAll(async () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set TEST_ADMIN_EMAIL/PASSWORD in .env.local.');
  // Seed 3 scouts for the active event (2026casnv).
  for (let i = 1; i <= 3; i++) {
    const { data, error } = await admin
      .from('scout')
      .insert({ event_key: EVENT, display_name: `E2E Scout ${i}`, auth_uid: randomUUID() })
      .select('id')
      .single();
    if (error) throw error;
    seededScoutIds.push(data.id as string);
  }
});

test.afterAll(async () => {
  // FK-safe: assignments first, then the seeded scouts.
  await admin.from('assignment').delete().eq('event_key', EVENT);
  if (seededScoutIds.length) await admin.from('scout').delete().in('id', seededScoutIds);
});

test('admin logs in, auto-generates assignments, and publishes', async ({ page }) => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set TEST_ADMIN_EMAIL/PASSWORD in .env.local.');

  await page.goto('/login');
  await page.getByTestId('admin-email').fill(ADMIN_EMAIL as string);
  await page.getByTestId('admin-password').fill(ADMIN_PASSWORD as string);
  await page.getByTestId('admin-login-submit').click();

  // Lands on the admin page (RequireRole admin admits the logged-in admin).
  await expect(page).toHaveURL(/\/admin$/, { timeout: 15_000 });
  await expect(page.getByTestId('admin-page')).toBeVisible({ timeout: 15_000 });

  // Auto-generate the assignment grid (event 2026casnv is already imported + active).
  await page.getByTestId('auto-generate-btn').click();
  await expect(page.getByTestId('assignment-grid')).toBeVisible({ timeout: 15_000 });

  // Publish the assignments via the set_assignments RPC.
  await page.getByTestId('publish-assignments-btn').click();
  await expect(page.getByTestId('assignments-published')).toBeVisible({ timeout: 15_000 });

  // Confirm rows actually landed in the DB for this event.
  const { count, error } = await admin
    .from('assignment')
    .select('*', { count: 'exact', head: true })
    .eq('event_key', EVENT);
  expect(error).toBeNull();
  expect(count ?? 0).toBeGreaterThan(0);
});
