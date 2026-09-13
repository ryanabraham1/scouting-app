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
  await expect(page.getByRole('heading', { name: 'Offline Scout' })).toBeVisible();
  await expect(page.getByTestId('offline-schedule-status')).toHaveText('Schedule saved');
  await expect(page.getByTestId('scout-assignment')).toContainText('Qualification 7');
  await expect(page.getByTestId('scout-assignment')).toContainText('#111');
  await expect(page.getByTestId('scout-assignment-time')).not.toHaveText('Time TBD');

  await page.getByTestId('scout-assignment').click();
  await page.getByTestId('capture-half-clip').click();
  await page.getByTestId('capture-placement-submit').click();
  await page.getByTestId('capture-start').click();
  await page.getByTestId('capture-go').click();
  await page.getByTestId('capture-to-review').click();
  const save = page.getByTestId('review-save');
  for (let step = 0; step < 7 && !(await save.isVisible()); step += 1) {
    await page.getByTestId('review-next').click();
  }
  await save.click();
  await expect(page.getByTestId('scout-home')).toBeVisible();
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
  await page.getByRole('tab', { name: 'Pit', exact: true }).click();
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
