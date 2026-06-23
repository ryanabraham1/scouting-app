// tests/e2e/capture.spec.ts
// Offline-capture round-trip: a joined scout runs a manual capture through the
// LIVE screen (START -> GO -> hold-to-shoot bursts) and the DEFERRED review
// (climb -> SAVE), then the report lands in the local store (Unsynced count
// increments). The save is purely local — no server write — so this exercises
// the offline-first path end to end with a fresh, empty IndexedDB per context.
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

const JOIN_CODE = process.env.E2E_JOIN_CODE;

test('scout captures a match offline and it queues as unsynced', async ({ page }) => {
  test.skip(!JOIN_CODE, 'Set E2E_JOIN_CODE in .env.local to run the live capture flow.');

  // --- Join (anon sign-in + join_event) and land on the scout home. ---
  await page.goto('/join');
  await page.getByTestId('join-code').fill(JOIN_CODE as string);
  await page.getByTestId('join-name').fill('E2E Capture Scout');
  await page.getByTestId('join-submit').click();

  await expect(page).toHaveURL(/\/scout$/, { timeout: 15_000 });
  await expect(page.getByTestId('scout-home')).toBeVisible();
  // Fresh IndexedDB for this context: nothing queued yet.
  await expect(page.getByTestId('sync-queued')).toHaveText('↑0');

  // Fill the manual pick while ONLINE and wait for the scout row to load — the
  // start button stays disabled until scout_id resolves. We must reach that
  // state before going offline (an offline scout fetch would never resolve).
  await page.locator('#mp-event').fill('_e2etest');
  await page.locator('#mp-match').fill('_e2etest_qm1');
  await page.locator('#mp-team').fill('254');
  await expect(page.getByTestId('scout-start-capture')).toBeEnabled();

  // Go offline: capture + save must work with no network, and the auto-sync
  // must NOT drain the queue while offline.
  await page.context().setOffline(true);
  await expect(page.getByTestId('sync-indicator').getByLabel('offline')).toBeVisible();

  // --- Start the capture session (offline). ---
  await page.getByTestId('scout-start-capture').click();

  // LIVE screen. START the synced clock (idle -> auto).
  await expect(page.getByTestId('capture-start')).toBeVisible();
  await page.getByTestId('capture-start').click();

  // GO to teleop, then answer the inactive-first interstitial.
  await expect(page.getByTestId('capture-go')).toBeVisible();
  await page.getByTestId('capture-go').click();
  await expect(page.getByTestId('capture-go-interstitial')).toBeVisible();
  await page.getByTestId('capture-inactive-no').click();

  // Back on the LIVE screen in teleop. Record two hold-to-shoot bursts; the
  // running fuel readout counts bursts, so it tracks each hold.
  await expect(page.getByTestId('capture-running-fuel')).toHaveText('0');
  const hold = page.getByTestId('capture-hold');
  await hold.dispatchEvent('pointerdown');
  await hold.dispatchEvent('pointerup');
  await expect(page.getByTestId('capture-running-fuel')).toHaveText('1');
  await hold.dispatchEvent('pointerdown');
  await hold.dispatchEvent('pointerup');
  await expect(page.getByTestId('capture-running-fuel')).toHaveText('2');

  // --- Deferred review: set a climb level, then SAVE. ---
  await page.getByTestId('capture-to-review').click();
  await expect(page.getByTestId('review-summary')).toBeVisible();
  await page.getByTestId('review-climb').getByRole('button', { name: '3', exact: true }).click();
  await page.getByTestId('review-save').click();

  // Save clears the draft and returns to the scout home with the report queued
  // locally — still offline, so it stays queued (not synced).
  await expect(page.getByTestId('scout-home')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sync-queued')).toHaveText('↑1');
  await expect(page.getByTestId('sync-deadletters')).toHaveText('⚠0');

  await page.context().setOffline(false);
});
