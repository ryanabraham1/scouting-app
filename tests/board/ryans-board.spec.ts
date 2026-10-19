import { expect, test } from '@playwright/test';

test('offline board: search, comments, ink, reload, presentation and PNG', async ({ page }) => {
  await page.goto('/tests/fixtures/ryans-board.html');
  const canvas = page.getByTestId('board-canvas');
  await expect(canvas).toBeVisible();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill('cheesy');
  await page.getByRole('textbox', { name: 'Search', exact: true }).press('Enter');
  await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Comment (C)', exact: true }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 160, box.y + 110);
  await page.getByRole('textbox', { name: 'Reply', exact: true }).fill('Watch the feed lane.');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByText('Watch the feed lane.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close comments', exact: true }).click();
  await page.getByRole('button', { name: 'Pen (P)', exact: true }).click();
  await page.mouse.move(box.x + 220, box.y + 90);
  await page.mouse.down();
  await page.mouse.move(box.x + 340, box.y + 140, { steps: 12 });
  await page.mouse.up();
  await expect(canvas.locator('[data-shape-id]')).toHaveCount(3);
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('scouting-db'); r.onsuccess = () => resolve(r.result); });
    const result = await new Promise<number>((resolve) => { const r = db.transaction('boardRecords').objectStore('boardRecords').count(); r.onsuccess = () => resolve(r.result); });
    db.close(); return result;
  })).toBe(3);
  await page.reload();
  await expect(canvas.locator('[data-shape-id]')).toHaveCount(3);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('ryans-board-_ryans_board_fixture.png');
  await page.getByRole('button', { name: 'Present board', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: 'Board tools' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: 'Board tools' })).toBeVisible();
});

test('schedule rows drag out into match cards, videos load on demand, and notes stay readable', async ({ page }) => {
  await page.goto('/tests/fixtures/ryans-board.html');
  const search = async (query: string): Promise<void> => {
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search', exact: true }).fill(query);
    await page.getByRole('textbox', { name: 'Search', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Close widget settings', exact: true }).click();
  };
  await search('254 schedule');
  const row = page.locator('[data-widget-kind="schedule"]').getByRole('button', { name: 'Pin qm1 details', exact: true });
  await row.dragTo(page.getByTestId('board-canvas'), { targetPosition: { x: 540, y: 330 } });
  const match = page.locator('[data-widget-kind="match"]');
  await expect(match).toHaveCount(1);
  await page.getByRole('button', { name: 'Close widget settings', exact: true }).click();
  await match.getByRole('button', { name: 'Pin qm1 video', exact: true }).click();
  const video = page.locator('[data-widget-kind="matchVideo"]');
  await expect(video.getByRole('button', { name: 'Load qm1 video', exact: true })).toBeVisible();
  await expect(video.locator('iframe')).toHaveCount(0);
  expect(await page.getByTestId('board-canvas').evaluate((el) => el.scrollTop + el.scrollLeft)).toBe(0);
  await page.getByRole('button', { name: 'Close widget settings', exact: true }).click();
  await video.getByRole('button', { name: 'Load qm1 video', exact: true }).click();
  await expect(video.getByTestId('match-video-none')).toBeVisible();
  await search('254 notes');
  await expect(page.locator('[data-widget-kind="teamNotes"]')).toContainText('Strong defense in the feed lane.');
  await expect(page.locator('[data-widget-kind="teamNotes"]')).toContainText('Protect the feed lane.');
  await search('254 pit');
  await expect(page.locator('[data-widget-kind="pit"]')).toContainText('Fast floor pickup');
});
