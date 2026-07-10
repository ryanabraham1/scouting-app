// tests/e2e/auto-path-heatmap.spec.ts
// Auto-path heatmap: the TeamView "Auto consistency" card stacks ALL of a team's
// stored autos into a density heatmap, and the NextMatchView broadcast carries a
// single shared Latest | All (heatmap) toggle above the alliance grid.
//
// Hits the SAME shared/mutable live event as dashboard.spec.ts. Single-worker
// (playwright.config workers: 1) so this never races the other live specs. Every
// assertion tolerates "no auto data at this event" by branching to the empty state.
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

test('TeamView shows the auto-consistency heatmap card for a reported team', async ({ page }) => {
  await setActiveEvent(admin, eventKey);

  // DERIVE the target team at runtime: prefer one with auto data so the heatmap
  // (not just the empty branch) mounts; never hardcode against the mutable DB.
  const { data: autoRows } = await admin
    .from('match_scouting_report')
    .select('target_team_number, auto_start_position, auto_path')
    .eq('event_key', eventKey)
    .eq('deleted', false)
    .limit(500);
  const withAuto = (autoRows ?? []).find(
    (r) =>
      r.auto_start_position != null ||
      (Array.isArray(r.auto_path) && r.auto_path.length > 0),
  );
  const target = withAuto?.target_team_number ?? autoRows?.[0]?.target_team_number;
  test.skip(target == null, 'No scouted reports at this event to drive the heatmap.');

  await page.goto('/dashboard?tab=team');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('dash-team')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('team-select').selectOption(String(target));
  await expect(page.getByTestId('team-detail')).toBeVisible({ timeout: 15_000 });

  // Current TeamView groups path shapes into distinct, selectable auto options.
  const card = page.getByTestId('team-auto-options-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText(/distinct autos?|No auto paths/);
});

test('Strategy whiteboard exposes one shared auto-overlay toggle', async ({ page }) => {
  await setActiveEvent(admin, eventKey);
  await page.goto('/dashboard?tab=strategy');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });

  const toggle = page.getByTestId('dash-strategy-autos-toggle');
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
});
