// tests/e2e/report-correction.spec.ts
// Post-match report correction: a scout re-opens a previously-submitted match
// report from My Data, edits a field, and resubmits with a bumped revision. The
// revision-guarded upsert_match_report UPDATEs the existing row (idempotent
// re-send is a server no-op), so this is verified both locally (rev chip, toast)
// and server-side (row_revision === 2, single row).
//
// Isolation: this spec uses a DISTINCT scouter name ('E2E Correction Scout') →
// distinct scout_id → its own one-active-report slot, so it cannot collide with
// the Capture/Sync scouters on the single-worker shared live DB.
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { E2E_EVENT_KEY, E2E_MATCH_KEY, E2E_TEAM } from './global-setup';
import { setActiveEvent, ensureRosterName, pickScouter } from './helpers';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;
const SCOUTER = 'E2E Correction Scout';

const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

test.beforeAll(async () => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (scouter_roster/select_scouter) to run this flow.');
  await ensureRosterName(admin, SCOUTER);
});

test.afterAll(async () => {
  if (!URL || !SECRET) return;
  // Sweep this scouter's reports for the test match (mirrors global-teardown).
  await admin.from('match_scouting_report').delete().eq('event_key', E2E_EVENT_KEY);
});

// Drive a baseline live capture → review → save (mirrors capture.spec) and land
// back on Scout Home with the report queued/synced.
async function captureBaseline(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#mp-match').fill(E2E_MATCH_KEY);
  await page.locator('#mp-team').fill(String(E2E_TEAM));
  await expect(page.getByTestId('scout-start-capture')).toBeEnabled();
  await page.getByTestId('scout-start-capture').click();

  await expect(page.getByTestId('capture-placement-submit')).toBeVisible();
  await page.getByTestId('capture-placement-submit').click();

  await expect(page.getByTestId('capture-start')).toBeVisible();
  await page.getByTestId('capture-start').click();
  await expect(page.getByTestId('capture-go')).toBeVisible();
  await page.getByTestId('capture-go').click();
  await expect(page.getByTestId('capture-go-interstitial')).toBeVisible();
  await page.getByTestId('capture-inactive-no').click();

  const hold = page.getByTestId('capture-hold');
  const box = await hold.boundingBox();
  if (!box) throw new Error('capture-hold has no bounding box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 5 });
  await page.waitForTimeout(500);
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.getByTestId('capture-running-fuel').textContent()))
    .toBeGreaterThan(0);

  await page.getByTestId('capture-to-review').click();
  const save = page.getByTestId('review-save');
  for (let i = 0; i < 6 && !(await save.isVisible()); i += 1) {
    await page.getByTestId('review-next').click();
  }
  await expect(page.getByTestId('review-summary')).toBeVisible();
  await save.click();
  await expect(page.getByTestId('scout-home')).toBeVisible({ timeout: 15_000 });
}

// Step the edit Review wizard from Climb to the SAVE step, setting climb to 3 and
// a distinctive note along the way.
async function editClimbAndNotes(
  page: import('@playwright/test').Page,
  note: string,
): Promise<void> {
  await page.getByTestId('review-climb').getByRole('button', { name: '3', exact: true }).click();
  const save = page.getByTestId('review-save');
  for (let i = 0; i < 6 && !(await save.isVisible()); i += 1) {
    await page.getByTestId('review-next').click();
  }
  await expect(page.getByTestId('review-summary')).toBeVisible();
  await page.locator('textarea').first().fill(note);
  await save.click();
}

test('Scenario A: edit + resubmit bumps revision (local + server)', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  await setActiveEvent(admin, E2E_EVENT_KEY);
  await pickScouter(page, SCOUTER);
  await expect(page.getByTestId('sync-queued')).toBeVisible();

  // 1. Baseline report, online so it syncs.
  await captureBaseline(page);
  await expect(page.getByTestId('sync-queued')).toHaveText('↑0', { timeout: 30_000 });

  // 2. My Data → there's a row with an Edit button.
  await page.getByTestId('nav-my-data').click();
  await expect(page.getByTestId('my-data-row').first()).toBeVisible();

  // 3. Read the client id off the testid, then click Edit.
  const editTestid = await page
    .locator('[data-testid^="my-data-edit-"]')
    .first()
    .getAttribute('data-testid');
  const editId = editTestid!.replace('my-data-edit-', '');
  await page.getByTestId(`my-data-edit-${editId}`).click();

  // 4. Opens straight on Review in edit mode with the rev banner.
  await expect(page.getByTestId('review-editing-banner')).toBeVisible();
  await expect(page.getByTestId('review-editing-banner')).toContainText('rev 1 -> 2');

  // 5. Change climb to 3 + a distinctive note; save.
  const note = `corrected-${Date.now()}`;
  await editClimbAndNotes(page, note);

  // 6. Redirect to My Data with the updated toast + a rev 2 chip.
  await expect(page.getByTestId('my-data')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('my-data-updated-toast')).toBeVisible();
  await expect(page.getByTestId(`my-data-rev-${editId}`)).toContainText('rev 2');
  await expect(page.getByText(note)).toBeVisible();

  // 7. Server assertion once the queue drains: revision bumped, climb updated,
  //    exactly one row for that id (UPDATE path, not a duplicate insert).
  await page.goto('/scout');
  await expect(page.getByTestId('sync-queued')).toHaveText('↑0', { timeout: 30_000 });
  const res = await admin
    .from('match_scouting_report')
    .select('row_revision, climb_level')
    .eq('id', editId);
  expect(res.error).toBeNull();
  expect(res.data).toHaveLength(1);
  expect(res.data![0].row_revision).toBe(2);
  expect(res.data![0].climb_level).toBe(3);

  // Scenario B: idempotent resubmit — re-trigger sync without editing; revision
  // stays 2 and there's still exactly one active row.
  await page.reload();
  await expect(page.getByTestId('sync-queued')).toHaveText('↑0', { timeout: 30_000 });
  const again = await admin
    .from('match_scouting_report')
    .select('row_revision')
    .eq('id', editId);
  expect(again.data).toHaveLength(1);
  expect(again.data![0].row_revision).toBe(2);
});

test('Scenario C: dead-letter rows are not editable', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  await setActiveEvent(admin, E2E_EVENT_KEY);
  await pickScouter(page, SCOUTER);

  // Seed a report directly into Dexie with syncState: 'error'.
  await page.evaluate(async () => {
    // Vite serves source modules at this URL inside the browser; the indirection
    // through a variable stops tsc resolving it as a static (server-side) module.
    const localStoreUrl = '/src/db/localStore.ts';
    const { saveReport } = (await import(/* @vite-ignore */ localStoreUrl)) as {
      saveReport: (r: Record<string, unknown>) => Promise<void>;
    };
    // MyDataView filters by the cached scout row's id, so seed under that id.
    const scoutRaw = localStorage.getItem('cached_scout_row');
    const scoutId = scoutRaw ? (JSON.parse(scoutRaw).id ?? 'unknown') : 'unknown';
    await saveReport({
      id: 'e2e-deadletter-1',
      schemaVersion: 3,
      appVersion: '2.0.0',
      deviceId: 'device-local',
      createdAt: new Date().toISOString(),
      eventKey: '_e2etest',
      matchKey: '_e2etest_qm1',
      scoutId,
      scoutName: 'E2E Correction Scout',
      targetTeamNumber: 9999,
      allianceColor: 'red',
      station: 1,
      inactiveFirst: false,
      inactiveFirstSource: 'scout',
      teleopClockUnconfirmed: false,
      fuelBursts: [],
      feedingBursts: [],
      autoFuel: 0,
      teleopFuelActive: 0,
      teleopFuelInactive: 0,
      endgameFuel: 0,
      fuelByShift: [0, 0, 0, 0],
      fuelPoints: 0,
      fuelEstimateConfidence: 0.3,
      climbLevel: 0,
      climbAttempted: false,
      climbSuccess: false,
      autoStartPosition: null,
      autoPath: null,
      autoLeftStartingLine: false,
      autoClimbLevel1: false,
      intakeSources: [],
      maxFuelCapacityObserved: 0,
      defenseRating: 0,
      defenseDurationMs: 0,
      defendedDurationMs: 0,
      defenseIntervals: [],
      defendedIntervals: [],
      pins: 0,
      foulsMinor: 0,
      foulsMajor: 0,
      foulReasons: [],
      noShow: false,
      died: false,
      tipped: false,
      droppedFuel: false,
      fedCorral: false,
      notes: 'dead letter',
      syncState: 'error',
      rowRevision: 1,
      syncAttempts: 5,
      lastSyncError: 'seeded failure',
    });
  });

  await page.getByTestId('nav-my-data').click();
  await expect(page.getByTestId('my-data-needs-sync-e2e-deadletter-1')).toBeVisible();
  await expect(page.getByTestId('my-data-edit-e2e-deadletter-1')).toHaveCount(0);
});

test('Scenario D: offline edit queues then drains', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  await setActiveEvent(admin, E2E_EVENT_KEY);
  await pickScouter(page, SCOUTER);
  await expect(page.getByTestId('sync-queued')).toHaveText('↑0', { timeout: 30_000 });

  await captureBaseline(page);
  await expect(page.getByTestId('sync-queued')).toHaveText('↑0', { timeout: 30_000 });

  await page.getByTestId('nav-my-data').click();
  const editTestid = await page
    .locator('[data-testid^="my-data-edit-"]')
    .first()
    .getAttribute('data-testid');
  const editId = editTestid!.replace('my-data-edit-', '');

  // Go offline, edit, save: it must queue locally with no network.
  await page.context().setOffline(true);
  await page.getByTestId(`my-data-edit-${editId}`).click();
  await expect(page.getByTestId('review-editing-banner')).toBeVisible();
  await editClimbAndNotes(page, `offline-${Date.now()}`);

  await page.goto('/scout');
  await expect(page.getByTestId('sync-indicator').getByLabel('offline')).toBeVisible();
  await expect(page.getByTestId('sync-queued')).toHaveText('↑1');

  // Back online: drains to ↑0 and the server shows revision 2.
  await page.context().setOffline(false);
  await expect(page.getByTestId('sync-queued')).toHaveText('↑0', { timeout: 30_000 });
  const res = await admin
    .from('match_scouting_report')
    .select('row_revision')
    .eq('id', editId);
  expect(res.data).toHaveLength(1);
  expect(res.data![0].row_revision).toBe(2);
});
