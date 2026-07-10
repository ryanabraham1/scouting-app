import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ensureStrategyMatchup, setActiveEvent } from './helpers';

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

test('distinct partner/opponent team notes persist to server and resurface', async ({ page }) => {
  await setActiveEvent(admin, '2026casnv');
  await page.goto('/dashboard?tab=strategy'); // the matchup panel lives on the Strategy tab
  await expect(page.getByTestId('dash-strategy')).toBeVisible();
  await ensureStrategyMatchup(page);

  // 1. One control per relevant team (normally our two partners + three opponents).
  const panel = page.getByTestId('dash-matchup-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Matchup notes by team');
  const redAlliance = panel.getByRole('region', { name: 'Red alliance strategy notes' });
  const blueAlliance = panel.getByRole('region', { name: 'Blue alliance strategy notes' });
  const redControls = redAlliance.getByTestId('matchup-notes-btn');
  const blueControls = blueAlliance.getByTestId('matchup-notes-btn');
  expect((await redControls.count()) + (await blueControls.count())).toBe(5);
  const controls = panel.getByTestId('matchup-notes-btn');
  await expect(controls).toHaveCount(5);
  const firstTarget = Number(await redControls.first().getAttribute('data-team'));
  const secondTarget = Number(await blueControls.first().getAttribute('data-team'));
  expect(firstTarget).toBeGreaterThan(0);
  expect(secondTarget).not.toBe(firstTarget);

  // 2. Save two different team notes.
  await redControls.first().click();
  await expect(page.getByTestId('matchup-notes-textarea')).toBeVisible();
  await expect(page.getByTestId('matchup-notes-sheet')).toContainText(
    `Strategy note for team ${firstTarget}`,
  );
  const marker1 = `m8r-${Date.now()}-a`;
  const marker2 = `m8r-${Date.now()}-b`;
  writtenNoteMarkers.push(marker1, marker2);
  await page.getByTestId('matchup-notes-textarea').fill(`first team note ${marker1}`);
  await page.getByTestId('matchup-notes-save').click();
  await blueControls.first().click();
  await expect(page.getByTestId('matchup-notes-sheet')).toContainText(
    `Strategy note for team ${secondTarget}`,
  );
  await page.getByTestId('matchup-notes-textarea').fill(`second team note ${marker2}`);
  await page.getByTestId('matchup-notes-save').click();

  // 3. SERVER persistence uses the reserved team namespace with distinct targets.
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('matchup_note')
          .select('opp_team,note')
          .eq('event_key', '2026casnv')
          .eq('our_team', -1)
          .in('opp_team', [firstTarget, secondTarget]);
        return new Set(
          (data ?? [])
            .filter((row) => row.note.includes(marker1) || row.note.includes(marker2))
            .map((row) => row.opp_team),
        ).size;
      },
      { timeout: 15_000 },
    )
    .toBe(2);

  // 4. Resurface both from SERVER ONLY: nuke local Dexie first.
  await page.evaluate(() => indexedDB.deleteDatabase('scouting-db'));
  await page.reload();
  await ensureStrategyMatchup(page);
  const reloaded = page.getByTestId('dash-matchup-panel');
  await expect(reloaded.getByRole('button', {
    name: `Edit strategy note for team ${firstTarget}`,
  })).toContainText(marker1);
  await expect(reloaded.getByRole('button', {
    name: `Edit strategy note for team ${secondTarget}`,
  })).toContainText(marker2);
});

test('offline save shows the unsynced state, then drains when back online', async ({ page }) => {
  await setActiveEvent(admin, '2026casnv');
  await page.goto('/dashboard?tab=strategy');
  await ensureStrategyMatchup(page);
  await expect(page.getByTestId('dash-matchup-panel')).toBeVisible();

  // Go offline, save a note locally.
  await page.context().setOffline(true);
  const target = Number(
    await page
      .getByTestId('dash-matchup-panel')
      .getByTestId('matchup-notes-btn')
      .first()
      .getAttribute('data-team'),
  );
  const marker = `m8r-off-${Date.now()}`;
  const note = `offline note ${marker}`;
  writtenNoteMarkers.push(marker);
  await page.getByTestId('dash-matchup-panel').getByTestId('matchup-notes-btn').first().click();
  await expect(page.getByTestId('matchup-notes-textarea')).toBeVisible();
  await page.getByTestId('matchup-notes-textarea').fill(note);
  await page.getByTestId('matchup-notes-save').click();
  const targetControl = page.getByRole('button', {
    name: `Edit strategy note for team ${target}`,
  });
  await expect(targetControl).toContainText(marker);
  await targetControl.click();
  await expect(page.getByTestId('matchup-notes-textarea')).toHaveValue(note);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // The write is present in the local outbox while offline.
  await expect.poll(async () =>
    page.evaluate(async (needle) => {
      // Inspect IndexedDB directly: dynamically importing a Vite module while
      // the browser is offline would itself require a network request.
      const rows = await new Promise<Array<{ note: string; syncState: string }>>(
        (resolve, reject) => {
          const request = indexedDB.open('scouting-db');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('matchupNotes', 'readonly');
            const getAll = tx.objectStore('matchupNotes').getAll();
            getAll.onerror = () => reject(getAll.error);
            getAll.onsuccess = () => resolve(getAll.result);
          };
        },
      );
      return rows.some((row) => row.note.includes(needle) && row.syncState === 'dirty');
    }, marker),
  ).toBe(true);

  // Back online → the outbox drains the write to the server.
  await page.context().setOffline(false);
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('matchup_note')
          .select('note')
          .eq('event_key', '2026casnv')
          .eq('our_team', -1)
          .eq('opp_team', target)
          .like('note', `%${marker}%`);
        return data?.length ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
});
