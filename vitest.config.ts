import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [react(), VitePWA({ registerType: 'prompt' })],
  test: {
    globals: true,
    environment: './vitest-env-jsdom-compat.ts',
    setupFiles: ['./vitest.setup.ts'],
    // Safe default: remote DB/function suites require the explicit
    // vitest.integration.config.ts guard.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
