// tests/e2e/export-presets.spec.ts
// Export presets on the Picklist tab: with an active event + one picklisted team
// (254), the lead can export an Alliance Sheet (CSV), a Picklist Tool (CSV), and
// open a printable Alliance Selection sheet. Self-contained (own setActiveEvent +
// test.skip guards + migration-0009 probe) so it never depends on the ordering of
// other specs. Single-worker, live `2026casnv` (see playwright config).
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
  // The open (no-login) dashboard depends on migration 0009 (open RLS).
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (open RLS) to run the login-less dashboard flows.');
  await admin.from('picklist').delete().eq('event_key', eventKey);
});
test.afterAll(async () => {
  await admin.from('picklist').delete().eq('event_key', eventKey);
});

test('lead exports the alliance-selection presets from the picklist', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  // Register the print() no-op on the CONTEXT before opening the popup, so the
  // popup page inherits it at creation (addInitScript applies to pages opened
  // afterwards). Headless Chromium also treats w.print() as a no-op.
  await page.context().addInitScript(() => {
    window.print = () => {};
  });

  await setActiveEvent(admin, eventKey);

  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });

  // Picklist tab + one team so the presets have something to export.
  await page.getByRole('tab', { name: 'Picklist' }).click();
  await expect(page.getByTestId('dash-picklist')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('pick-add-input').fill('254');
  await page.getByTestId('pick-add').click();
  await expect(page.getByTestId('pick-row-254')).toBeVisible();

  // Print is the primary action; file formats live in the Export menu.
  await expect(page.getByTestId('pick-export-alliance-print')).toBeVisible();
  await expect(page.getByTestId('pick-export-menu-trigger')).toBeVisible();
  await page.getByTestId('pick-export-menu-trigger').click();
  await expect(page.getByTestId('pick-export-alliance-csv')).toBeVisible();
  await expect(page.getByTestId('pick-export-tool-csv')).toBeVisible();

  // Alliance Sheet CSV download.
  const dl1 = page.waitForEvent('download');
  await page.getByTestId('pick-export-alliance-csv').click();
  expect((await dl1).suggestedFilename()).toBe('alliance-sheet-2026casnv.csv');

  // Picklist Tool CSV download.
  await page.getByTestId('pick-export-menu-trigger').click();
  const dl2 = page.waitForEvent('download');
  await page.getByTestId('pick-export-tool-csv').click();
  expect((await dl2).suggestedFilename()).toBe('picklist-tool-2026casnv.csv');

  // Print preset opens a new page (window.open) with the self-contained sheet.
  const popupPromise = page.context().waitForEvent('page');
  await page.getByTestId('pick-export-alliance-print').click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(await popup.title()).toContain('Alliance Selection');
});
