import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { assertDedicatedRemoteTestProject } from './tests/remoteTestSafety';

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;
loadEnv({ path: '.env.local' });
process.env.E2E_RUN_ID ??= `${Date.now()}_${process.pid}`;
assertDedicatedRemoteTestProject();

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Single worker: the live specs share one remote DB and mutate a global
  // singleton (event.is_active). Parallel files would stomp it — serialize them.
  workers: 1,
  retries: 0,
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'on-first-retry',
    storageState: 'test-results/e2e-auth-state.json',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
