// tests/e2e/capture.spec.ts
// Offline-capture round-trip: a scouter (picked by name — no login) runs a manual
// capture through the LIVE screen (START -> GO -> slider-shoot bursts) and the
// DEFERRED review (climb -> SAVE), then the report lands in the local store
// (Unsynced count increments). Save is purely local — offline-first end to end.
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { E2E_EVENT_KEY, E2E_MATCH_KEY, E2E_TEAM } from './global-setup';
import { setActiveEvent, ensureRosterName, pickScouter } from './helpers';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;
const SCOUTER = 'E2E Capture Scout';

const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

test.beforeAll(async () => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  // The login-less flow needs migration 0009 (scouter_roster + select_scouter) on
  // the target DB. Skip gracefully if it hasn't been applied to this deployment.
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (scouter_roster/select_scouter) to run this flow.');
  await ensureRosterName(admin, SCOUTER);
});

test('scouter captures a match offline and it queues as unsynced', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  // Set active immediately before picking (shared flag — the scouter binds to the
  // active event at pick time, so set it last to avoid cross-spec races).
  await setActiveEvent(admin, E2E_EVENT_KEY);

  // Pick a name (online: binds this device to a scout row for the active event).
  await pickScouter(page, SCOUTER);
  await expect(page.getByTestId('sync-queued')).toHaveText('0');

  // Manual pick (event is fixed to the active event); reach an enabled start.
  await page.locator('#mp-match').fill(E2E_MATCH_KEY);
  await page.locator('#mp-team').fill(String(E2E_TEAM));
  await expect(page.getByTestId('scout-start-capture')).toBeEnabled();

  // Go offline: capture + save must work with no network.
  await page.context().setOffline(true);
  await expect(page.getByTestId('sync-indicator').getByLabel('offline')).toBeVisible();

  await page.getByTestId('scout-start-capture').click();

  // Pre-match placement step (half-field auto picker) gates the live screen.
  await expect(page.getByTestId('capture-placement-submit')).toBeVisible();
  // The Start button is disabled until the robot is PLACED — tap the field.
  await page.getByTestId('capture-half-clip').click();
  await page.getByTestId('capture-placement-submit').click();

  await expect(page.getByTestId('capture-start')).toBeVisible();
  await page.getByTestId('capture-start').click();
  await expect(page.getByTestId('capture-go')).toBeVisible();
  await page.getByTestId('capture-go').click();
  await expect(page.getByTestId('capture-go-interstitial')).toBeVisible();
  await page.getByTestId('capture-inactive-no').click();

  // Slider-shoot: press, drag RIGHT to set a BPS rate, hold, release to commit a
  // fuel burst (running count = ∫ rate·dt). A coordinateless tap is rate 0 / 0 balls,
  // so drive a real drag-and-hold and assert a non-zero burst landed.
  await expect(page.getByTestId('capture-running-fuel')).toHaveText('0');
  const hold = page.getByTestId('capture-hold');
  const box = await hold.boundingBox();
  if (!box) throw new Error('capture-hold has no bounding box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 5 });
  await page.waitForTimeout(500); // hold so the rate integrates to a non-zero count
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.getByTestId('capture-running-fuel').textContent()))
    .toBeGreaterThan(0);

  // Deferred review: a multi-step wizard. Step 1 is Climb; SAVE is on the last
  // ("Review & save") step, so set the climb then advance with Next to reach it.
  await page.getByTestId('capture-to-review').click();
  await page.getByTestId('review-climb').getByRole('button', { name: '3', exact: true }).click();
  const save = page.getByTestId('review-save');
  for (let i = 0; i < 6 && !(await save.isVisible()); i += 1) {
    await page.getByTestId('review-next').click();
  }
  await expect(page.getByTestId('review-summary')).toBeVisible();
  await save.click();

  // Back on the scout home, still offline: the report stays queued (not synced).
  await expect(page.getByTestId('scout-home')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sync-queued')).toHaveText('1');
  await expect(page.getByTestId('sync-deadletters')).toHaveText('0');
  // Stay offline: this spec verifies the OFFLINE queue only. Reconnecting here
  // would sync a row for the same _e2etest match/team and collide with sync.spec.
});
