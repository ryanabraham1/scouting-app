// tests/e2e/alliance-simulator.spec.ts
// Alliance Simulator (Lead Dashboard tab): pick any 3 teams at the active event
// and see a projected alliance score, a win probability vs a baseline, and a
// role-gap table. Read-only — no DB writes, no cleanup. Single-worker, live remote.
//
// IMPORTANT: 2026casnv has 0 baseline match_scouting_report rows, so the pick
// buttons come from the roster/match-schedule UNION, not from scouted teams.
// We assert the pick count and skip with a clear message if too few teams exist,
// so the run is deterministic on the shared single-worker live DB.
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

test('simulate a 3-team alliance: score, cap+clear, win prob vs baseline', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  await setActiveEvent(admin, eventKey);
  // The simulator is intentionally hidden from the main tab bar but remains
  // available through its stable deep link for focused analysis.
  await page.goto('/dashboard?tab=alliance');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('tab', { name: 'Alliance' })).toHaveCount(0);
  await expect(page.getByTestId('dash-alliance')).toBeVisible({ timeout: 25_000 });

  // Prompt shown before 3 picks.
  await expect(page.getByTestId('alliance-prompt')).toBeVisible();

  // Pick buttons come from the roster/schedule union (2026casnv has 0 reports).
  const picks = page.locator('[data-testid^="alliance-pick-"]');
  const n = await picks.count();
  test.skip(n < 4, `2026casnv has only ${n} pickable teams — need >= 4 for the cap test`);

  // --- Scenario A: simulate a 3-team alliance ---
  await picks.nth(0).click();
  await picks.nth(1).click();
  await picks.nth(2).click();

  await expect(page.getByTestId('alliance-score')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('alliance-score-source')).toBeVisible();
  await expect(page.getByTestId('alliance-roles')).toBeVisible();

  const scoreTxt = await page.getByTestId('alliance-score').innerText();
  expect(Number(scoreTxt.replace(/[^\d.]/g, ''))).toBeGreaterThanOrEqual(0);

  // --- Scenario B: cap at 3 + clear ---
  // The 4th unselected pick button is disabled at cap.
  await expect(picks.nth(3)).toBeDisabled();
  await page.getByTestId('alliance-clear').click();
  await expect(page.getByTestId('alliance-prompt')).toBeVisible();

  // --- Scenario C: win prob vs baseline ---
  await picks.nth(0).click();
  await picks.nth(1).click();
  await picks.nth(2).click();
  await page.getByTestId('alliance-baseline-top').click();
  await expect(page.getByTestId('alliance-winprob')).toBeVisible();
  await expect(page.getByTestId('alliance-winprob')).toContainText('%');
});
