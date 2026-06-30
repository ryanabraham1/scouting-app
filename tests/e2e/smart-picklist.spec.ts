// tests/e2e/smart-picklist.spec.ts
// Smart picklist: one-click "seed from top N by metric" + per-team DNP / avoid
// and structured first/second pick-tier flags, all inside the existing Picklist
// tab. Seeding is pure/offline (aggregates from the persisted query cache);
// DNP/tier are additive JSONB on the picklist `entries` and round-trip through
// the existing savePicklist upsert (no migration).
//
// SHARED STATE: this spec targets the SAME `2026casnv` picklist row and flips
// the global `event.is_active` singleton as `dashboard.spec.ts`. Under
// `workers: 1` files run serially; we replicate `dashboard.spec.ts`'s exact
// beforeAll/afterAll (setActiveEvent + delete picklist) so neither spec leaves a
// polluted picklist that would make the other's assertions flaky by file order.
//
// LIVE-DATA TOLERANT: the repo guarantees no fixed scouting rows for 2026casnv,
// so seed assertions are guarded on `pick-seed-empty` — when the live event has
// no scouted teams the dialog disables Seed and we assert that empty state
// instead. The DNP/tier round-trip works regardless (it seeds nothing; it adds a
// manual team like dashboard.spec.ts and flags it).
import { test, expect, type Page } from '@playwright/test';
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
  // The open (no-login) dashboard depends on migration 0009 (open RLS + roster).
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (open RLS) to run the login-less dashboard flows.');
  await admin.from('picklist').delete().eq('event_key', eventKey);
});
test.afterAll(async () => {
  await admin.from('picklist').delete().eq('event_key', eventKey);
});

/** Open the dashboard Picklist panel (IconTabs render role=tab buttons). */
async function openPicklist(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Picklist' }).click();
  await expect(page.getByTestId('dash-picklist')).toBeVisible({ timeout: 15_000 });
}

test('Scenario A — seed by expected points (replace) or empty-state when no data', async ({
  page,
}) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, eventKey);
  await openPicklist(page);

  await page.getByTestId('pick-seed-open').click();
  await expect(page.getByTestId('pick-seed-dialog')).toBeVisible();

  // If the live event has no scouted teams the dialog disables Seed.
  if (await page.getByTestId('pick-seed-empty').isVisible()) {
    await expect(page.getByTestId('pick-seed-confirm')).toBeDisabled();
    return;
  }

  await page.getByTestId('pick-seed-metric').selectOption('scoutingExpectedPoints');
  await page.getByTestId('pick-seed-topn').fill('8');
  await page.getByTestId('pick-seed-mode-replace').check();
  await page.getByTestId('pick-seed-confirm').click();

  // Dialog closes; the list is now non-empty and at most the requested top-N.
  await expect(page.getByTestId('pick-seed-dialog')).toBeHidden();
  const rows = page.locator('[data-testid^="pick-row-"]');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(8);
  // Row 1's rank cell shows "1".
  await expect(rows.first()).toContainText('1');
});

test('Scenario B — DNP + tier flags persist a Save round-trip', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, eventKey);
  await openPicklist(page);

  // Add a known team manually (mirrors dashboard.spec.ts) so the flags have a row
  // regardless of whether the live event has scouting data.
  const team = '254';
  await page.getByTestId('pick-add-input').fill(team);
  await page.getByTestId('pick-add').click();
  await expect(page.getByTestId(`pick-row-${team}`)).toBeVisible();

  // DNP toggle → badge appears.
  await page.getByTestId(`pick-dnp-${team}`).click();
  await expect(page.getByTestId(`pick-dnp-badge-${team}`)).toBeVisible();

  // Tier pill: — → 1st.
  const pill = page.getByTestId(`pick-tier-type-${team}`);
  await pill.click();
  await expect(pill).toHaveText('1st');

  await page.getByTestId('pick-save').click();
  await expect(page.getByTestId('pick-saved')).toBeVisible({ timeout: 10_000 });

  // Reload + reopen — JSONB round-trip + defensive read keep the flags.
  await openPicklist(page);
  await expect(page.getByTestId(`pick-dnp-badge-${team}`)).toBeVisible();
  await expect(page.getByTestId(`pick-tier-type-${team}`)).toHaveText('1st');

  // Cross-check the server payload carries the additive fields.
  const { data } = await admin
    .from('picklist')
    .select('entries')
    .eq('event_key', eventKey)
    .maybeSingle();
  const entries = (data?.entries ?? []) as Array<{
    teamNumber: number;
    dnp?: boolean;
    tierType?: string | null;
  }>;
  const e = entries.find((x) => x.teamNumber === 254);
  expect(e?.dnp).toBe(true);
  expect(e?.tierType).toBe('first');
});

test('Scenario C — EPA fallback note is tolerant of EPA availability', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, eventKey);
  await openPicklist(page);

  await page.getByTestId('pick-seed-open').click();
  await expect(page.getByTestId('pick-seed-dialog')).toBeVisible();

  if (await page.getByTestId('pick-seed-empty').isVisible()) {
    await expect(page.getByTestId('pick-seed-confirm')).toBeDisabled();
    return;
  }

  await page.getByTestId('pick-seed-metric').selectOption('epa');
  // When Statbotics/local EPA is unavailable the dialog shows the in-house note.
  if (await page.getByTestId('pick-seed-epa-note').isVisible()) {
    await expect(page.getByTestId('pick-seed-epa-note')).toContainText(/in-house/i);
  }
  // Either way seeding produces a non-empty list.
  await page.getByTestId('pick-seed-confirm').click();
  await expect(page.locator('[data-testid^="pick-row-"]').first()).toBeVisible();
});

test('Scenario D — append mode skips duplicates', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  await setActiveEvent(admin, eventKey);
  await openPicklist(page);

  // Seed top 4 (replace). Skip the rest when the live event has no scouting data.
  await page.getByTestId('pick-seed-open').click();
  await expect(page.getByTestId('pick-seed-dialog')).toBeVisible();
  if (await page.getByTestId('pick-seed-empty').isVisible()) {
    await expect(page.getByTestId('pick-seed-confirm')).toBeDisabled();
    return;
  }
  await page.getByTestId('pick-seed-metric').selectOption('scoutingExpectedPoints');
  await page.getByTestId('pick-seed-topn').fill('4');
  await page.getByTestId('pick-seed-mode-replace').check();
  await page.getByTestId('pick-seed-confirm').click();
  await expect(page.getByTestId('pick-seed-dialog')).toBeHidden();

  const after4 = await page.locator('[data-testid^="pick-row-"]').count();
  expect(after4).toBeGreaterThan(0);

  // Append top 6 — duplicates from the first seed must be skipped.
  await page.getByTestId('pick-seed-open').click();
  await page.getByTestId('pick-seed-topn').fill('6');
  await page.getByTestId('pick-seed-mode-append').check();
  await page.getByTestId('pick-seed-confirm').click();
  await expect(page.getByTestId('pick-seed-dialog')).toBeHidden();

  // No duplicate team rows (every pick-row testid is unique).
  const ids = await page.locator('[data-testid^="pick-row-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid')),
  );
  expect(new Set(ids).size).toBe(ids.length);
  // Count is monotonic and within the union bound (prior 4 + at most 6).
  expect(ids.length).toBeGreaterThanOrEqual(after4);
  expect(ids.length).toBeLessThanOrEqual(after4 + 6);
});
