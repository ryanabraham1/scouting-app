// Live test: the shared config refuses non-dedicated Supabase projects.
// Never run the remote e2e suite against a live competition database.
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { E2E_EVENT_KEY } from './global-setup';
import { setActiveEvent } from './helpers';

test('board ink survives reload and reaches another tab within three seconds', async ({ page, context }) => {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  test.skip(!url || !key, 'Requires the dedicated remote test project.');
  const admin = createClient(url!, key!, { auth: { persistSession: false } });
  await setActiveEvent(admin, E2E_EVENT_KEY);
  const open = async (p: Page): Promise<void> => {
    await p.goto('/dashboard?tab=board');
    await p.getByRole('textbox', { name: 'Lead dashboard code' }).fill('12345');
    await p.getByRole('button', { name: 'Unlock dashboard', exact: true }).click();
    await expect(p.getByTestId('board-canvas')).toBeVisible();
  };
  const peer = await context.newPage();
  await open(page);
  await open(peer);
  await page.getByRole('button', { name: 'Pen (P)', exact: true }).click();
  const b = (await page.getByTestId('board-canvas').boundingBox())!;
  await page.mouse.move(b.x + 180, b.y + 140);
  await page.mouse.down();
  await page.mouse.move(b.x + 350, b.y + 200, { steps: 15 });
  await page.mouse.up();
  const shape = page.locator('[data-shape-id]').last();
  const id = await shape.getAttribute('data-shape-id');
  await expect(peer.locator(`[data-shape-id="${id}"]`)).toBeVisible({ timeout: 3000 });
  await page.reload();
  await expect(page.locator(`[data-shape-id="${id}"]`)).toBeVisible();
});
