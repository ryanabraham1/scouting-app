// tests/e2e/scouter-load-accuracy.spec.ts
// Scouter load + accuracy-vs-consensus (Dashboard → Scouters tab).
//
// Hits the live remote Supabase single-worker. Manages the shared
// `event.is_active` singleton explicitly and RESTORES 2026casnv in afterAll so
// sibling specs are left in the state they expect (CLAUDE.md). The demo/real
// events seed exactly one report per (match, team) → zero overlaps, so this
// spec SEEDS a deterministic overlap (a 2nd report for an already-scouted
// (match, team) under a different scout_id) to exercise real accuracy numbers,
// then deletes it in afterAll.
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

// Track seeded overlap rows for cleanup.
const seededIds: string[] = [];
// The display name of the scout whose row we seed an overlap onto.
let overlapScoutName: string | null = null;

test.beforeAll(async () => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (open RLS) to run the login-less dashboard flows.');
});

test.afterAll(async () => {
  if (!URL || !SECRET) return;
  // Remove the seeded overlap rows.
  for (const id of seededIds) {
    await admin.from('match_scouting_report').delete().eq('id', id);
  }
  // Restore the shared singleton to the state sibling specs expect.
  await setActiveEvent(admin, eventKey);
});

test('Scenario A — Load card renders with real reports', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  await setActiveEvent(admin, eventKey);

  await page.goto('/dashboard?tab=scouters');
  await expect(page.getByTestId('dash-scouters')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('scouter-load-card')).toBeVisible({ timeout: 15_000 });

  // Total reports tile shows a numeric value > 0 (event has real scouting data).
  const totalText = await page.getByTestId('scouter-load-total').innerText();
  const total = parseInt(totalText.replace(/[^0-9]/g, ''), 10);
  expect(total).toBeGreaterThan(0);
});

test('Scenario B — Accuracy renders real numbers on a seeded overlap', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  await setActiveEvent(admin, eventKey);

  // Pick one already-played, non-deleted report to clone (select('*') so we can
  // satisfy all NOT NULL columns without guessing the schema).
  const baseRes = await admin
    .from('match_scouting_report')
    .select('*')
    .eq('event_key', eventKey)
    .eq('deleted', false)
    .limit(1)
    .single();
  test.skip(!!baseRes.error || !baseRes.data, 'No base report at 2026casnv to seed an overlap from.');
  const base = baseRes.data as Record<string, unknown>;

  // Find a SECOND, different scout_id at the event.
  const scoutsRes = await admin.from('scout').select('id, display_name').eq('event_key', eventKey);
  test.skip(!!scoutsRes.error || !scoutsRes.data, 'Could not read scouts at 2026casnv.');
  const scouts = (scoutsRes.data ?? []) as { id: string; display_name: string | null }[];
  const other = scouts.find((s) => s.id !== base.scout_id);
  test.skip(!other, 'No second scout_id at 2026casnv to create an overlap.');
  overlapScoutName = other!.display_name ?? '(unnamed)';

  // Build a divergent clone under the second scout so consensus + agreement are
  // non-trivial. Drop DB-generated columns; assign a fresh id we keep for cleanup.
  const id = crypto.randomUUID();
  const clone: Record<string, unknown> = { ...base };
  delete clone.created_at;
  delete clone.updated_at;
  delete clone.server_received_at;
  clone.id = id;
  clone.scout_id = other!.id;
  clone.deleted = false;
  clone.no_show = false;
  clone.died = false;
  // Divergent values (clamped within real domains): fuel offset + defense ordinal.
  clone.fuel_points = ((base.fuel_points as number) ?? 0) + 40;
  clone.defense_rating = (((base.defense_rating as number) ?? 0) + 2) % 4;
  clone.climb_success = !(base.climb_success as boolean);

  const ins = await admin.from('match_scouting_report').insert(clone);
  test.skip(!!ins.error, `Could not seed overlap row: ${ins.error?.message ?? ''}`);
  seededIds.push(id);

  await page.goto('/dashboard?tab=scouters');
  await expect(page.getByTestId('dash-scouters')).toBeVisible({ timeout: 15_000 });

  // Open the overlapped scouter's row (the second scout we seeded onto).
  const opener = page.getByTestId(`scouter-open-${overlapScoutName}`);
  await expect(opener).toBeVisible({ timeout: 15_000 });
  await opener.click();
  await expect(page.getByTestId('scouter-profile')).toBeVisible({ timeout: 15_000 });

  // Real-number path: the overall badge is visible and shows a percentage.
  await expect(page.getByTestId('scouter-accuracy')).toBeVisible();
  const overall = page.getByTestId('scouter-accuracy-overall');
  await expect(overall).toBeVisible();
  await expect(overall).toHaveText(/%/);
  // The provisional chip MAY be present (~1 overlap) — that is fine, not asserted.
});

test('Scenario C — Accuracy degrades gracefully with no overlap', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  await setActiveEvent(admin, eventKey);

  await page.goto('/dashboard?tab=scouters');
  await expect(page.getByTestId('dash-scouters')).toBeVisible({ timeout: 15_000 });

  // Open the first scouter row that has reports. Whatever its overlap status,
  // the accuracy section must render either real numbers or the none message —
  // never blank.
  const openers = page.locator('[data-testid^="scouter-open-"]');
  await expect(openers.first()).toBeVisible({ timeout: 15_000 });
  const count = await openers.count();
  let opened = false;
  for (let i = 0; i < count; i++) {
    const btn = openers.nth(i);
    if (await btn.isDisabled()) continue;
    await btn.click();
    if (await page.getByTestId('scouter-profile').isVisible().catch(() => false)) {
      opened = true;
      break;
    }
  }
  test.skip(!opened, 'No openable scouter with a profile at this event.');

  await expect(page.getByTestId('scouter-accuracy')).toBeVisible({ timeout: 15_000 });
  const hasOverall = await page.getByTestId('scouter-accuracy-overall').isVisible().catch(() => false);
  const hasNone = await page.getByTestId('scouter-accuracy-none').isVisible().catch(() => false);
  expect(hasOverall || hasNone).toBe(true);
});

test('Scenario D — No active event hides the Load card', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  // Clear ALL active flags — race-safe way to reach a no-event state on the
  // shared single-worker DB. afterAll restores 2026casnv.
  await admin.from('event').update({ is_active: false }).neq('event_key', '__none__');

  await page.goto('/dashboard?tab=scouters');
  await expect(page.getByTestId('scouters-no-event')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('scouter-load-card')).toHaveCount(0);
});
