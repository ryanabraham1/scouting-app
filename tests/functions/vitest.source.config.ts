import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Explicitly source-local: do not load .env.local or initialize Supabase clients.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: [
      'tests/functions/readJsonBody.test.ts',
      'tests/functions/seed-demo-scoring.test.ts',
    ],
  },
});
