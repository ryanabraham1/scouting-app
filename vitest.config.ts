import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [react(), VitePWA({ registerType: 'prompt' })],
  test: {
    globals: true,
    // React Router 7 no longer needs the AbortSignal compatibility wrapper that
    // older data routers required under Node's undici implementation.
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // Safe default: remote DB/function suites require the explicit
    // vitest.integration.config.ts guard.
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      // Pure contract test: no remote project or credentials required.
      'tests/functions/seed-demo-scoring.test.ts',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    // Coverage guardrail: measured over the app source only (the code this local
    // unit/contract suite is responsible for). The remote Edge Functions under
    // `supabase/functions/**` are Deno and covered by the integration suite
    // (`vitest.integration.config.ts`), so including them here would report a
    // false 0% and make thresholds meaningless. Run with `--coverage` in CI to
    // enforce the thresholds below; a drop fails the build.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      // Only measure app source, and count untested files (all: true) so a whole
      // new untested module drags the number down instead of hiding.
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        'src/main.tsx',
        'src/**/*.d.ts',
        'src/vite-env.d.ts',
        // Type-only barrels (no executable statements).
        'src/db/types.ts',
        'src/dash/types.ts',
        'src/admin/types.ts',
        'src/scoring/types.ts',
      ],
      // Thresholds are set at/just below the level the suite currently achieves
      // over `src/**` so future changes cannot silently erode coverage. Raise
      // these as coverage improves; never lower them to make a red build green.
      // Achieved over src/** (Jul 2026): lines 87.1, statements 87.1,
      // functions 81.4, branches 81.4. Set just below to leave a small buffer
      // against nondeterministic branches while still failing a real drop.
      thresholds: {
        lines: 86,
        functions: 80,
        branches: 80,
        statements: 86,
      },
    },
  },
});
