// tests/e2e/admin.spec.ts — no login: open the dashboard Setup tab, auto-generate
// assignments, and publish. (/admin redirects to /dashboard?tab=setup.)
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { setActiveEvent } from './helpers';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;
const EVENT = '2026casnv';

const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const seededScoutIds: string[] = [];

test.beforeAll(async () => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  // The open (no-login) dashboard depends on migration 0009 (open RLS + scouter_roster).
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (open RLS) to run the login-less dashboard flows.');
  // Seed 3 scouts for the active event so auto-generate has a pool.
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
  await admin.from('assignment').delete().eq('event_key', EVENT);
  if (seededScoutIds.length) await admin.from('scout').delete().in('id', seededScoutIds);
});

test('lead auto-generates assignments and publishes (no login)', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  // Set active immediately before navigating (the active event is a single shared
  // flag; other specs mutate it, so set it last to avoid cross-spec races).
  await setActiveEvent(admin, EVENT);

  // /admin folds into the dashboard Setup tab — no login gate.
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/dashboard\?tab=setup$/, { timeout: 15_000 });
  await expect(page.getByTestId('setup-tab')).toBeVisible({ timeout: 15_000 });

  // Auto-generate the assignment grid (event 2026casnv is imported + active).
  await page.getByTestId('auto-generate-btn').click();
  await expect(page.getByTestId('assignment-grid')).toBeVisible({ timeout: 15_000 });

  // Publish the assignments via the set_assignments RPC.
  await page.getByTestId('publish-assignments-btn').click();
  await expect(page.getByTestId('assignments-published')).toBeVisible({ timeout: 15_000 });

  const { count, error } = await admin
    .from('assignment')
    .select('*', { count: 'exact', head: true })
    .eq('event_key', EVENT);
  expect(error).toBeNull();
  expect(count ?? 0).toBeGreaterThan(0);
});

test('coverage board reflects gap count as the lead edits a slot', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, EVENT);
  await page.goto('/dashboard?tab=setup');
  await expect(page.getByTestId('setup-tab')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('auto-generate-btn').click();
  await expect(page.getByTestId('assignment-grid')).toBeVisible({ timeout: 15_000 });
  // The DRAFT coverage headline is the one inside the generated panel.
  const headline = page.getByTestId('coverage-headline').first();
  await expect(headline).toBeVisible();

  // Parse the baseline gap count straight from the headline text.
  const gapCount = async () => {
    const t = (await headline.textContent()) ?? '';
    const m = t.match(/(\d+)\s+gap/);
    return m ? Number(m[1]) : 0;
  };
  const base = await gapCount();

  // Find a slot that IS currently assigned (non-empty value) and unassign it.
  const selects = page.getByTestId('slot-select');
  const n = await selects.count();
  let assignedIdx = -1;
  for (let i = 0; i < n; i++) {
    if (((await selects.nth(i).inputValue()) ?? '') !== '') {
      assignedIdx = i;
      break;
    }
  }
  expect(assignedIdx).toBeGreaterThanOrEqual(0); // auto-generate assigned at least one seat
  await selects.nth(assignedIdx).selectOption(''); // '' === unassigned

  // Gap count rises by exactly one; the gaps container + a gap chip are now visible.
  await expect.poll(gapCount).toBe(base + 1);
  await expect(page.getByTestId('coverage-gaps').first()).toBeVisible();
  await expect(page.getByTestId('coverage-gap-seat').first()).toBeVisible();

  // Re-assign to the first real scout -> gap count returns to baseline.
  await selects.nth(assignedIdx).selectOption({ index: 1 }); // first real scout option
  await expect.poll(gapCount).toBe(base);
});
