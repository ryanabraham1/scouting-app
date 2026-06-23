import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/db/**/*.test.ts', 'tests/functions/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
