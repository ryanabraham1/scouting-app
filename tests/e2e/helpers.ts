// tests/e2e/helpers.ts — shared E2E helpers for the no-auth, roster-based flow.
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Make exactly one event active (mirrors the app's setActiveEvent). */
export async function setActiveEvent(admin: SupabaseClient, eventKey: string): Promise<void> {
  await admin.from('event').update({ is_active: false }).neq('event_key', eventKey);
  const { error } = await admin.from('event').update({ is_active: true }).eq('event_key', eventKey);
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
  await expect(page.getByTestId('scout-name-picker')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('scout-name-filter').fill(name);
  await page.getByTestId(`scout-name-option-${name}`).click();
  await expect(page.getByTestId('scout-manual-pick')).toBeVisible({ timeout: 15_000 });
}
