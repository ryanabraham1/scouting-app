// tests/e2e/reconciliation.spec.ts — multi-scout reconciliation against the live
// remote (2026casnv). Mirrors admin.spec.ts for REAL scout-row seeding (NOT
// dashboard.spec.ts, which seeds nothing). Single-worker: the live DB is shared
// and we mutate the global active-event singleton, so the four-step FK-safe
// teardown is mandatory — leaking the sentinel team/event_team would contaminate
// dashboard.spec.ts / simulation.spec.ts, which iterate the event's teams.
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { setActiveEvent } from './helpers';

loadEnv({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;

const EVENT = '2026casnv';
const MATCH = `${EVENT}_qm1`; // qm1 exists on the seeded live event
const TEAM = 9999; // sentinel team, cleaned up in afterAll
const STATION = 2; // Blue 2

const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const scoutIds: string[] = [];

/**
 * Minimal valid match_scouting_report row shape (snake_case wire columns). The
 * server recomputes aggregates; these are the raw NOT-NULL fields plus the two
 * we diverge on (fuel_points, climb_*, no_show).
 */
function reportRow(scoutId: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    event_key: EVENT,
    match_key: MATCH,
    target_team_number: TEAM,
    alliance_color: 'blue',
    station: STATION,
    scout_id: scoutId,
    auto_fuel: 0,
    teleop_fuel_active: 0,
    teleop_fuel_inactive: 0,
    endgame_fuel: 0,
    fuel_points: 0,
    fuel_by_shift: [0, 0, 0, 0],
    climb_level: 0,
    climb_attempted: false,
    climb_success: false,
    auto_left_starting_line: false,
    auto_climb_level1: false,
    defense_rating: 0,
    pins: 0,
    no_show: false,
    died: false,
    tipped: false,
    dropped_fuel: false,
    fed_corral: false,
    deleted: false,
    ...overrides,
  };
}

test.beforeAll(async () => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (open RLS) to run the login-less dashboard flows.');

  await setActiveEvent(admin, EVENT);

  // FK-safe seeding order: team → event_team → scouts → reports.
  // 1. team row (FK target for the report + event_team).
  await admin.from('team').upsert({ team_number: TEAM, nickname: 'E2E Sentinel' });
  // 2. event_team so the team is selectable in TeamView's team-select.
  await admin.from('event_team').upsert({ event_key: EVENT, team_number: TEAM });
  // 3. two REAL scout rows (admin.spec.ts pattern) — capture their ids.
  for (let i = 1; i <= 2; i++) {
    const { data, error } = await admin
      .from('scout')
      .insert({ event_key: EVENT, display_name: `E2E Reconcile ${i}`, auth_uid: randomUUID() })
      .select('id')
      .single();
    if (error) throw error;
    scoutIds.push(data.id as string);
  }
  // 4. two divergent ACTIVE reports on the SAME robot, distinct scout_id:
  //    A: fuel 14, climb L3 success, no_show false
  //    B: fuel 4,  no climb,         no_show true   → severe (no-show + climb)
  const rows = [
    reportRow(scoutIds[0], { fuel_points: 14, climb_attempted: true, climb_success: true, climb_level: 3, no_show: false }),
    reportRow(scoutIds[1], { fuel_points: 4, climb_attempted: false, climb_success: false, climb_level: 0, no_show: true }),
  ];
  const { error } = await admin.from('match_scouting_report').insert(rows);
  if (error) throw error;
});

test.afterAll(async () => {
  if (!URL || !SECRET) return;
  // Reverse-FK teardown: reports → scouts → event_team → team. Mandatory — a
  // stray sentinel team/event_team contaminates other live specs.
  await admin
    .from('match_scouting_report')
    .delete()
    .eq('match_key', MATCH)
    .eq('target_team_number', TEAM);
  if (scoutIds.length) await admin.from('scout').delete().in('id', scoutIds);
  await admin.from('event_team').delete().eq('event_key', EVENT).eq('team_number', TEAM);
  await admin.from('team').delete().eq('team_number', TEAM);
});

test('multi-scout conflict surfaces in MatchView, ReportDetail, and TeamView', async ({ page }) => {
  test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');

  await setActiveEvent(admin, EVENT);

  // --- 1. MatchView conflict chip -----------------------------------------
  await page.goto('/dashboard');
  await page.getByRole('tab', { name: 'Match' }).click();
  await expect(page.getByTestId('dash-match')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId(`match-item-${MATCH}`).click();

  const chip = page.getByTestId(`match-conflict-${TEAM}-${STATION}`);
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip.getByTestId('conflict-marker')).toHaveAttribute('data-severity', 'severe');

  // Both member tiles visible via the disambiguated ids (the old undisambiguated
  // id would resolve to 2 elements and throw under strict mode).
  await expect(page.getByTestId(`match-report-${TEAM}-${STATION}-0`)).toBeVisible();
  await expect(page.getByTestId(`match-report-${TEAM}-${STATION}-1`)).toBeVisible();

  // --- 2. ReportDetail conflict banner + sibling swap ----------------------
  await page.getByTestId(`match-report-${TEAM}-${STATION}-0`).click();
  const banner = page.getByTestId('report-conflict');
  await expect(banner).toBeVisible({ timeout: 15_000 });

  const firstScout = await banner.getAttribute('data-scout-id');
  const firstNoShow = await page.getByTestId('report-flag-no-show').getAttribute('data-on');

  // Click the OTHER scout's sibling button to swap the Sheet content in place.
  const otherScout = scoutIds.find((id) => id !== firstScout) as string;
  await page.getByTestId(`report-conflict-sibling-${otherScout}`).click();

  // The banner now reflects the sibling, and the no-show pill flipped.
  await expect(page.getByTestId('report-conflict')).not.toHaveAttribute('data-scout-id', firstScout ?? '');
  await expect(page.getByTestId('report-flag-no-show')).not.toHaveAttribute('data-on', firstNoShow ?? '');

  // --- 3. TeamView conflict marker + filter --------------------------------
  await page.getByRole('tab', { name: 'Team' }).click();
  await expect(page.getByTestId('dash-team')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('team-select').selectOption(String(TEAM));

  await expect(page.getByTestId('team-conflict-summary')).toContainText('1 multi-scout conflict');

  await page.getByTestId('team-conflicts-only').check();
  await expect(page.getByTestId('team-conflict-marker').first()).toBeVisible();
  // openRow resets on toggle → nothing expanded.
  await expect(page.getByTestId('team-match-detail')).toHaveCount(0);

  await page.getByTestId('team-conflicts-only').uncheck();
});
