// tests/e2e/matchview-search.spec.ts
// MatchView search/label/order changes: the match list labels playoff sets so
// they aren't all "Semi 1", sorts quals before playoffs, and offers a single
// search box that filters by team number OR match label/number, with an
// empty-search state. Single-worker, live remote Supabase (2026casnv) — mirrors
// dashboard.spec.ts setup. Tolerant of an empty live event (guards/skips when
// the schedule has no matches yet).
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

test('MatchView search filters the match list and shows an empty state', async ({ page }) => {
  test.skip(!URL || !SECRET, 'env');
  await setActiveEvent(admin, eventKey);

  // Resolve a real match (key + number + a red team) to drive the search box.
  const { data: matches } = await admin
    .from('match')
    .select('match_key,match_number,comp_level,red1')
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

  // The search box is always present once the shell renders.
  const search = page.getByTestId('match-search');
  // Empty live event: no schedule → no search box (the "none" state shows instead).
  test.skip(!(await search.isVisible().catch(() => false)) || !probe, 'Live event has no schedule yet.');

  const matchKey = probe!.match_key as string;

  // Filter by the match's red-1 team number — the match for that team survives.
  await search.fill(String(probe!.red1));
  await expect(page.getByTestId(`match-item-${matchKey}`)).toBeVisible({ timeout: 10_000 });

  // A nonsense query yields the empty-search state, not a crash.
  await search.fill('zzz-no-such-match');
  await expect(page.getByTestId('match-search-empty')).toBeVisible({ timeout: 10_000 });

  // Clearing the search restores the list.
  await search.fill('');
  await expect(page.getByTestId('match-list')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('route-error')).toHaveCount(0);
});
