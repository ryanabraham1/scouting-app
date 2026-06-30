import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { setActiveEvent } from './helpers';

// Build the service-role admin client locally, exactly as dashboard.spec.ts does
// (admin is NOT exported from helpers; only setActiveEvent is).
loadEnv();
const URL = process.env.VITE_SUPABASE_URL as string;
const SECRET = process.env.SUPABASE_SECRET_KEY as string;
const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { persistSession: false },
});

// Track unique markers we write so afterAll can clean them out of the shared live DB.
const writtenNoteMarkers: string[] = [];

test.afterAll(async () => {
  for (const marker of writtenNoteMarkers) {
    await admin.from('matchup_note').delete().like('note', `%${marker}%`);
  }
});

test('synthesis panel + per-opponent note PERSISTS TO SERVER and resurfaces', async ({ page }) => {
  await setActiveEvent(admin, '2026casnv');
  await page.goto('/dashboard'); // lands on Next Match tab (dash-next)
  await expect(page.getByTestId('dash-next')).toBeVisible();

  // 1. Synthesis panel renders below the win-prob banner.
  const panel = page.getByTestId('dash-matchup-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Alliance Matchup');

  // 2. Open notes, type, save.
  await panel.getByTestId('matchup-notes-btn').first().click();
  await expect(page.getByTestId('matchup-notes-textarea')).toBeVisible();
  const marker = `m8r-${Date.now()}`;
  const note = `deny feed lane ${marker}`;
  writtenNoteMarkers.push(marker);
  await page.getByTestId('matchup-notes-textarea').fill(note);
  await page.getByTestId('matchup-notes-save').click();

  // 3. Note shows inline + a badge appears for that matchup (local immediate).
  await expect(page.getByTestId('matchup-note-text').first()).toContainText('deny feed lane');
  await expect(page.getByTestId('matchup-note-badge').first()).toBeVisible();

  // 4. SERVER persistence — independent of any local cache. Poll the live DB via the
  //    admin client until the outbox has drained the write through upsert_matchup_note.
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('matchup_note')
          .select('note')
          .eq('event_key', '2026casnv')
          .like('note', `%${marker}%`);
        return data?.length ?? 0;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // 5. Resurface from SERVER ONLY: nuke local Dexie so the note cannot come from cache.
  await page.evaluate(() => indexedDB.deleteDatabase('scouting-db'));
  await page.reload();
  await expect(page.getByTestId('dash-matchup-panel')).toBeVisible();
  await expect(page.getByTestId('matchup-note-text').first()).toContainText('deny feed lane');
});

test('offline save shows the unsynced state, then drains when back online', async ({ page }) => {
  await setActiveEvent(admin, '2026casnv');
  await page.goto('/dashboard');
  await expect(page.getByTestId('dash-matchup-panel')).toBeVisible();

  // Go offline, save a note locally.
  await page.context().setOffline(true);
  const marker = `m8r-off-${Date.now()}`;
  const note = `offline note ${marker}`;
  writtenNoteMarkers.push(marker);
  await page.getByTestId('dash-matchup-panel').getByTestId('matchup-notes-btn').first().click();
  await expect(page.getByTestId('matchup-notes-textarea')).toBeVisible();
  await page.getByTestId('matchup-notes-textarea').fill(note);
  await page.getByTestId('matchup-notes-save').click();

  // The note shows inline immediately even while offline (Dexie-first).
  await expect(page.getByTestId('matchup-note-text').first()).toContainText('offline note');

  // Back online → the outbox drains the write to the server.
  await page.context().setOffline(false);
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('matchup_note')
          .select('note')
          .eq('event_key', '2026casnv')
          .like('note', `%${marker}%`);
        return data?.length ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
});
