// tests/e2e/dashboard.spec.ts
// Staff dashboard: an admin (admin >= lead) opens /dashboard, the next-match
// preview renders a confidence-weighted prediction (resilient to a live
// Statbotics outage), and a picklist entry persists to the shared server table.
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ensureStrategyMatchup, setActiveEvent } from './helpers';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;

const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const eventKey = '2026casnv';

test.beforeAll(async () => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  // The open (no-login) dashboard depends on migration 0009 (open RLS + scouter_roster).
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (open RLS) to run the login-less dashboard flows.');
  await admin.from('picklist').delete().eq('event_key', eventKey);
});
test.afterAll(async () => {
  await admin.from('picklist').delete().eq('event_key', eventKey);
});

test('lead sees a next-match prediction and builds a persisted picklist (no login)', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  // Set active immediately before navigating (shared flag — avoid cross-spec races).
  await setActiveEvent(admin, eventKey);

  // Dashboard is open — no login gate.
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('tab', { name: 'Pit Display' })).toBeVisible();

  // The confidence-weighted prediction moved to the Strategy tab. This must hold
  // whether or not Statbotics is reachable (the proxy degrades to unavailable).
  await page.getByRole('tab', { name: 'Strategy' }).click();
  await expect(page.getByTestId('dash-strategy')).toBeVisible({ timeout: 25_000 });
  await ensureStrategyMatchup(page);
  await expect(page.getByTestId('dash-next-red-score')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('dash-next-red-winprob')).toBeVisible();

  // Picklist: add a team, save, and confirm it persisted to the server table.
  await page.getByRole('tab', { name: 'Picklist' }).click();
  await expect(page.getByTestId('dash-picklist')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('pick-add-input').fill('254');
  await page.getByTestId('pick-add').click();
  await expect(page.getByTestId('pick-row-254')).toBeVisible();
  // Picklist persistence is debounced autosave; there is no manual Save button.
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
