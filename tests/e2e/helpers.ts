// tests/e2e/helpers.ts — shared E2E helpers for the no-auth, roster-based flow.
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Make exactly one event active (mirrors the app's setActiveEvent). */
export async function setActiveEvent(admin: SupabaseClient, eventKey: string): Promise<void> {
  const { error } = await admin.rpc('set_active_event', { p_event_key: eventKey });
  if (error) throw new Error(`setActiveEvent failed: ${error.message}`);
}

/** Ensure a roster name exists (idempotent — ignores duplicate 23505). */
export async function ensureRosterName(admin: SupabaseClient, name: string): Promise<void> {
  // Unique index is on lower(name) (expression index) — on_conflict can't target it;
  // plain insert and tolerate the duplicate, mirroring the app's addScouter.
  const { error } = await admin.from('scouter_roster').insert({ name });
  if (error && error.code !== '23505') {
    throw new Error(`ensureRosterName failed: ${error.message}`);
  }
}

/**
 * Onboard as a scouter via the login-less name picker, landing on the scouting
 * home. Requires an active event + the name present on the roster.
 */
export async function pickScouter(page: Page, name: string): Promise<void> {
  await page.goto('/scout');
  await expect(
    page.locator('[data-testid="scout-name-picker"], [data-testid="scout-manual-pick"]').first(),
  ).toBeVisible({ timeout: 15_000 });
  if (await page.getByTestId('scout-manual-pick').isVisible().catch(() => false)) {
    if (await page.getByRole('heading', { name, exact: true }).isVisible().catch(() => false)) return;
    await page.getByRole('button', { name: /^Log out / }).click();
    await page.getByTestId('scout-logout-confirm').click();
  }
  await expect(page.getByTestId('scout-name-picker')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('scout-name-filter').fill(name);
  await page.getByTestId(`scout-name-option-${name}`).click();
  await expect(page.getByTestId('scout-manual-pick')).toBeVisible({ timeout: 15_000 });
}

/** Ensure Strategy has a complete six-team matchup even after an event ends. */
export async function ensureStrategyMatchup(page: Page): Promise<void> {
  await expect(page.getByTestId('dash-strategy')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Analytics', exact: true }).click();
  if (await page.getByTestId('dash-matchup-panel').isVisible().catch(() => false)) return;

  await page.getByTestId('dash-strategy-edit-teams').click();
  const teams = {
    'manual-team-red1': '254',
    'manual-team-red2': '100',
    'manual-team-red3': '581',
    'manual-team-blue1': '3256',
    'manual-team-blue2': '10372',
    'manual-team-blue3': '6814',
  };
  for (const [testid, team] of Object.entries(teams)) {
    await page.getByTestId(testid).fill(team);
  }
  await page.getByTestId('manual-teams-apply').click();
  await page.getByRole('tab', { name: 'Analytics', exact: true }).click();
  await expect(page.getByTestId('dash-matchup-panel')).toBeVisible({ timeout: 15_000 });
}
