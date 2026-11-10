import { expect, test, type Page } from '@playwright/test';

const EVENT_KEY = 'offline_event';
const SCOUT_ID = 'offline-scout';

async function seedOfflineSchedule(page: Page): Promise<void> {
  await page.addInitScript(
    ({ eventKey, scoutId }) => {
      localStorage.setItem('active_event_key', eventKey);
      localStorage.setItem('my_scouter_name', 'Offline Scout');
      localStorage.setItem(
        'cached_scout_row',
        JSON.stringify({
          id: scoutId,
          event_key: eventKey,
          display_name: 'Offline Scout',
          auth_uid: 'offline-auth',
          created_at: '2026-09-12T12:00:00.000Z',
        }),
      );
    },
    { eventKey: EVENT_KEY, scoutId: SCOUT_ID },
  );
  await page.route('**/*.supabase.co/**', (route) => route.abort('internetdisconnected'));
  await page.goto('/scout');
  await page.getByTestId('scout-home').waitFor();
  await page.evaluate(
    async ({ eventKey, scoutId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('scouting-db');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(
        ['cachedMatches', 'cachedAssignments', 'cachedPitAssignments', 'cachedTeams', 'preloadMeta'],
        'readwrite',
      );
      tx.objectStore('cachedMatches').put({
        match_key: `${eventKey}_qm7`, event_key: eventKey, comp_level: 'qm', match_number: 7,
        scheduled_time: '2099-09-12T19:30:00.000Z', predicted_time: null,
        red1: 111, red2: 222, red3: 333, blue1: 444, blue2: 555, blue3: 666,
        actual_red_score: null, actual_blue_score: null, winner: null, result_synced_at: null,
      });
      tx.objectStore('cachedAssignments').put({
        id: `${eventKey}:${eventKey}_qm7:red:1`, event_key: eventKey, scout_id: scoutId,
        match_key: `${eventKey}_qm7`, alliance_color: 'red', station: 1,
        target_team_number: 111,
      });
      tx.objectStore('cachedPitAssignments').put({
        id: `${eventKey}:222:${scoutId}`, event_key: eventKey, team_number: 222,
        scout_id: scoutId, scout_name: 'Offline Scout', source: 'manual',
      });
      tx.objectStore('cachedPitAssignments').put({
        id: `${eventKey}:222:partner`, event_key: eventKey, team_number: 222,
        scout_id: 'partner', scout_name: 'Pit Partner', source: 'manual',
      });
      for (const [teamNumber, nickname] of [
        [111, 'Alpha'], [222, 'Beta'], [333, 'Gamma'],
        [444, 'Delta'], [555, 'Epsilon'], [666, 'Zeta'],
      ] as const) {
        tx.objectStore('cachedTeams').put({
          id: `${eventKey}:${teamNumber}`, event_key: eventKey, team_number: teamNumber, nickname,
        });
      }
      tx.objectStore('preloadMeta').put({
        key: eventKey,
        lastPreloadAt: '2026-09-12T19:00:00.000Z',
        counts: { matches: 1, assignments: 1, pitAssignments: 1, roster: 2, teams: 6 },
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      await navigator.serviceWorker.ready;
    },
    { eventKey: EVENT_KEY, scoutId: SCOUT_ID },
  );
  await page.context().setOffline(true);
  await page.reload();
}

test('shows the saved match schedule and queues a full match report offline', async ({ page }) => {
  await seedOfflineSchedule(page);
  await expect(page.getByTestId('station-menu-trigger')).toContainText('Hi, Offline');
  await page.getByRole('tab', { name: 'Matches', exact: true }).click();
  await expect(page.getByTestId('offline-schedule-status')).toHaveText('Schedule saved');
  await expect(page.getByTestId('scout-assignment')).toContainText('Qualification 7');
  await expect(page.getByTestId('scout-assignment')).toContainText('#111');
  await expect(page.getByTestId('scout-assignment-time')).not.toHaveText('Time TBD');

  await page.getByTestId('scout-assignment').click();
  await page.getByTestId('capture-half-clip').click();
  await page.getByTestId('capture-placement-submit').click();
  await page.getByTestId('capture-start').click();
  await page.getByTestId('capture-go').click();
  // Leaving Auto opens the live auto-path panel; close it to reach the controls.
  await page.getByTestId('capture-auto-path-done').click();
  await page.getByTestId('capture-to-review').click();
  const save = page.getByTestId('review-save');
  for (let step = 0; step < 7 && !(await save.isVisible()); step += 1) {
    await page.getByTestId('review-next').click();
  }
  await save.click();
  await expect(page.getByTestId('scout-home')).toBeVisible();
  await page.getByRole('tab', { name: 'Matches', exact: true }).click();
  await expect(page.getByTestId('sync-queued')).toContainText('1');
  const storedMatchReports = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('scouting-db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const request = db.transaction('reports').objectStore('reports').getAll();
    const rows = await new Promise<Array<{ syncState: string; lastSyncError: string | null }>>(
      (resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    db.close();
    return rows;
  });
  expect(storedMatchReports).toHaveLength(1);
  expect(storedMatchReports[0]).toMatchObject({ syncState: 'dirty', lastSyncError: null });
});

test('shows pit crews and queues a pit report offline', async ({ page }) => {
  await seedOfflineSchedule(page);
  await page.getByRole('tab', { name: 'Pit scouting', exact: true }).click();
  await expect(page.getByTestId('my-pit-assignments')).toContainText('222');
  await expect(page.getByTestId('my-pit-assignments')).toContainText('Pit Partner');
  await page.getByTestId('pit-assignment-222').click();
  await expect(page.getByTestId('pit-screen')).toBeVisible();

  const submit = page.getByTestId('pit-submit');
  for (let step = 0; step < 10 && !(await submit.isVisible()); step += 1) {
    await page.getByTestId('pit-next').click();
  }
  await submit.click();
  await expect(page.getByTestId('my-pit-assignments')).toContainText('Queued');
  const storedPitReports = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pit-scouting-db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const request = db.transaction('pitReports').objectStore('pitReports').getAll();
    const rows = await new Promise<Array<{ syncState: string; lastSyncError: string | null }>>(
      (resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    db.close();
    return rows;
  });
  expect(storedPitReports).toHaveLength(1);
  expect(storedPitReports[0]).toMatchObject({ syncState: 'dirty', lastSyncError: null });
});

for (const width of [360, 768, 1024, 1440]) {
  test(`scout layout stays stable across sections at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width >= 1024 ? 'dark' : 'light' });
    await seedOfflineSchedule(page);
    // A revised report with a long note reproduces the cramped list in the bug report.
    await page.evaluate(async ({ eventKey, scoutId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('scouting-db');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('reports', 'readwrite');
      for (const [index, syncState] of ['synced', 'dirty', 'error'].entries()) {
        tx.objectStore('reports').put({
          id: `layout-report-${index}`, eventKey, scoutId, scoutName: 'Offline Scout',
          matchKey: `${eventKey}_qm${53 - index}`, targetTeamNumber: 5940,
          createdAt: `2026-11-10T10:0${index}:00.000Z`, rowRevision: 2,
          syncState, fuelPoints: 120, defenseDurationMs: 12000, defendedDurationMs: 4500,
          notes: 'Great at intake, shooting, defending, and great agility. '.repeat(4) + 'LongNote'.repeat(30),
        });
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, { eventKey: EVENT_KEY, scoutId: SCOUT_ID });

    const header = page.getByTestId('scout-header');
    const initialHeader = await header.boundingBox();
    const nav = page.getByRole('tablist', { name: 'Scout sections' });
    const initialNav = width >= 768 ? await nav.boundingBox() : null;
    const destinations = [
      ['Matches', '/scout?tab=matches'],
      ['Pit scouting', '/scout?mode=pit'],
      ['Picklist', '/scout/picklist'],
      ['My data', '/my-data'],
      ['Sync & transfer', '/sync'],
      ['Home', '/scout'],
    ];
    for (const [label, path] of destinations) {
      if (width >= 768) await nav.getByRole('tab', { name: label, exact: true }).click();
      else await page.goto(path);
      await expect(header).toBeVisible();
      await expect(page.getByTestId('station-menu-trigger')).toContainText('Hi, Offline');
      await expect(page.getByTestId('app-search-trigger')).toBeVisible();
      await expect(page.getByTestId('scout-connection-pill')).toBeVisible();
      await expect.poll(() => header.boundingBox()).toEqual(initialHeader);
      if (initialNav) {
        await expect.poll(() => nav.boundingBox()).toEqual(initialNav);
        for (const label of await nav.locator('button span').all()) {
          expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        }
      } else await expect(page.getByTestId('scout-bottom-nav')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (path === '/my-data') {
        await expect(page.getByTestId('my-data-row')).toHaveCount(3);
        const badge = page.getByTestId('my-data-rev-layout-report-0');
        expect((await badge.boundingBox())!.height).toBeLessThan(30);
        const edit = page.getByTestId('my-data-edit-layout-report-0');
        await expect(edit).toBeVisible();
        expect((await edit.boundingBox())!.x + (await edit.boundingBox())!.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `test-results/scout-my-data-${width}.png`, fullPage: true });
      }
    }
    for (const path of ['/qr/send', '/qr/receive']) {
      await page.goto(path);
      await expect(header).toBeVisible();
      await expect.poll(() => header.boundingBox()).toEqual(initialHeader);
      if (initialNav) await expect.poll(() => nav.boundingBox()).toEqual(initialNav);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });
}
