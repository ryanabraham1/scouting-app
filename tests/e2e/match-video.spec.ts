// tests/e2e/match-video.spec.ts
// Match video embeds (TBA YouTube): the dashboard embeds the official TBA-linked
// match video next to the activity timeline on MatchView (MatchVideoCard) and
// TeamView (LastMatchCard). Live TBA may or may not have a video for any given
// match, so these assert the card existence + one of the valid terminal states
// (frame / none / unavailable / error), never the iframe loading real media.
//
// Written as a feature-specific file (not appended to dashboard.spec.ts) to avoid
// merge friction with the other dash features. Reuses the same single-worker
// live-event harness: a shared admin client, the 2026casnv event key, and the
// setActiveEvent helper. Because workers: 1 and event.is_active is a shared
// singleton, each test sets the active event immediately before navigating.
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
  // The open (no-login) dashboard depends on migration 0009 (open RLS + scouter_roster).
  const probe = await admin.from('scouter_roster').select('id').limit(1);
  test.skip(!!probe.error, 'Apply migration 0009 (open RLS) to run the login-less dashboard flows.');
});

test.describe('match video', () => {
  test('match video card renders with a valid terminal state', async ({ page }) => {
    test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
    await setActiveEvent(admin, eventKey);
    await page.goto('/dashboard');
    await page.getByRole('tab', { name: 'Match', exact: true }).click();
    await page.locator('[data-testid^="match-item-"]').first().click();
    await expect(page.getByText('Match video')).toBeVisible(); // CardTitle
    // One of the terminal states must appear (frame, none, unavailable, or error).
    await expect(
      page
        .locator(
          '[data-testid="match-video-frame"], [data-testid="match-video-none"], [data-testid="match-video-unavailable"], [data-testid="match-video-error"]',
        )
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    // NOTE: do NOT assert match-sync-now is disabled. It is disabled only while
    // !hasTime; against live YouTube the IFrame API can load and report a
    // currentTime, flipping hasTime true and enabling the button — racy/time-
    // dependent. The terminal-state existence assertion above is the robust check.
  });

  test('watch-on-youtube link present when a video exists', async ({ page }) => {
    test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
    await setActiveEvent(admin, eventKey);
    await page.goto('/dashboard');
    await page.getByRole('tab', { name: 'Match', exact: true }).click();
    await page.locator('[data-testid^="match-item-"]').first().click();
    const frame = page.getByTestId('match-video-frame');
    if (await frame.count()) {
      const link = page.getByTestId('match-video-yt-link');
      await expect(link).toHaveAttribute('href', /^https:\/\/youtu\.be\//);
      await expect(link).toHaveAttribute('target', '_blank');
    } else {
      test.skip(true, 'live match has no TBA video yet');
    }
  });

  test('team view last-match card shows a video terminal state', async ({ page }) => {
    test.skip(!URL || !SECRET, 'Set VITE_SUPABASE_URL + SUPABASE_SECRET_KEY in .env.local.');
    await setActiveEvent(admin, eventKey);
    await page.goto('/dashboard');
    await page.getByRole('tab', { name: 'Team' }).click();
    // Team selection is a dropdown; index 1 skips the placeholder option.
    await page.getByTestId('team-select').selectOption({ index: 1 });
    // team-last-match only renders if the selected team has a scouted match.
    // Tolerate absence: only assert the embed states when the card is present.
    const card = page.getByTestId('team-last-match');
    if (await card.count()) {
      await expect(card).toBeVisible();
      await expect(
        page
          .locator(
            '[data-testid="match-video-frame"], [data-testid="match-video-none"], [data-testid="match-video-unavailable"]',
          )
          .first(),
      ).toBeVisible({ timeout: 15_000 });
    } else {
      test.skip(true, 'selected team has no scouted match (no last-match card)');
    }
  });
});
