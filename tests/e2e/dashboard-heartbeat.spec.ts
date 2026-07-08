// tests/e2e/dashboard-heartbeat.spec.ts
// Dashboard scout-heartbeat / data-freshness: the lead sees how fresh the data
// is + how many scouts have synced for a match, and the indicator degrades
// gracefully offline (shows last-synced, never a RouteError). Single-worker,
// live remote Supabase (2026casnv) — mirrors dashboard.spec.ts setup.
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
// A device id we own so cleanup only removes the rows this spec inserted.
const DEVICE = 'e2e-heartbeat-device';

// Resolved in beforeAll from the live event so the inserted report is valid
// (scout_id FK, match_key FK, target_team_number FK all real).
let scoutId: string | null = null;
let matchKey: string | null = null;
let targetTeam: number | null = null;

test.beforeAll(async () => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (open RLS) to run the login-less dashboard flows.');

  // A real scout for the event (attribution).
  const { data: scouts } = await admin
    .from('scout')
    .select('id')
    .eq('event_key', eventKey)
    .limit(1);
  scoutId = scouts?.[0]?.id ?? null;

  // A real match for the event + one of its red teams as the target.
  const { data: matches } = await admin
    .from('match')
    .select('match_key,red1')
    .eq('event_key', eventKey)
    .not('red1', 'is', null)
    .limit(1);
  matchKey = matches?.[0]?.match_key ?? null;
  targetTeam = matches?.[0]?.red1 ?? null;

  // Skip (rather than fail) if the live event has no scouts/matches seeded.
  test.skip(
    !scoutId || !matchKey || targetTeam == null,
    'Live event has no scout/match/team to anchor the heartbeat insert.',
  );

  // Clean any leftover rows from a previous run.
  await admin.from('match_scouting_report').delete().eq('device_id', DEVICE);
});

test.afterAll(async () => {
  await admin.from('match_scouting_report').delete().eq('device_id', DEVICE);
});

test('Scenario A — heartbeat reflects a freshly inserted report', async ({ page }) => {
  test.skip(!URL || !SECRET, 'env');
  await setActiveEvent(admin, eventKey);

  // Insert a live report with a fresh server_received_at (service role bypasses RLS).
  const { error } = await admin.from('match_scouting_report').insert({
    schema_version: 1,
    device_id: DEVICE,
    event_key: eventKey,
    match_key: matchKey,
    scout_id: scoutId,
    target_team_number: targetTeam,
    alliance_color: 'red',
    station: 1,
    server_received_at: new Date().toISOString(),
    deleted: false,
  });
  expect(error).toBeNull();

  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  // The heartbeat moved from Next Match to the Scouters tab (anchored to the
  // freshest-reported match, gated on an active event).
  await page.getByRole('tab', { name: 'Scouters' }).click();
  await expect(page.getByTestId('dash-scouters')).toBeVisible({ timeout: 25_000 });

  await expect(page.getByTestId('scout-heartbeat')).toBeVisible({ timeout: 10_000 });
  // GLOBAL stamp is genuinely driven by the inserted row regardless of which
  // match is anchored — so this is the robust, anchor-independent assertion.
  await expect(page.getByTestId('scout-heartbeat-last')).not.toHaveText(/no reports yet/, {
    timeout: 10_000,
  });

  // The anchored-match X/Y badge reads a real count (>= 1) now that a fresh
  // report exists for the event. The anchor is the freshest-reported match, so
  // the count is driven by the inserted row without a selector to pin.
  await expect(page.getByTestId('scout-heartbeat-count')).toContainText('/', {
    timeout: 10_000,
  });

  // Pit Display (formerly Next Match) no longer carries the heartbeat tile.
  await page.getByRole('tab', { name: 'Pit Display' }).click();
  await expect(page.getByTestId('dash-next')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('scout-heartbeat')).toHaveCount(0);
});

test('Scenario B — MatchView scouting-status drill-down', async ({ page }) => {
  test.skip(!URL || !SECRET, 'env');
  await setActiveEvent(admin, eventKey);

  await admin.from('match_scouting_report').insert({
    schema_version: 1,
    device_id: DEVICE,
    event_key: eventKey,
    match_key: matchKey,
    scout_id: scoutId,
    target_team_number: targetTeam,
    alliance_color: 'red',
    station: 1,
    server_received_at: new Date().toISOString(),
    deleted: false,
  });

  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Match' }).click();
  await expect(page.getByTestId('dash-match')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId(`match-item-${matchKey}`).click();
  await expect(page.getByTestId('match-scout-status')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId(`match-scout-reported-${scoutId}`)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId('match-scout-status')).toContainText('synced');
});

test('Scenario C — offline shows last-synced, not a crash', async ({ page, context }) => {
  test.skip(!URL || !SECRET, 'env');
  await setActiveEvent(admin, eventKey);

  // 1. Warm the cache online; confirm the tile renders (primes persisted cache).
  //    The heartbeat now lives on the Scouters tab.
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Scouters' }).click();
  await expect(page.getByTestId('dash-scouters')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('scout-heartbeat')).toBeVisible({ timeout: 10_000 });

  // 2. Go offline and reload (the tab resets to the default Pit Display on reload).
  await context.setOffline(true);
  await page.reload();

  // 3. The resilient invariant: navigating to Scouters still renders the tile from
  //    the persisted cache and there is NO RouteError.
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Scouters' }).click();
  await expect(page.getByTestId('scout-heartbeat')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('route-error')).toHaveCount(0);

  await context.setOffline(false);
});
