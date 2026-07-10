// tests/e2e/simulation.spec.ts
// FULL EVENT SIMULATION — multiple concurrent "users" (independent browser
// contexts = independent devices) hammer the live active event the way a real
// FRC event runs: several scouts capturing matches at the same time, two scouts
// on the same target, the same scouter name on two phones, an offline scout that
// reconnects, a lead watching the dashboard while data streams in, and pit
// scouting. Runs against the real remote Supabase (the dev server proxies it).
//
// Isolation: we DO NOT touch the global active-event singleton beyond asserting
// 2026casnv is active (it already is). Every match report we create is deleted in
// afterAll (the event's baseline match-report count is 0). The one pit report we
// create is for a team with no existing pit data (1700) and is deleted too.
//
// Every context streams its console + uncaught errors into a shared bucket; a
// final test asserts no uncaught page errors fired anywhere — the cheapest way to
// surface runtime crashes a happy-path assertion would miss.
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { E2E_AUTH_STATE_PATH } from './global-setup';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;
const EVENT = '2026casnv';

const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Real roster names present on the deployed DB (login-less name picker).
const NAMES = ['Test 1', 'Test 2', 'Test 3', 'Test 5'];
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

// Real qm lineups in 2026casnv (blue1 of each, all distinct teams).
const TARGETS: { matchKey: string; team: number }[] = [
  { matchKey: '2026casnv_qm1', team: 254 },
  { matchKey: '2026casnv_qm2', team: 100 },
  { matchKey: '2026casnv_qm3', team: 581 },
];

interface ErrSink {
  pageErrors: { who: string; msg: string }[];
  consoleErrors: { who: string; msg: string }[];
}
const sink: ErrSink = { pageErrors: [], consoleErrors: [] };

function watch(page: Page, who: string): void {
  page.on('pageerror', (err) => sink.pageErrors.push({ who, msg: String(err?.message ?? err) }));
  page.on('console', (m) => {
    if (m.type() === 'error') sink.consoleErrors.push({ who, msg: m.text() });
  });
}

// Count ACTIVE (not soft-deleted) reports — the supersede path (migration 0025)
// keeps the superseded row with deleted=true for auditability, so a raw count
// would include it. The dashboard only ever shows deleted=false.
async function reportCount(matchKey: string, team: number): Promise<number> {
  const { count, error } = await admin
    .from('match_scouting_report')
    .select('*', { count: 'exact', head: true })
    .eq('event_key', EVENT)
    .eq('match_key', matchKey)
    .eq('target_team_number', team)
    .eq('deleted', false);
  if (error) throw error;
  return count ?? 0;
}

async function ensureRosterName(name: string): Promise<void> {
  const { error } = await admin.from('scouter_roster').insert({ name });
  if (error && error.code !== '23505') throw new Error(`ensureRosterName: ${error.message}`);
}

async function setActive(): Promise<void> {
  const { error } = await admin.rpc('set_active_event', { p_event_key: EVENT });
  if (error) throw new Error(`setActive: ${error.message}`);
}

/** Onboard a device under `name` and land on the match-capture home. */
async function pick(page: Page, name: string): Promise<void> {
  await page.goto('/scout');
  await expect(
    page.locator('[data-testid="scout-name-picker"], [data-testid="scout-manual-pick"]').first(),
  ).toBeVisible({ timeout: 20_000 });
  if (await page.getByTestId('scout-manual-pick').isVisible().catch(() => false)) {
    if (await page.getByRole('heading', { name, exact: true }).isVisible().catch(() => false)) return;
    await page.getByRole('button', { name: /^Log out / }).click();
    await page.getByTestId('scout-logout-confirm').click();
  }
  await expect(page.getByTestId('scout-name-picker')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('scout-name-filter').fill(name);
  await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click();
  await expect(page.getByTestId('scout-manual-pick')).toBeVisible({ timeout: 20_000 });
}

/** Drive the whole live-capture + review flow for an already-onboarded device. */
async function capture(page: Page, matchKey: string, team: number, climb = 3): Promise<void> {
  await page.locator('#mp-match').fill(matchKey);
  await page.locator('#mp-team').fill(String(team));
  await expect(page.getByTestId('scout-start-capture')).toBeEnabled();
  await page.getByTestId('scout-start-capture').click();

  await expect(page.getByTestId('capture-placement-submit')).toBeVisible({ timeout: 15_000 });
  // The Start button is disabled until the robot is PLACED — tap the field.
  await page.getByTestId('capture-half-clip').click();
  await page.getByTestId('capture-placement-submit').click();

  await page.getByTestId('capture-start').click();
  await page.getByTestId('capture-go').click();
  await expect(page.getByTestId('capture-go-interstitial')).toBeVisible();
  await page.getByTestId('capture-inactive-no').click();

  // Slider-shoot: press + drag right + hold so the rate integrates to a real
  // non-zero fuel burst (mirrors capture.spec).
  const hold = page.getByTestId('capture-hold');
  const box = await hold.boundingBox();
  if (!box) throw new Error('capture-hold has no bounding box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 5 });
  await page.waitForTimeout(450);
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.getByTestId('capture-running-fuel').textContent()))
    .toBeGreaterThan(0);

  await page.getByTestId('capture-to-review').click();
  await page
    .getByTestId('review-climb')
    .getByRole('button', { name: String(climb), exact: true })
    .click();
  const save = page.getByTestId('review-save');
  for (let i = 0; i < 6 && !(await save.isVisible()); i += 1) {
    await page.getByTestId('review-next').click();
  }
  await expect(page.getByTestId('review-summary')).toBeVisible();
  await save.click();

  await expect(page.getByTestId('scout-home')).toBeVisible({ timeout: 20_000 });
}

async function expectDrained(page: Page): Promise<void> {
  await expect(page.getByTestId('sync-queued')).toHaveText('0', { timeout: 25_000 });
  await expect(page.getByTestId('sync-deadletters')).toHaveText('0', { timeout: 25_000 });
}

async function advancePitToStep(page: Page, targetStep: number): Promise<void> {
  const step = page.getByTestId('pit-step');
  for (let current = 1; current < targetStep; current += 1) {
    await expect(step).toHaveText(`Step ${current} of 6`);
    await page.getByTestId('pit-next').click();
    await expect(step).toHaveText(`Step ${current + 1} of 6`);
  }
}

async function cleanPitReport(teamNumber: number): Promise<void> {
  const { data } = await admin
    .from('pit_scouting_report')
    .select('photos,photo_path')
    .eq('event_key', EVENT)
    .eq('team_number', teamNumber);
  const paths = new Set<string>();
  for (const row of data ?? []) {
    if (typeof row.photo_path === 'string' && row.photo_path) paths.add(row.photo_path);
    if (Array.isArray(row.photos)) {
      for (const photo of row.photos as Array<{ path?: unknown }>) {
        if (typeof photo.path === 'string' && photo.path) paths.add(photo.path);
      }
    }
  }
  if (paths.size > 0) await admin.storage.from('pit-photos').remove([...paths]);
  await admin.from('pit_scouting_report').delete().eq('event_key', EVENT).eq('team_number', teamNumber);
}

test.beforeAll(async () => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (scouter_roster/select_scouter).');
  for (const n of NAMES) await ensureRosterName(n);
  await setActive();
  // Clean slate (baseline match-report count for 2026casnv is 0).
  await admin.from('match_scouting_report').delete().eq('event_key', EVENT);
  await cleanPitReport(1700);
});

test.afterAll(async () => {
  if (!URL || !SECRET) return;
  await admin.from('match_scouting_report').delete().eq('event_key', EVENT);
  await cleanPitReport(1700);
});

// ---------------------------------------------------------------------------
// SCENARIO 1 — Three scouts capture three distinct targets AT THE SAME TIME.
// ---------------------------------------------------------------------------
test('three concurrent scouts capture distinct targets and all sync cleanly', async ({ browser }) => {
  test.setTimeout(180_000);
  const ctxs: BrowserContext[] = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const c = await browser.newContext({ storageState: E2E_AUTH_STATE_PATH });
      ctxs.push(c);
    }
    const pages = await Promise.all(ctxs.map((c) => c.newPage()));
    pages.forEach((p, i) => watch(p, `scout-${NAMES[i]}`));

    // Onboard concurrently.
    await Promise.all(pages.map((p, i) => pick(p, NAMES[i])));
    // Capture concurrently.
    await Promise.all(pages.map((p, i) => capture(p, TARGETS[i].matchKey, TARGETS[i].team)));
    // Each device's outbox drains to zero with no dead-letters.
    await Promise.all(pages.map((p) => expectDrained(p)));

    // Exactly one server row per distinct target, no duplicates.
    for (const t of TARGETS) {
      expect(await reportCount(t.matchKey, t.team), `${t.matchKey}/${t.team}`).toBe(1);
    }
  } finally {
    await Promise.all(ctxs.map((c) => c.close()));
  }
});

// ---------------------------------------------------------------------------
// SCENARIO 2 — Two DIFFERENT scouts scout the SAME match+target concurrently.
// Two distinct scout_ids → two active rows must coexist (the one-active-report
// unique index is per (match, scout), not per (match, target)).
// ---------------------------------------------------------------------------
test('two scouts on the same target produce two distinct rows (no false conflict)', async ({ browser }) => {
  test.setTimeout(180_000);
  const matchKey = '2026casnv_qm4';
  const team = 7528;
  const ctxs: BrowserContext[] = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      ctxs.push(await browser.newContext({ storageState: E2E_AUTH_STATE_PATH }));
    }
    const pages = await Promise.all(ctxs.map((c) => c.newPage()));
    pages.forEach((p, i) => watch(p, `dup-target-${NAMES[i]}`));
    await Promise.all([pick(pages[0], NAMES[0]), pick(pages[1], NAMES[1])]);
    await Promise.all([
      capture(pages[0], matchKey, team, 2),
      capture(pages[1], matchKey, team, 1),
    ]);
    await Promise.all(pages.map((p) => expectDrained(p)));
    expect(await reportCount(matchKey, team)).toBe(2);
  } finally {
    await Promise.all(ctxs.map((c) => c.close()));
  }
});

// ---------------------------------------------------------------------------
// SCENARIO 3 — The SAME scouter name picked on TWO devices (the fragile
// scouter-identity path). Both capture different matches; both must sync.
// ---------------------------------------------------------------------------
test('same scouter name on two devices: both capture and sync', async ({ browser }) => {
  test.setTimeout(180_000);
  const name = NAMES[3]; // 'Test 5'
  const a = { matchKey: '2026casnv_qm5', team: 3256 };
  const b = { matchKey: '2026casnv_qm6', team: 10372 };
  const ctxs: BrowserContext[] = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      ctxs.push(await browser.newContext({ storageState: E2E_AUTH_STATE_PATH }));
    }
    const pages = await Promise.all(ctxs.map((c) => c.newPage()));
    pages.forEach((p, i) => watch(p, `same-name-${i}`));
    await Promise.all([pick(pages[0], name), pick(pages[1], name)]);
    await Promise.all([capture(pages[0], a.matchKey, a.team), capture(pages[1], b.matchKey, b.team)]);
    await Promise.all(pages.map((p) => expectDrained(p)));
    expect(await reportCount(a.matchKey, a.team)).toBe(1);
    expect(await reportCount(b.matchKey, b.team)).toBe(1);
  } finally {
    await Promise.all(ctxs.map((c) => c.close()));
  }
});

// ---------------------------------------------------------------------------
// SCENARIO 4 — Offline capture queues, then drains on reconnect (offline-first).
// ---------------------------------------------------------------------------
test('offline capture queues and drains on reconnect', async ({ browser }) => {
  test.setTimeout(180_000);
  const matchKey = '2026casnv_qm2';
  const team = 5499; // blue3 of qm2, distinct from scenario 1 targets
  const ctx = await browser.newContext({ storageState: E2E_AUTH_STATE_PATH });
  try {
    const page = await ctx.newPage();
    watch(page, 'offline-scout');
    await pick(page, NAMES[0]);
    await ctx.setOffline(true);
    await capture(page, matchKey, team);
    await expect(page.getByTestId('sync-queued')).toHaveText('1', { timeout: 15_000 });
    await ctx.setOffline(false);
    await expectDrained(page);
    expect(await reportCount(matchKey, team)).toBe(1);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// SCENARIO 5 — Lead dashboard: load + click through every data tab while reports
// exist, with no crash / no error boundary.
// ---------------------------------------------------------------------------
test('lead dashboard navigates all tabs without crashing', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ storageState: E2E_AUTH_STATE_PATH });
  try {
    const page = await ctx.newPage();
    watch(page, 'dashboard');
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 20_000 });

    // Exact labels (so "Match" doesn't also match "Pit Display"/"Strategy").
    const TABS = ['Pit Display', 'Strategy', 'Team', 'Match', 'Ranking', 'Picklist', 'Scouters', 'Setup'];
    for (const label of TABS) {
      await page.getByRole('tab', { name: label, exact: true }).click();
      // The error boundary would replace the screen with route-error; assert it never does.
      await expect(page.getByTestId('route-error')).toHaveCount(0);
      await page.waitForTimeout(800);
    }
    // Setup tab should resolve the active event.
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await expect(page.getByTestId('setup-active-event')).toHaveText(EVENT, { timeout: 15_000 });
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// SCENARIO 6 — Pit scouting submits and syncs to the server.
// ---------------------------------------------------------------------------
test('pit scouting submits multiple photos, syncs, and supports later editing', async ({ browser }) => {
  test.setTimeout(240_000);
  const team = 1700;
  const ctx = await browser.newContext({ storageState: E2E_AUTH_STATE_PATH });
  let staleCtx: BrowserContext | null = null;
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    watch(page, 'pit-scout');
    await pick(page, NAMES[2]);
    // Switch into pit mode via the segmented toggle.
    await page.getByRole('tab', { name: 'Pit', exact: true }).click();
    await expect(page.getByTestId('pit-team-input')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('pit-team-input').fill(String(team));
    await page.getByTestId('pit-team-go').click();
    await expect(page.getByTestId('pit-screen')).toBeVisible({ timeout: 15_000 });
    // The pit form is a 6-step wizard. Wait for each React step transition so
    // rapid clicks cannot collapse against one stale state snapshot.
    await page.getByTestId('pit-drivetrain').selectOption('swerve');
    await advancePitToStep(page, 3);
    await page.getByTestId('pit-vision').fill('Limelight 3');
    await page.getByTestId('pit-battery-count').fill('6');
    await page.getByTestId('pit-next').click();
    await expect(page.getByTestId('pit-step')).toHaveText('Step 4 of 6');
    await page.getByTestId('pit-next').click();
    await expect(page.getByTestId('pit-step')).toHaveText('Step 5 of 6');
    await page.getByTestId('pit-next').click();
    await expect(page.getByTestId('pit-step')).toHaveText('Step 6 of 6');
    // Camera capture and camera-roll/library selection are separate controls.
    await expect(page.getByTestId('pit-camera')).toHaveAttribute('capture', 'environment');
    await expect(page.getByTestId('pit-camera')).not.toHaveAttribute('multiple');
    await expect(page.getByTestId('pit-photo')).toHaveAttribute('multiple', '');
    await expect(page.getByTestId('pit-photo')).not.toHaveAttribute('capture');
    await page.getByTestId('pit-camera').setInputFiles({
      name: 'robot-front.png',
      mimeType: 'image/png',
      buffer: TEST_PNG,
    });
    await page.getByTestId('pit-photo').setInputFiles({
      name: 'robot-side.png',
      mimeType: 'image/png',
      buffer: TEST_PNG,
    });
    await expect(page.getByRole('img', { name: /Pit photo \d+ preview/ })).toHaveCount(2);
    await page.getByRole('button', { name: 'Move photo 2 earlier' }).click();
    await page.locator('#pit-notes').fill('Initial two-photo report');
    await page.getByTestId('pit-submit').click();
    // onDone returns to the team picker after a successful queue.
    await expect(page.getByTestId('pit-team-input')).toBeVisible({ timeout: 15_000 });
    // The pit outbox uploads it.
    let firstRevision = 0;
    let initialPhotoIds: string[] = [];
    await expect.poll(async () => {
      const { data } = await admin
        .from('pit_scouting_report')
        .select('row_revision,notes,photos')
        .eq('event_key', EVENT)
        .eq('team_number', team)
        .single();
      const photos = Array.isArray(data?.photos) ? data.photos : [];
      initialPhotoIds = photos
        .map((photo) => (photo as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string');
      firstRevision = Number(data?.row_revision ?? 0);
      return {
        notes: data?.notes ?? null,
        photos: photos.length,
        uploaded: photos.every(
          (photo) => typeof (photo as { path?: unknown }).path === 'string',
        ),
      };
    }, { timeout: 25_000 }).toEqual({
      notes: 'Initial two-photo report',
      photos: 2,
      uploaded: true,
    });

    // A second device loads the same base revision, then waits while this device
    // wins an edit. Submitting the stale copy later must dead-letter as a conflict.
    staleCtx = await browser.newContext({ storageState: E2E_AUTH_STATE_PATH });
    const stalePage = await staleCtx.newPage();
    stalePage.setDefaultTimeout(15_000);
    watch(stalePage, 'pit-stale-editor');
    await pick(stalePage, NAMES[3]);
    await stalePage.getByRole('tab', { name: 'Pit', exact: true }).click();
    await stalePage.getByTestId('pit-team-input').fill(String(team));
    await stalePage.getByTestId('pit-team-go').click();
    await expect(stalePage.getByTestId('pit-editing')).toBeVisible({ timeout: 15_000 });
    await advancePitToStep(stalePage, 6);
    await stalePage.locator('#pit-notes').fill('Stale competing edit');

    // Re-open the same team: the remote report hydrates as an editable revision.
    await page.getByTestId('pit-team-input').fill(String(team));
    await page.getByTestId('pit-team-go').click();
    await expect(page.getByTestId('pit-editing')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('pit-drivetrain')).toHaveValue('swerve');
    await advancePitToStep(page, 6);
    await expect(page.getByRole('img', { name: /Pit photo \d+ preview/ })).toHaveCount(2);
    await page.locator('#pit-notes').fill('Edited with a new detail photo');
    await page.getByTestId('pit-photo').setInputFiles({
      name: 'robot-detail.png',
      mimeType: 'image/png',
      buffer: TEST_PNG,
    });
    await expect(page.getByRole('img', { name: /Pit photo \d+ preview/ })).toHaveCount(3);
    await page.getByTestId('pit-photo-remove-1').click();
    await expect(page.getByRole('img', { name: /Pit photo \d+ preview/ })).toHaveCount(2);
    await expect(page.getByTestId('pit-submit')).toContainText('Save changes');
    await page.getByTestId('pit-submit').click();
    await expect(page.getByTestId('pit-team-input')).toBeVisible({ timeout: 15_000 });

    let finalPhotoIds: string[] = [];
    await expect.poll(async () => {
      const { data } = await admin
        .from('pit_scouting_report')
        .select('row_revision,notes,photos')
        .eq('event_key', EVENT)
        .eq('team_number', team)
        .single();
      const photos = Array.isArray(data?.photos) ? data.photos : [];
      finalPhotoIds = photos
        .map((photo) => (photo as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string');
      return {
        revisionAdvanced: Number(data?.row_revision ?? 0) > firstRevision,
        notes: data?.notes ?? null,
        photos: photos.length,
        uploaded: photos.every(
          (photo) => typeof (photo as { path?: unknown }).path === 'string',
        ),
      };
    }, { timeout: 25_000 }).toEqual({
      revisionAdvanced: true,
      notes: 'Edited with a new detail photo',
      photos: 2,
      uploaded: true,
    });
    expect(finalPhotoIds.some((id) => !initialPhotoIds.includes(id))).toBe(true);

    // Dashboard reads the final manifest and exposes every photo in its lightbox.
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('tab', { name: 'Team', exact: true }).click();
    await page.getByTestId('team-select').selectOption(String(team));
    await page.getByTestId('team-photo-thumb').click();
    await expect(page.getByRole('button', { name: 'Next pit photo' })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Next pit photo' }).click();
    await expect(page.getByAltText(/photo 2/i)).toBeVisible();

    await stalePage.getByTestId('pit-submit').click();
    await expect(stalePage.getByTestId('pit-team-input')).toBeVisible({ timeout: 15_000 });
    await expect(stalePage.getByTestId('sync-deadletters')).toHaveText('1', { timeout: 25_000 });
    const { data: afterConflict } = await admin
      .from('pit_scouting_report')
      .select('row_revision,notes,photos')
      .eq('event_key', EVENT)
      .eq('team_number', team)
      .single();
    expect(Number(afterConflict?.row_revision ?? 0)).toBeGreaterThan(firstRevision);
    expect(afterConflict?.notes).toBe('Edited with a new detail photo');
    expect(Array.isArray(afterConflict?.photos) ? afterConflict.photos.length : 0).toBe(2);
  } finally {
    await staleCtx?.close();
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// SCENARIO 7 — Re-scout the SAME target twice on ONE device. The second capture
// must SUPERSEDE the first (migration 0025): no dead-letter, exactly one active
// server row. Guards the previously data-losing one-active-report path.
// ---------------------------------------------------------------------------
test('re-scouting the same target supersedes without dead-lettering', async ({ browser }) => {
  test.setTimeout(180_000);
  const matchKey = '2026casnv_qm3';
  const team = 6814; // blue2 of qm3, distinct from scenario 1/3 targets
  const ctx = await browser.newContext({ storageState: E2E_AUTH_STATE_PATH });
  try {
    const page = await ctx.newPage();
    watch(page, 'rescout');
    await pick(page, NAMES[1]);
    await capture(page, matchKey, team, 1);
    await expectDrained(page);
    expect(await reportCount(matchKey, team)).toBe(1);
    // Capture the SAME target again (correction). Different local id → server
    // supersedes the prior active row.
    await capture(page, matchKey, team, 3);
    await expectDrained(page);
    expect(await reportCount(matchKey, team)).toBe(1);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// FINAL — No uncaught page errors fired in ANY context during the simulation.
// (Console errors are logged for triage but don't fail the run on their own.)
// ---------------------------------------------------------------------------
test('no uncaught runtime errors fired across the simulation', async () => {
  if (sink.consoleErrors.length) {
    console.log('--- console.error during simulation (triage) ---');
    for (const e of sink.consoleErrors) console.log(`[${e.who}] ${e.msg}`);
  }
  if (sink.pageErrors.length) {
    console.log('--- UNCAUGHT page errors ---');
    for (const e of sink.pageErrors) console.log(`[${e.who}] ${e.msg}`);
  }
  expect(sink.pageErrors, JSON.stringify(sink.pageErrors, null, 2)).toHaveLength(0);
});
