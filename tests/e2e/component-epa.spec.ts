// tests/e2e/component-epa.spec.ts
// Component-EPA estimation (component-epa-estimation): the Match tab grows a
// "Scoring estimate" card decomposing each team's predicted points into
// auto/fuel/climb (+ a scouting-only defense line), and the Strategy tab carries
// a per-team component line. Both are presentational decompositions of the value
// the dashboard already shows — never new prediction numbers.
//
// Single-worker, live remote Supabase (2026casnv) — mirrors matchview-search.spec.ts.
// TOLERANT of the empty live event: when the selected match has no estimable data
// the card shows its empty line, and we still assert the CONTRACT (card present +
// labeled "estimate" + no crash), never a specific points value. test.skip with a
// logged reason whenever there's no selectable match, so a green run on an empty
// event is distinguishable from a real assertion (plan §13).
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
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (open RLS) to run the login-less dashboard flows.');
});

test('Match tab shows a labeled Scoring estimate card (tolerant of an empty event)', async ({
  page,
}) => {
  test.skip(!URL || !SECRET, 'env');
  await setActiveEvent(admin, eventKey);

  // A real match to select (key + a populated alliance slot).
  const { data: matches } = await admin
    .from('match')
    .select('match_key,red1')
    .eq('event_key', eventKey)
    .eq('comp_level', 'qm')
    .not('red1', 'is', null)
    .order('match_number', { ascending: true })
    .limit(1);
  const probe = matches?.[0] ?? null;

  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Match' }).click();
  await expect(page.getByTestId('dash-match')).toBeVisible({ timeout: 15_000 });

  // Empty live event: no schedule -> no selectable match. Skip with a reason so a
  // green run isn't a vacuous pass.
  test.skip(!probe, 'No match on the live event yet.');
  const matchKey = probe!.match_key as string;

  const item = page.getByTestId(`match-item-${matchKey}`);
  test.skip(!(await item.isVisible().catch(() => false)), 'Selectable match not rendered yet.');
  await item.click();

  // The card always renders for a selected match, and is labeled "estimate".
  const card = page.getByTestId('dash-match-estimate');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText(/estimate/i);

  // Either per-team component lines render OR the explicit empty line shows —
  // both are valid on an unplayed/unscouted event. Assert the contract, not numbers.
  const empty = page.getByTestId('dash-match-estimate-empty');
  const teamLine = page.getByTestId(`dash-match-estimate-team-${probe!.red1}`);
  const hasEmpty = await empty.isVisible().catch(() => false);
  const hasTeam = await teamLine.isVisible().catch(() => false);
  expect(hasEmpty || hasTeam).toBeTruthy();

  // Never crashes the route.
  await expect(page.getByTestId('route-error')).toHaveCount(0);
});

test('Strategy tab shows per-team component lines with rounding tolerance', async ({ page }) => {
  test.skip(!URL || !SECRET, 'env');
  await setActiveEvent(admin, eventKey);

  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Strategy' }).click();

  const noMatch = page.getByTestId('dash-strategy-no-match');
  if (await noMatch.isVisible().catch(() => false)) {
    test.skip(true, 'No next match on the live event.');
  }
  await expect(page.getByTestId('dash-strategy')).toBeVisible({ timeout: 15_000 });

  // Find a rendered team row; its expected + component line must reconcile within
  // ±1/component (3) on ROUNDED ints. The exact unrounded invariant is unit-tested.
  const expectedCells = page.getByTestId('dash-next-team-expected');
  const count = await expectedCells.count();
  test.skip(count === 0, 'No team rows rendered for the next match.');

  // Locate the first team row's number via its container testid.
  const firstRow = page.locator('[data-testid^="dash-next-team-"]').first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });
  const rowTestId = await firstRow.getAttribute('data-testid');
  const team = rowTestId?.replace('dash-next-team-', '');
  test.skip(!team || Number.isNaN(Number(team)), 'Could not resolve a team number.');

  const compLine = page.getByTestId(`dash-next-components-${team}`);
  await expect(compLine).toBeVisible({ timeout: 10_000 });

  const expectedText = (await firstRow.getByTestId('dash-next-team-expected').innerText()).trim();
  const compText = (await compLine.innerText()).trim();

  const expectedNum = Number((expectedText.match(/\d+/) ?? [])[0]);
  const compNums = (compText.match(/\d+/g) ?? []).map(Number);

  // Tolerate the source==='none' state ("auto — · fuel — · climb —").
  if (compNums.length === 3 && Number.isFinite(expectedNum)) {
    const sum = compNums[0] + compNums[1] + compNums[2];
    expect(Math.abs(expectedNum - sum)).toBeLessThanOrEqual(3);
  }

  await expect(page.getByTestId('route-error')).toHaveCount(0);
});
