import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'vitest/config';
import { assertDedicatedRemoteTestProject } from './tests/remoteTestSafety';

loadEnv({ path: '.env.local' });
assertDedicatedRemoteTestProject();

export default defineConfig({
  test: {
    globals: true,
    environment: './vitest-env-jsdom-compat.ts',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/db/**/*.test.ts', 'tests/functions/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    fileParallelism: false,
  },
});
