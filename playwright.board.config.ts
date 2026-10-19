import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/board', workers: 1, timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:5175', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'ipad', use: { ...devices['iPad Pro 11'], defaultBrowserType: 'chromium' } }],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5175', url: 'http://127.0.0.1:5175', reuseExistingServer: !process.env.CI },
});
