# Phase 0: Foundation & Contracts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the offline-first PWA skeleton, the Supabase schema/RLS/triggers/RPCs, the versioned scoring/compute/migration module, and the Edge Function proxies — the shared contracts every later phase builds on.

**Architecture:** Offline-first PWA (React + Vite) with a local-first store; Supabase (Postgres + RLS + Edge Functions) is the eventual destination reached via a **revision-guarded idempotent write path**. A single, isolated **scoring/compute/migration module** is the source of all game math; ranking-relevant aggregates are **recomputed server-side** so clients can't skew them. Scouter identity is **anonymous auth + an event code** redeemed through a SECURITY DEFINER RPC.

**Tech Stack:** TypeScript (strict), React 18, Vite 5, Tailwind 3, vite-plugin-pwa; Supabase (`@supabase/supabase-js` v2), Postgres, Deno Edge Functions; Dexie 4, TanStack Query 5, Zustand 4, React Router 6; Vitest 2 + Testing Library + Playwright.

## Global Constraints

_Every task's requirements implicitly include this section. Values are copied verbatim from the spec/frozen contracts._

- **Repo:** `/Users/ryanabraham/Downloads/FRC-scouting-app`. Git initialized on branch `phase-0-foundation`; `.gitignore` already set. Conventional Commits; one commit per task minimum.
- **Versions:** Node 20+, npm. React 18.3, Vite 5.4, TypeScript 5.5 (strict, `noUnusedLocals`/`noUnusedParameters`), Tailwind 3.4, vite-plugin-pwa 0.20, `@supabase/supabase-js` 2.45, react-router-dom 6.26, @tanstack/react-query 5.51, zustand 4.5, dexie 4.0, vitest 2.0, @playwright/test 1.46.
- **Env var names (frozen):** client → `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`; server-only → `SUPABASE_SECRET_KEY`, `TBA_API_KEY`, `QR_INGEST_HMAC_SECRET`. Real values live in gitignored `.env.local`. Supabase project ref `oztsfxyfovwnwutrxzmo`, URL `https://oztsfxyfovwnwutrxzmo.supabase.co`.
- **Scope:** single team (3256), quals only, 3256 not scouted, offline-first.
- **Integrity rule:** the client never sets ranking-relevant aggregates authoritatively — `recompute_match_report_aggregates` (server) recomputes fuel aggregates from `fuel_bursts`. Server columns (`server_received_at`, `row_revision`) own ordering, never client `created_at`.
- **Scoring constants are flagged for PDF verification before Phase 2** (spec §18); golden tests assert *logic* (parity, window attribution, rounding), not point magnitudes.
- **Test commands:** unit/integration `npm run test` (vitest); E2E `npm run test:e2e` (playwright); build `npm run build`; migrations `npx supabase db push`; functions `npx supabase functions deploy <name>`.
- **Phase 0 acceptance:** (1) `npm run build` succeeds, PWA manifest emitted, `storage.persist()` called; (2) migrations deploy (tables + RLS + triggers + RPCs); (3) anon sign-in + `join_event` creates a scout, RLS scopes its reads; (4) `tba-proxy` returns the real name for `2026casnv`; (5) `statbotics-proxy` degrades gracefully on upstream 5xx; (6) scoring golden-vector tests pass (8 parity cases, always-active phases, boundary-straddling burst, rounding).

## File Structure

```
package.json · vite.config.ts · tsconfig*.json · tailwind/postcss config · index.html · vitest.config.ts   (A1)
src/main.tsx · src/App.tsx · src/index.css · src/lib/{env,supabase}.ts · src/pwa/registerPwa.ts            (A1)
public/manifest.webmanifest · public/assets/field/field.png                                                (A1)
src/scoring/{constants,types,windows,compute,migrations,index}.ts + __tests__                              (B)
supabase/migrations/{0001_schema,0002_triggers,0003_rls,0004_rpcs}.sql · tests/db/*.test.ts                (C)
supabase/functions/{_shared/cors,tba-proxy,statbotics-proxy,ingest-reports} · tests/functions/*.test.ts    (D)
src/auth/{useSession,roles,joinEvent,JoinScreen}.tsx · src/routes/{router,guards}.tsx · tests/e2e/*.spec.ts (A2)
```

**Execution order:** A1 (scaffold) → B (scoring, independent) → C (database) → D (edge functions) → A2 (auth/routing/E2E integration). Task IDs are prefixed by cluster (A1*, B*, C*, D*, A2*); implement in the order listed.

---

<!-- ===== Cluster A1 ===== -->

### Task A11

**Files:**
- Create: package.json, vite.config.ts, tsconfig.json, tsconfig.node.json, index.html, src/main.tsx, src/App.tsx, src/index.css, vitest.config.ts, vitest.setup.ts
- Test: (smoke test added in Task A12)

**Interfaces:**
- Consumes: nothing
- Produces: a runnable Vite/React/TS scaffold with `npm run dev`, `npm run build`, `npm run test` scripts; `export default function App()` rendering a known heading.

- [ ] **Step 1: Verify the repo (already initialized by the controller).** Git is initialized on branch `phase-0-foundation` with a comprehensive `.gitignore` (excludes `node_modules`, `dist`, `coverage`, `.env`/`.env.*` except `.env.example`, `.DS_Store`, `.manual_txt/`, `.superpowers/`, the root field PNG). Do **not** re-init or overwrite `.gitignore`.
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
git branch --show-current   # expect: phase-0-foundation
git ls-files .gitignore     # expect: .gitignore (already tracked)
```
Expected output: `phase-0-foundation`, then `.gitignore`. Confirms repo ready — proceed to write scaffold files.

- [ ] **Step 2: Write package.json with FROZEN versions and scripts.**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/package.json <<'EOF'
{
  "name": "frc-scouting-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "typecheck": "tsc -b --noEmit"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "@tanstack/react-query": "^5.51.0",
    "dexie": "^4.0.8",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0",
    "zustand": "^4.5.4"
  },
  "devDependencies": {
    "@playwright/test": "^1.46.0",
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "jsdom": "^24.1.1",
    "postcss": "^8.4.40",
    "tailwindcss": "^3.4.7",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "vite-plugin-pwa": "^0.20.1",
    "vitest": "^2.0.5"
  }
}
EOF
npm install
node -e "console.log(require('./package.json').name)"
```
Expected output: npm installs without errors; prints `frc-scouting-app`.

- [ ] **Step 3: Write tsconfig.json + tsconfig.node.json (TS strict).**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "tests"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
EOF
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/tsconfig.node.json <<'EOF'
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noEmit": true
  },
  "include": ["vite.config.ts", "vitest.config.ts"]
}
EOF
echo "tsconfig written"
```
Expected output: `tsconfig written`.

- [ ] **Step 4: Write vite.config.ts (React plugin only for now; PWA added in Task A13).**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/vite.config.ts <<'EOF'
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
EOF
echo "vite.config written"
```
Expected output: `vite.config written`.

- [ ] **Step 5: Write vitest.config.ts + vitest.setup.ts (jsdom + jest-dom).**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/vitest.config.ts <<'EOF'
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
EOF
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/vitest.setup.ts <<'EOF'
import '@testing-library/jest-dom/vitest';
EOF
echo "vitest config written"
```
Expected output: `vitest config written`.

- [ ] **Step 6: Write index.html, src/main.tsx, src/App.tsx, src/index.css.**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0b0f1a" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>3256 Scouting</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/main.tsx <<'EOF'
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
EOF
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/App.tsx <<'EOF'
export default function App() {
  return (
    <main>
      <h1>3256 Scouting</h1>
    </main>
  );
}
EOF
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/index.css <<'EOF'
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color-scheme: dark;
}
EOF
echo "app files written"
```
Expected output: `app files written`.

- [ ] **Step 7: Commit the scaffold.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
git add -A
git commit -m "feat: scaffold Vite/React/TS app with vitest config"
git log --oneline -1
```
Expected output: one commit line, e.g. `<sha> feat: scaffold Vite/React/TS app with vitest config`.

---

### Task A12

**Files:**
- Create: tailwind.config.js, postcss.config.js
- Test: src/App.test.tsx (smoke: App renders heading)

**Interfaces:**
- Consumes: `App` from src/App.tsx (produced in A11)
- Produces: passing smoke test proving render + Tailwind/PostCSS configured.

- [ ] **Step 1: Write a FAILING smoke test for App.** (App import path is correct, but jest-dom matcher proves setup wired.)
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/App.test.tsx <<'EOF'
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import App from './App';

describe('App', () => {
  it('renders the app heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '3256 Scouting' })).toBeInTheDocument();
  });
});
EOF
echo "test written"
```
Expected output: `test written`.

- [ ] **Step 2: Run the test — verify it PASSES (App already exists from A11) OR fails only on missing config.** Run vitest.
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run test
```
Expected output: `App > renders the app heading` passes; `Test Files  1 passed`. (If jest-dom matcher errored, vitest.setup.ts is misconfigured — fix before continuing.)

- [ ] **Step 3: Write tailwind.config.js + postcss.config.js (needed for `npm run build` to process index.css).**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/tailwind.config.js <<'EOF'
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
EOF
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/postcss.config.js <<'EOF'
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
EOF
echo "tailwind/postcss written"
```
Expected output: `tailwind/postcss written`.

- [ ] **Step 4: Re-run tests to confirm still green after config.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run test
```
Expected output: `Test Files  1 passed (1)`, `Tests  1 passed (1)`.

- [ ] **Step 5: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
git add -A
git commit -m "test: add App smoke test; configure Tailwind/PostCSS"
git log --oneline -1
```
Expected output: `<sha> test: add App smoke test; configure Tailwind/PostCSS`.

---

### Task A13

**Files:**
- Create: public/manifest.webmanifest, src/pwa/registerPwa.ts
- Modify: vite.config.ts, src/main.tsx
- Test: src/pwa/registerPwa.test.ts (asserts persist() called when API present)

**Interfaces:**
- Consumes: `App` (rendered in main.tsx)
- Produces: `export async function registerPwa(): Promise<void>` (registers SW via virtual:pwa-register and calls `navigator.storage.persist()`); PWA manifest emitted by vite-plugin-pwa on build.

- [ ] **Step 1: Write FAILING test for registerPwa persist behavior.** Mock `virtual:pwa-register` and `navigator.storage`.
```bash
mkdir -p /Users/ryanabraham/Downloads/FRC-scouting-app/src/pwa
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/pwa/registerPwa.test.ts <<'EOF'
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('virtual:pwa-register', () => ({
  registerSW: vi.fn(() => () => {}),
}));

import { registerPwa } from './registerPwa';
import { registerSW } from 'virtual:pwa-register';

describe('registerPwa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the service worker and requests persistent storage', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist },
    });

    await registerPwa();

    expect(registerSW).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not throw when storage.persist is unavailable', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: undefined,
    });

    await expect(registerPwa()).resolves.toBeUndefined();
    expect(registerSW).toHaveBeenCalledTimes(1);
  });
});
EOF
echo "pwa test written"
```
Expected output: `pwa test written`.

- [ ] **Step 2: Run the test — verify it FAILS (registerPwa not implemented).**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run test -- src/pwa/registerPwa.test.ts
```
Expected output: failure resolving `./registerPwa` — `Failed to resolve import "./registerPwa"` or `registerPwa is not a function`.

- [ ] **Step 3: Implement src/pwa/registerPwa.ts.**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/pwa/registerPwa.ts <<'EOF'
import { registerSW } from 'virtual:pwa-register';

export async function registerPwa(): Promise<void> {
  registerSW({ immediate: true });

  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.persist === 'function'
  ) {
    try {
      await navigator.storage.persist();
    } catch {
      // Persistent storage is best-effort; ignore failures.
    }
  }
}
EOF
echo "registerPwa written"
```
Expected output: `registerPwa written`.

- [ ] **Step 4: Add a virtual module type declaration so TS/build resolve `virtual:pwa-register`.**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/pwa/pwa.d.ts <<'EOF'
declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: unknown) => void;
  }
  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
EOF
echo "pwa types written"
```
Expected output: `pwa types written`.

- [ ] **Step 5: Run the test — verify it PASSES.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run test -- src/pwa/registerPwa.test.ts
```
Expected output: `Tests  2 passed (2)`.

- [ ] **Step 6: Write public/manifest.webmanifest.**
```bash
mkdir -p /Users/ryanabraham/Downloads/FRC-scouting-app/public
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/public/manifest.webmanifest <<'EOF'
{
  "name": "3256 Scouting",
  "short_name": "3256 Scout",
  "description": "Offline-first FRC scouting app for Team 3256",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0b0f1a",
  "theme_color": "#0b0f1a",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}
EOF
echo "manifest written"
```
Expected output: `manifest written`.

- [ ] **Step 7: Generate placeholder PWA icons (so the manifest references real files).**
```bash
mkdir -p /Users/ryanabraham/Downloads/FRC-scouting-app/public/icons
node -e '
const fs=require("fs");
// 1x1 transparent PNG, base64.
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=","base64");
fs.writeFileSync("/Users/ryanabraham/Downloads/FRC-scouting-app/public/icons/icon-192.png",png);
fs.writeFileSync("/Users/ryanabraham/Downloads/FRC-scouting-app/public/icons/icon-512.png",png);
console.log("icons written");
'
```
Expected output: `icons written`.

- [ ] **Step 8: Configure vite-plugin-pwa in vite.config.ts (use existing public manifest, generate SW).**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/vite.config.ts <<'EOF'
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      manifest: false,
      includeAssets: ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        navigateFallback: '/index.html',
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
EOF
echo "vite pwa config written"
```
Expected output: `vite pwa config written`.

- [ ] **Step 9: Wire registerPwa into src/main.tsx.**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/main.tsx <<'EOF'
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { registerPwa } from './pwa/registerPwa';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

void registerPwa();
EOF
echo "main wired"
```
Expected output: `main wired`.

- [ ] **Step 10: Run full test suite to confirm nothing regressed.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run test
```
Expected output: `Test Files  2 passed (2)`, all tests passing.

- [ ] **Step 11: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
git add -A
git commit -m "feat: add PWA manifest, service worker, and registerPwa with storage.persist"
git log --oneline -1
```
Expected output: `<sha> feat: add PWA manifest, service worker, and registerPwa with storage.persist`.

---

### Task A14

**Files:**
- Create: src/lib/env.ts, src/lib/supabase.ts
- Test: src/lib/env.test.ts (env guard throws on missing vars; returns values when present)

**Interfaces:**
- Consumes: `import.meta.env.VITE_SUPABASE_URL`, `import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY`
- Produces:
  - `export const env: { SUPABASE_URL: string; SUPABASE_PUBLISHABLE_KEY: string }` (runtime-guarded)
  - `export function readEnv(source: ImportMetaEnv): { SUPABASE_URL: string; SUPABASE_PUBLISHABLE_KEY: string }` (testable pure guard)
  - `export const supabase = createClient(...)` with `{ auth: { persistSession: true, autoRefreshToken: true } }`

- [ ] **Step 1: Write FAILING test for the env guard.** Tests the pure `readEnv` function (avoids mutating real `import.meta.env`).
```bash
mkdir -p /Users/ryanabraham/Downloads/FRC-scouting-app/src/lib
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/lib/env.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import { readEnv } from './env';

describe('readEnv', () => {
  it('returns typed values when both vars are present', () => {
    const result = readEnv({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'pk_test_123',
    } as unknown as ImportMetaEnv);
    expect(result).toEqual({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'pk_test_123',
    });
  });

  it('throws when VITE_SUPABASE_URL is missing', () => {
    expect(() =>
      readEnv({ VITE_SUPABASE_PUBLISHABLE_KEY: 'pk_test_123' } as unknown as ImportMetaEnv),
    ).toThrow(/VITE_SUPABASE_URL/);
  });

  it('throws when VITE_SUPABASE_PUBLISHABLE_KEY is missing', () => {
    expect(() =>
      readEnv({ VITE_SUPABASE_URL: 'https://example.supabase.co' } as unknown as ImportMetaEnv),
    ).toThrow(/VITE_SUPABASE_PUBLISHABLE_KEY/);
  });
});
EOF
echo "env test written"
```
Expected output: `env test written`.

- [ ] **Step 2: Run the test — verify it FAILS (env.ts not implemented).**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run test -- src/lib/env.test.ts
```
Expected output: failure — `Failed to resolve import "./env"` or `readEnv is not a function`.

- [ ] **Step 3: Implement src/lib/env.ts (pure guard + module-level env).**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/lib/env.ts <<'EOF'
export interface AppEnv {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
}

export function readEnv(source: ImportMetaEnv): AppEnv {
  const url = source.VITE_SUPABASE_URL;
  const key = source.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!url || typeof url !== 'string') {
    throw new Error('Missing required env var: VITE_SUPABASE_URL');
  }
  if (!key || typeof key !== 'string') {
    throw new Error('Missing required env var: VITE_SUPABASE_PUBLISHABLE_KEY');
  }

  return { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key };
}

export const env: AppEnv = readEnv(import.meta.env);
EOF
echo "env written"
```
Expected output: `env written`.

- [ ] **Step 4: Add Vite env type declarations so `import.meta.env.VITE_*` is typed.**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/vite-env.d.ts <<'EOF'
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
EOF
echo "vite-env types written"
```
Expected output: `vite-env types written`.

- [ ] **Step 5: Run the env test — verify it PASSES.** (Note: the module-level `env` export evaluates `readEnv(import.meta.env)` at import; vitest reads VITE_* from .env.local via Vite. Ensure .env.local has the FROZEN vars; they are already present per Phase 0 contract.)
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run test -- src/lib/env.test.ts
```
Expected output: `Tests  3 passed (3)`.

- [ ] **Step 6: Implement src/lib/supabase.ts.**
```bash
cat > /Users/ryanabraham/Downloads/FRC-scouting-app/src/lib/supabase.ts <<'EOF'
import { createClient } from '@supabase/supabase-js';
import { env } from './env';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
EOF
echo "supabase client written"
```
Expected output: `supabase client written`.

- [ ] **Step 7: Run the full test suite to confirm green.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run test
```
Expected output: `Test Files  3 passed (3)`, all tests passing.

- [ ] **Step 8: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
git add -A
git commit -m "feat: add env guard and Supabase client"
git log --oneline -1
```
Expected output: `<sha> feat: add env guard and Supabase client`.

---

### Task A15

**Files:**
- Modify: none (verification + acceptance task)
- Test: relies on `npm run build` output (dist/ + emitted manifest + service worker)

**Interfaces:**
- Consumes: full A1 cluster (vite.config.ts PWA, public/manifest.webmanifest, src/lib/env.ts via build, .env.local)
- Produces: verified Phase 0 acceptance #1 — build succeeds, manifest present in dist/, SW emitted, `navigator.storage.persist()` wired.

- [ ] **Step 1: Typecheck the whole project (strict TS must pass).**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run typecheck
```
Expected output: no errors; exit code 0 (silent success).

- [ ] **Step 2: Run the production build.** Build needs VITE_* env vars (env.ts evaluates at module import during prerender/transform); they come from .env.local.
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run build
```
Expected output: `vite vX.Y.Z building for production...`, `✓ built in ...`, and a `PWA v0.20.x` block listing precache entries (e.g. `precache ... entries`). No errors.

- [ ] **Step 3: Verify the manifest is emitted into dist/.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
test -f dist/manifest.webmanifest && echo "MANIFEST OK"
node -e "const m=require('./dist/manifest.webmanifest'); if(m.name!=='3256 Scouting'){process.exit(1)}; console.log('NAME OK:', m.name)"
```
Expected output:
```
MANIFEST OK
NAME OK: 3256 Scouting
```

- [ ] **Step 4: Verify the service worker + Workbox precache were emitted.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
test -f dist/sw.js && echo "SW OK"
ls dist/workbox-*.js >/dev/null 2>&1 && echo "WORKBOX OK"
grep -q "index.html" dist/sw.js && echo "PRECACHE OK"
```
Expected output:
```
SW OK
WORKBOX OK
PRECACHE OK
```

- [ ] **Step 5: Verify registerPwa wiring + storage.persist call exist in source (acceptance #1).**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
grep -q "registerPwa" src/main.tsx && echo "WIRED OK"
grep -q "navigator.storage.persist" src/pwa/registerPwa.ts && echo "PERSIST OK"
```
Expected output:
```
WIRED OK
PERSIST OK
```

- [ ] **Step 6: Run the entire unit suite one final time as a gate.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run test
```
Expected output: `Test Files  3 passed (3)`, `Tests  8 passed (8)` (App 1 + registerPwa 2 + env 3 = 6; adjust count if other A1 specs land — all must pass).

- [ ] **Step 7: Commit the verified build state (lockfile / any incidental updates).**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
git add -A
git commit -m "chore: verify Phase 0 build, PWA manifest, and service worker emission" --allow-empty
git log --oneline -5
```
Expected output: a commit `chore: verify Phase 0 build, PWA manifest, and service worker emission` atop the A1 cluster history.

---

### Task A1V: Vendor the official field image

**Files:**
- Create: `public/assets/field/field.png` (copied from the repo-root PNG)

**Interfaces:**
- Consumes: nothing
- Produces: the field background asset at `public/assets/field/field.png` for the Phase 2 `FieldDiagram`.

- [ ] **Step 1: Copy the asset into public/.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
mkdir -p public/assets/field
cp "FE-2026-_REBUILT_Playing_Field_With_Fuel_With_Background.png" public/assets/field/field.png
ls -la public/assets/field/field.png
```
Expected: file listed (~2.4 MB).

- [ ] **Step 2: Commit.**
```bash
git add public/assets/field/field.png
git commit -m "chore: vendor official REBUILT field image for FieldDiagram"
```

<!-- ===== Cluster B ===== -->

### Task B1

**Files:**
- Create: `src/scoring/constants.ts`
- Create: `src/scoring/types.ts`
- Test: (none — pure constant/type declarations consumed by later tasks)

**Interfaces:**
- Produces: `export const SCHEMA_VERSION = 1`
- Produces: `export const SCORING = { FUEL_POINTS: 1, CLIMB: {...} } as const`
- Produces: `export type MatchWindow`, `export interface FuelBurst`, `export interface MatchReportInputs`, `export interface MatchReportAggregates`

- [ ] **Step 1: Write `src/scoring/constants.ts` with the frozen constants.**
```ts
// src/scoring/constants.ts
export const SCHEMA_VERSION = 1;

export const SCORING = {
  FUEL_POINTS: 1,
  CLIMB: {
    1: { auto: 15, teleop: 10 },
    2: { auto: 0, teleop: 20 },
    3: { auto: 0, teleop: 30 },
  },
} as const;
// VALUES FLAGGED FOR VERIFICATION against the PDF before Phase 2 (spec §18).
// Golden tests assert LOGIC, not these magnitudes.
```
Run: `npx tsc --noEmit -p tsconfig.json`
Expected output: command exits 0 (no errors). (If tsconfig is not yet present from Cluster A1, this step's verification is deferred to the first task that has it; the file still compiles standalone.)

- [ ] **Step 2: Write `src/scoring/types.ts` with the frozen types.**
```ts
// src/scoring/types.ts
export type MatchWindow =
  | 'auto'
  | 'transition'
  | 'shift1'
  | 'shift2'
  | 'shift3'
  | 'shift4'
  | 'endgame';

export interface FuelBurst {
  startMs: number;
  endMs: number;
  rate: number;
  window: MatchWindow;
}

export interface MatchReportInputs {
  schemaVersion: number;
  inactiveFirst: boolean;
  fuelBursts: FuelBurst[];
  climbLevel: 0 | 1 | 2 | 3;
  autoClimbLevel1: boolean;
}

export interface MatchReportAggregates {
  autoFuel: number;
  teleopFuelActive: number;
  teleopFuelInactive: number;
  endgameFuel: number;
  fuelByShift: [number, number, number, number];
  fuelPoints: number;
}
```
Run: `npx tsc --noEmit src/scoring/types.ts src/scoring/constants.ts`
Expected output: command exits 0 (no errors).

- [ ] **Step 3: Commit.**
```bash
git add src/scoring/constants.ts src/scoring/types.ts && git commit -m "feat: add scoring constants and types (frozen API)"
```
Expected output: one commit created reporting 2 files changed.

### Task B2

**Files:**
- Create: `src/scoring/windows.ts`
- Test: `src/scoring/__tests__/windows.test.ts`

**Interfaces:**
- Consumes: `MatchWindow` from `src/scoring/types.ts`
- Produces: `export const SHIFT_BOUNDS: Record<'shift1'|'shift2'|'shift3'|'shift4'|'transition'|'endgame', {start:number,end:number}>`
- Produces: `export function isInactive(shiftNumber: 1|2|3|4, inactiveFirst: boolean): boolean`
- Produces: `export function isWindowActive(window: MatchWindow, inactiveFirst: boolean): boolean`
- Produces: `export function shiftNumberOf(window: MatchWindow): 1|2|3|4|null`

- [ ] **Step 1: Write the failing golden-vector test for the 8 parity cases of `isInactive`.**
```ts
// src/scoring/__tests__/windows.test.ts
import { describe, it, expect } from 'vitest';
import {
  SHIFT_BOUNDS,
  isInactive,
  isWindowActive,
  shiftNumberOf,
} from '../windows';

describe('isInactive — 8 parity cases (shiftNumber × inactiveFirst)', () => {
  // Rule: ((shiftNumber % 2) === 1) === inactiveFirst
  // inactiveFirst = true  -> odd shifts (1,3) inactive; even shifts (2,4) active
  // inactiveFirst = false -> even shifts (2,4) inactive; odd shifts (1,3) active
  const cases: Array<{ shift: 1 | 2 | 3 | 4; inactiveFirst: boolean; expected: boolean }> = [
    { shift: 1, inactiveFirst: true, expected: true },
    { shift: 2, inactiveFirst: true, expected: false },
    { shift: 3, inactiveFirst: true, expected: true },
    { shift: 4, inactiveFirst: true, expected: false },
    { shift: 1, inactiveFirst: false, expected: false },
    { shift: 2, inactiveFirst: false, expected: true },
    { shift: 3, inactiveFirst: false, expected: false },
    { shift: 4, inactiveFirst: false, expected: true },
  ];

  for (const c of cases) {
    it(`shift ${c.shift}, inactiveFirst=${c.inactiveFirst} -> ${c.expected}`, () => {
      expect(isInactive(c.shift, c.inactiveFirst)).toBe(c.expected);
    });
  }
});

describe('isWindowActive — always-active phases', () => {
  for (const inactiveFirst of [true, false]) {
    it(`auto is always active (inactiveFirst=${inactiveFirst})`, () => {
      expect(isWindowActive('auto', inactiveFirst)).toBe(true);
    });
    it(`transition is always active (inactiveFirst=${inactiveFirst})`, () => {
      expect(isWindowActive('transition', inactiveFirst)).toBe(true);
    });
    it(`endgame is always active (inactiveFirst=${inactiveFirst})`, () => {
      expect(isWindowActive('endgame', inactiveFirst)).toBe(true);
    });
  }

  it('shift windows mirror !isInactive', () => {
    // inactiveFirst=true: shift1 inactive -> not active
    expect(isWindowActive('shift1', true)).toBe(false);
    expect(isWindowActive('shift2', true)).toBe(true);
    expect(isWindowActive('shift3', true)).toBe(false);
    expect(isWindowActive('shift4', true)).toBe(true);
    // inactiveFirst=false: shift1 active
    expect(isWindowActive('shift1', false)).toBe(true);
    expect(isWindowActive('shift2', false)).toBe(false);
    expect(isWindowActive('shift3', false)).toBe(true);
    expect(isWindowActive('shift4', false)).toBe(false);
  });
});

describe('shiftNumberOf', () => {
  it('maps shift windows to their number', () => {
    expect(shiftNumberOf('shift1')).toBe(1);
    expect(shiftNumberOf('shift2')).toBe(2);
    expect(shiftNumberOf('shift3')).toBe(3);
    expect(shiftNumberOf('shift4')).toBe(4);
  });
  it('returns null for non-shift windows', () => {
    expect(shiftNumberOf('auto')).toBeNull();
    expect(shiftNumberOf('transition')).toBeNull();
    expect(shiftNumberOf('endgame')).toBeNull();
  });
});

describe('SHIFT_BOUNDS — frozen teleop boundaries (ms from teleop start)', () => {
  it('matches the frozen window table', () => {
    expect(SHIFT_BOUNDS.transition).toEqual({ start: 0, end: 10000 });
    expect(SHIFT_BOUNDS.shift1).toEqual({ start: 10000, end: 35000 });
    expect(SHIFT_BOUNDS.shift2).toEqual({ start: 35000, end: 60000 });
    expect(SHIFT_BOUNDS.shift3).toEqual({ start: 60000, end: 85000 });
    expect(SHIFT_BOUNDS.shift4).toEqual({ start: 85000, end: 110000 });
    expect(SHIFT_BOUNDS.endgame).toEqual({ start: 110000, end: 140000 });
  });
});
```
Run: `npm run test -- src/scoring/__tests__/windows.test.ts`
Expected output: FAIL — Vitest reports it cannot resolve `'../windows'` (module not found), confirming the test runs and fails before implementation.

- [ ] **Step 2: Implement `src/scoring/windows.ts` to make the test pass.**
```ts
// src/scoring/windows.ts
import type { MatchWindow } from './types';

// Teleop ms from teleop start. Auto [0,20000) handled separately.
export const SHIFT_BOUNDS: Record<
  'shift1' | 'shift2' | 'shift3' | 'shift4' | 'transition' | 'endgame',
  { start: number; end: number }
> = {
  transition: { start: 0, end: 10000 },
  shift1: { start: 10000, end: 35000 },
  shift2: { start: 35000, end: 60000 },
  shift3: { start: 60000, end: 85000 },
  shift4: { start: 85000, end: 110000 },
  endgame: { start: 110000, end: 140000 },
};

export function isInactive(shiftNumber: 1 | 2 | 3 | 4, inactiveFirst: boolean): boolean {
  return ((shiftNumber % 2) === 1) === inactiveFirst;
}

export function shiftNumberOf(window: MatchWindow): 1 | 2 | 3 | 4 | null {
  switch (window) {
    case 'shift1':
      return 1;
    case 'shift2':
      return 2;
    case 'shift3':
      return 3;
    case 'shift4':
      return 4;
    default:
      return null;
  }
}

export function isWindowActive(window: MatchWindow, inactiveFirst: boolean): boolean {
  const n = shiftNumberOf(window);
  if (n === null) return true; // auto / transition / endgame are always active
  return !isInactive(n, inactiveFirst);
}
```
Run: `npm run test -- src/scoring/__tests__/windows.test.ts`
Expected output: PASS — all describe blocks green (8 parity cases + always-active phases + shiftNumberOf + SHIFT_BOUNDS), 0 failures.

- [ ] **Step 3: Commit.**
```bash
git add src/scoring/windows.ts src/scoring/__tests__/windows.test.ts && git commit -m "feat: add scoring windows with parity logic + golden tests"
```
Expected output: one commit created reporting 2 files changed.

### Task B3

**Files:**
- Create: `src/scoring/compute.ts`
- Test: `src/scoring/__tests__/compute.test.ts`

**Interfaces:**
- Consumes: `MatchReportInputs`, `MatchReportAggregates`, `FuelBurst` from `src/scoring/types.ts`; `isWindowActive`, `shiftNumberOf` from `src/scoring/windows.ts`; `SCORING` from `src/scoring/constants.ts`
- Produces: `export function computeAggregates(input: MatchReportInputs): MatchReportAggregates`
- Semantics: fuel per burst = `rate*(endMs-startMs)/1000`; sum per window as float; round half-up ONCE per window; `fuelPoints` = sum of rounded fuel in ACTIVE windows (auto+transition+endgame always; shiftN if active) × `SCORING.FUEL_POINTS`. Aggregates: `autoFuel` = rounded auto; `endgameFuel` = rounded endgame; `teleopFuelActive`/`teleopFuelInactive` = sums of rounded active/inactive shift+transition? (transition counts toward active teleop). `fuelByShift` = rounded per-shift fuel [s1,s2,s3,s4].

- [ ] **Step 1: Write the failing golden-vector test for `computeAggregates`.**
```ts
// src/scoring/__tests__/compute.test.ts
import { describe, it, expect } from 'vitest';
import { computeAggregates } from '../compute';
import type { MatchReportInputs } from '../types';

describe('computeAggregates — multi-burst, boundary-straddle, round-half-up per window', () => {
  // Build a report whose bursts each carry their own pre-classified `window`.
  // Per the frozen semantics, fuel per burst = rate * (endMs - startMs) / 1000,
  // summed per window as a float, then rounded HALF-UP once per window.
  //
  // Straddle case: a burst tagged window='shift1' that physically spans the
  // shift1 lower boundary (10000ms). Window classification is by the burst's
  // declared `window` field; the boundary straddle exercises duration math.
  const input: MatchReportInputs = {
    schemaVersion: 1,
    inactiveFirst: true, // shift1 & shift3 INACTIVE; shift2 & shift4 ACTIVE
    climbLevel: 0,
    autoClimbLevel1: false,
    fuelBursts: [
      // auto: 4.5 fuel -> rounds half-up to 5
      { startMs: 0, endMs: 9000, rate: 0.5, window: 'auto' },
      // transition: 2.5 fuel -> rounds half-up to 3
      { startMs: 0, endMs: 5000, rate: 0.5, window: 'transition' },
      // shift1 (INACTIVE) straddling the 10000ms boundary: 8000..12000 @1.0 = 4.0 -> 4
      { startMs: 8000, endMs: 12000, rate: 1.0, window: 'shift1' },
      //   second shift1 burst: 1500..2000? No — keep within shift1 declared window.
      { startMs: 15000, endMs: 18000, rate: 0.5, window: 'shift1' }, // 1.5 -> shift1 float = 4.0+1.5 = 5.5 -> 6
      // shift2 (ACTIVE): 3.5 -> 4
      { startMs: 35000, endMs: 42000, rate: 0.5, window: 'shift2' },
      // shift3 (INACTIVE): 2.5 -> 3
      { startMs: 60000, endMs: 65000, rate: 0.5, window: 'shift3' },
      // shift4 (ACTIVE): 1.5 -> 2
      { startMs: 85000, endMs: 88000, rate: 0.5, window: 'shift4' },
      // endgame: 6.5 -> 7
      { startMs: 110000, endMs: 123000, rate: 0.5, window: 'endgame' },
    ],
  };

  const agg = computeAggregates(input);

  it('rounds auto half-up once per window', () => {
    expect(agg.autoFuel).toBe(5); // 4.5 -> 5
  });

  it('rounds endgame half-up once per window', () => {
    expect(agg.endgameFuel).toBe(7); // 6.5 -> 7
  });

  it('sums shift floats then rounds once per shift (straddle accumulates before rounding)', () => {
    // shift1 float = 4.0 + 1.5 = 5.5 -> 6
    // shift2 = 3.5 -> 4 ; shift3 = 2.5 -> 3 ; shift4 = 1.5 -> 2
    expect(agg.fuelByShift).toEqual([6, 4, 3, 2]);
  });

  it('teleopFuelActive = transition + active shifts (rounded per window)', () => {
    // transition 3 + shift2 4 + shift4 2 = 9
    expect(agg.teleopFuelActive).toBe(9);
  });

  it('teleopFuelInactive = inactive shifts (rounded per window)', () => {
    // shift1 6 + shift3 3 = 9
    expect(agg.teleopFuelInactive).toBe(9);
  });

  it('fuelPoints = sum of rounded fuel in ACTIVE windows * FUEL_POINTS', () => {
    // active = auto 5 + transition 3 + shift2 4 + shift4 2 + endgame 7 = 21
    expect(agg.fuelPoints).toBe(21);
  });
});

describe('computeAggregates — round-half-up boundary (.5 always up, not banker rounding)', () => {
  it('0.5 rounds to 1, not 0', () => {
    const agg = computeAggregates({
      schemaVersion: 1,
      inactiveFirst: false,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [{ startMs: 0, endMs: 1000, rate: 0.5, window: 'auto' }], // 0.5
    });
    expect(agg.autoFuel).toBe(1);
  });

  it('empty bursts produce all-zero aggregates', () => {
    const agg = computeAggregates({
      schemaVersion: 1,
      inactiveFirst: true,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [],
    });
    expect(agg).toEqual({
      autoFuel: 0,
      teleopFuelActive: 0,
      teleopFuelInactive: 0,
      endgameFuel: 0,
      fuelByShift: [0, 0, 0, 0],
      fuelPoints: 0,
    });
  });
});
```
Run: `npm run test -- src/scoring/__tests__/compute.test.ts`
Expected output: FAIL — Vitest cannot resolve `'../compute'` (module not found), confirming the test runs and fails before implementation.

- [ ] **Step 2: Implement `src/scoring/compute.ts` to make the test pass.**
```ts
// src/scoring/compute.ts
import type { MatchReportInputs, MatchReportAggregates, MatchWindow } from './types';
import { SCORING } from './constants';
import { isWindowActive, shiftNumberOf } from './windows';

// Round half-up: 0.5 -> 1, 2.5 -> 3, -0.5 -> 0. Math.round already rounds
// half toward +Infinity for non-negative values, which is what we need here
// (fuel is always >= 0). Use an explicit half-up to be unambiguous.
function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

function burstFuel(rate: number, startMs: number, endMs: number): number {
  return (rate * (endMs - startMs)) / 1000;
}

export function computeAggregates(input: MatchReportInputs): MatchReportAggregates {
  // Accumulate float fuel per window first.
  const floatByWindow: Record<MatchWindow, number> = {
    auto: 0,
    transition: 0,
    shift1: 0,
    shift2: 0,
    shift3: 0,
    shift4: 0,
    endgame: 0,
  };

  for (const b of input.fuelBursts) {
    floatByWindow[b.window] += burstFuel(b.rate, b.startMs, b.endMs);
  }

  // Round half-up ONCE per window.
  const roundedByWindow: Record<MatchWindow, number> = {
    auto: roundHalfUp(floatByWindow.auto),
    transition: roundHalfUp(floatByWindow.transition),
    shift1: roundHalfUp(floatByWindow.shift1),
    shift2: roundHalfUp(floatByWindow.shift2),
    shift3: roundHalfUp(floatByWindow.shift3),
    shift4: roundHalfUp(floatByWindow.shift4),
    endgame: roundHalfUp(floatByWindow.endgame),
  };

  const fuelByShift: [number, number, number, number] = [
    roundedByWindow.shift1,
    roundedByWindow.shift2,
    roundedByWindow.shift3,
    roundedByWindow.shift4,
  ];

  let teleopFuelActive = roundedByWindow.transition; // transition is always active teleop
  let teleopFuelInactive = 0;
  for (const w of ['shift1', 'shift2', 'shift3', 'shift4'] as const) {
    const n = shiftNumberOf(w)!;
    if (isWindowActive(w, input.inactiveFirst)) {
      teleopFuelActive += roundedByWindow[w];
    } else {
      teleopFuelInactive += roundedByWindow[w];
    }
    void n;
  }

  // fuelPoints = sum of rounded fuel in ACTIVE windows * FUEL_POINTS.
  // auto + transition + endgame always active; shiftN if active.
  let activeFuel = roundedByWindow.auto + roundedByWindow.transition + roundedByWindow.endgame;
  for (const w of ['shift1', 'shift2', 'shift3', 'shift4'] as const) {
    if (isWindowActive(w, input.inactiveFirst)) {
      activeFuel += roundedByWindow[w];
    }
  }
  const fuelPoints = activeFuel * SCORING.FUEL_POINTS;

  return {
    autoFuel: roundedByWindow.auto,
    teleopFuelActive,
    teleopFuelInactive,
    endgameFuel: roundedByWindow.endgame,
    fuelByShift,
    fuelPoints,
  };
}
```
Run: `npm run test -- src/scoring/__tests__/compute.test.ts`
Expected output: PASS — all `computeAggregates` cases green (per-window round-half-up, straddle accumulation, active/inactive split, fuelPoints=21, empty=all-zero), 0 failures.

- [ ] **Step 3: Commit.**
```bash
git add src/scoring/compute.ts src/scoring/__tests__/compute.test.ts && git commit -m "feat: add computeAggregates with per-window round-half-up + golden tests"
```
Expected output: one commit created reporting 2 files changed.

### Task B4

**Files:**
- Create: `src/scoring/migrations.ts`
- Test: `src/scoring/__tests__/migrations.test.ts`

**Interfaces:**
- Consumes: `SCHEMA_VERSION` from `src/scoring/constants.ts`
- Produces: `export type AnyReport = Record<string, unknown> & { schema_version?: number }`
- Produces: `export function migrateUp(record: AnyReport): AnyReport` — runs ordered migrations from `record.schema_version` up to `SCHEMA_VERSION`; throws if record newer than `SCHEMA_VERSION`.

- [ ] **Step 1: Write the failing test for `migrateUp` identity-at-current-version and throw-when-newer.**
```ts
// src/scoring/__tests__/migrations.test.ts
import { describe, it, expect } from 'vitest';
import { migrateUp } from '../migrations';
import { SCHEMA_VERSION } from '../constants';

describe('migrateUp', () => {
  it('is identity when record is already at SCHEMA_VERSION', () => {
    const rec = { schema_version: SCHEMA_VERSION, foo: 'bar', auto_fuel: 3 };
    const out = migrateUp({ ...rec });
    expect(out).toEqual(rec);
    expect(out.schema_version).toBe(SCHEMA_VERSION);
  });

  it('treats a missing schema_version as version 0 and stamps it to SCHEMA_VERSION', () => {
    const out = migrateUp({ foo: 'bar' });
    // With SCHEMA_VERSION=1 and no v0->v1 transform registered, the record is
    // simply stamped to the current version with content preserved.
    expect(out.schema_version).toBe(SCHEMA_VERSION);
    expect(out.foo).toBe('bar');
  });

  it('throws when the record is newer than SCHEMA_VERSION', () => {
    expect(() => migrateUp({ schema_version: SCHEMA_VERSION + 1 })).toThrow(
      /newer/i,
    );
  });
});
```
Run: `npm run test -- src/scoring/__tests__/migrations.test.ts`
Expected output: FAIL — Vitest cannot resolve `'../migrations'` (module not found), confirming the test runs and fails before implementation.

- [ ] **Step 2: Implement `src/scoring/migrations.ts` to make the test pass.**
```ts
// src/scoring/migrations.ts
import { SCHEMA_VERSION } from './constants';

export type AnyReport = Record<string, unknown> & { schema_version?: number };

// Ordered migration steps. migrations[n] transforms a record AT version n into
// a record at version n+1. When SCHEMA_VERSION grows, append a step here.
// For SCHEMA_VERSION=1 there are no transforms; records are only stamped.
type MigrationStep = (record: AnyReport) => AnyReport;

const migrations: Record<number, MigrationStep> = {
  // 0: (record) => ({ ...record, /* v0 -> v1 field changes */ }),
};

export function migrateUp(record: AnyReport): AnyReport {
  const current =
    typeof record.schema_version === 'number' ? record.schema_version : 0;

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Cannot migrate: record schema_version ${current} is newer than supported SCHEMA_VERSION ${SCHEMA_VERSION}`,
    );
  }

  let working: AnyReport = { ...record };
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const step = migrations[v];
    if (step) {
      working = step(working);
    }
    working.schema_version = v + 1;
  }

  // Ensure the version field is stamped even when current === SCHEMA_VERSION
  // (e.g. missing schema_version with SCHEMA_VERSION at the floor).
  working.schema_version = SCHEMA_VERSION;
  return working;
}
```
Run: `npm run test -- src/scoring/__tests__/migrations.test.ts`
Expected output: PASS — identity-at-current, missing-version-stamped, and throw-when-newer cases all green, 0 failures.

- [ ] **Step 3: Commit.**
```bash
git add src/scoring/migrations.ts src/scoring/__tests__/migrations.test.ts && git commit -m "feat: add migrateUp with ordered migrations + newer-record guard + tests"
```
Expected output: one commit created reporting 2 files changed.

### Task B5

**Files:**
- Create: `src/scoring/index.ts`
- Test: `src/scoring/__tests__/index.test.ts`

**Interfaces:**
- Consumes: all of `constants.ts`, `types.ts`, `windows.ts`, `compute.ts`, `migrations.ts`
- Produces: re-export of the public scoring API (single import surface `src/scoring`)

- [ ] **Step 1: Write the failing test asserting the public re-export surface.**
```ts
// src/scoring/__tests__/index.test.ts
import { describe, it, expect } from 'vitest';
import * as scoring from '../index';

describe('scoring public API surface', () => {
  it('re-exports the frozen value exports', () => {
    expect(scoring.SCHEMA_VERSION).toBe(1);
    expect(scoring.SCORING.FUEL_POINTS).toBe(1);
    expect(typeof scoring.isInactive).toBe('function');
    expect(typeof scoring.isWindowActive).toBe('function');
    expect(typeof scoring.shiftNumberOf).toBe('function');
    expect(typeof scoring.computeAggregates).toBe('function');
    expect(typeof scoring.migrateUp).toBe('function');
    expect(scoring.SHIFT_BOUNDS.shift1).toEqual({ start: 10000, end: 35000 });
  });

  it('wires computeAggregates end-to-end through the barrel', () => {
    const agg = scoring.computeAggregates({
      schemaVersion: scoring.SCHEMA_VERSION,
      inactiveFirst: false,
      climbLevel: 0,
      autoClimbLevel1: false,
      fuelBursts: [{ startMs: 0, endMs: 10000, rate: 1, window: 'auto' }], // 10
    });
    expect(agg.autoFuel).toBe(10);
    expect(agg.fuelPoints).toBe(10);
  });
});
```
Run: `npm run test -- src/scoring/__tests__/index.test.ts`
Expected output: FAIL — Vitest cannot resolve `'../index'` (module not found), confirming the test runs and fails before implementation.

- [ ] **Step 2: Implement `src/scoring/index.ts` re-exporting the public API.**
```ts
// src/scoring/index.ts
export { SCHEMA_VERSION, SCORING } from './constants';
export type {
  MatchWindow,
  FuelBurst,
  MatchReportInputs,
  MatchReportAggregates,
} from './types';
export { SHIFT_BOUNDS, isInactive, isWindowActive, shiftNumberOf } from './windows';
export { computeAggregates } from './compute';
export { migrateUp } from './migrations';
export type { AnyReport } from './migrations';
```
Run: `npm run test -- src/scoring/__tests__/index.test.ts`
Expected output: PASS — re-export surface and end-to-end barrel cases green, 0 failures.

- [ ] **Step 3: Run the full scoring suite to confirm the cluster is green together.**
```bash
npm run test -- src/scoring
```
Expected output: PASS — all scoring test files (`windows.test.ts`, `compute.test.ts`, `migrations.test.ts`, `index.test.ts`) green, 0 failures. This satisfies Phase 0 acceptance #6 (8 parity cases, always-active phases, boundary-straddling burst, round-half-up).

- [ ] **Step 4: Commit.**
```bash
git add src/scoring/index.ts src/scoring/__tests__/index.test.ts && git commit -m "feat: add scoring barrel re-export + public API surface test"
```
Expected output: one commit created reporting 2 files changed.

<!-- ===== Cluster C ===== -->

### Task C1

**Files:**
- Create: `supabase/config.toml` (note only)
- Create: `supabase/migrations/0001_schema.sql`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Consumes: none (first DB task). Live project ref `oztsfxyfovwnwutrxzmo`; `SUPABASE_SECRET_KEY`, `VITE_SUPABASE_URL` from `.env.local`.
- Produces: tables `event`, `event_secret`, `team`, `event_team`, `match`, `scout`, `profile`, `assignment`, `match_scouting_report`, `pit_scouting_report`, `pit_report_history` with FROZEN columns + indexes.

- [ ] **Step 1: Add config.toml note.** Create `supabase/config.toml`.
```toml
# Supabase project config (note only for Phase 0).
# Linked project ref: oztsfxyfovwnwutrxzmo
# URL: https://oztsfxyfovwnwutrxzmo.supabase.co
# Migrations are applied with: npx supabase link --project-ref oztsfxyfovwnwutrxzmo && npx supabase db push
project_id = "oztsfxyfovwnwutrxzmo"
```
Run: `test -f supabase/config.toml && echo OK`. Expected: `OK`.
Commit: `git add supabase/config.toml && git commit -m "chore: add supabase config note"`

- [ ] **Step 2: Write the failing schema test.** Create `tests/db/schema.test.ts`. This connects with the SECRET key and asserts every FROZEN table is queryable. It will fail until 0001 is pushed.
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;

const TABLES = [
  'event', 'event_secret', 'team', 'event_team', 'match', 'scout',
  'profile', 'assignment', 'match_scouting_report', 'pit_scouting_report',
  'pit_report_history',
];

describe('0001 schema', () => {
  let admin: SupabaseClient;
  beforeAll(() => {
    expect(URL, 'VITE_SUPABASE_URL missing').toBeTruthy();
    expect(SECRET, 'SUPABASE_SECRET_KEY missing').toBeTruthy();
    admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  });

  it.each(TABLES)('table %s exists and is selectable with service role', async (table) => {
    const { error } = await admin.from(table).select('*').limit(1);
    expect(error, `select ${table}: ${error?.message}`).toBeNull();
  });

  it('match_scouting_report has frozen default for staged_fuel via event', async () => {
    const { error } = await admin.from('event').select('staged_fuel_per_match').limit(1);
    expect(error).toBeNull();
  });

  it('match_scouting_report exposes fuel_by_shift int[] and fuel_bursts jsonb columns', async () => {
    const { error } = await admin
      .from('match_scouting_report')
      .select('fuel_by_shift,fuel_bursts,row_revision,deleted')
      .limit(1);
    expect(error).toBeNull();
  });
});
```
Run: `npm run test -- tests/db/schema.test.ts`. Expected: FAIL (tables do not exist; PostgREST returns `relation ... does not exist`).
Commit: `git add tests/db/schema.test.ts && git commit -m "test: failing schema existence test for 0001"`

- [ ] **Step 3: Write 0001_schema.sql (core entity tables).** Create `supabase/migrations/0001_schema.sql` with the first block.
```sql
-- 0001_schema.sql — FROZEN columns. Single team (3256), quals only.
create extension if not exists pgcrypto;

create table event (
  event_key text primary key,
  name text,
  start_date date,
  end_date date,
  timezone text,
  city text,
  state_prov text,
  is_active boolean not null default false,
  staged_fuel_per_match int not null default 504,
  imported_at timestamptz
);

create table event_secret (
  event_key text primary key references event(event_key) on delete cascade,
  join_code text not null
);

create table team (
  team_number int primary key,
  nickname text,
  city text,
  state_prov text,
  rookie_year int
);

create table event_team (
  event_key text references event(event_key),
  team_number int references team(team_number),
  primary key (event_key, team_number)
);

create table match (
  match_key text primary key,
  event_key text references event(event_key),
  comp_level text not null check (comp_level = 'qm'),
  match_number int,
  scheduled_time timestamptz,
  red1 int, red2 int, red3 int,
  blue1 int, blue2 int, blue3 int,
  actual_red_score int,
  actual_blue_score int,
  red_auto_fuel int,
  blue_auto_fuel int,
  winner text,
  result_synced_at timestamptz
);

create table scout (
  id uuid primary key default gen_random_uuid(),
  event_key text references event(event_key),
  display_name text not null,
  auth_uid uuid not null unique,
  created_at timestamptz default now()
);

create table profile (
  auth_uid uuid primary key,
  role text not null default 'scouter' check (role in ('scouter','lead','admin'))
);

create table assignment (
  id uuid primary key default gen_random_uuid(),
  event_key text references event(event_key),
  match_key text references match(match_key),
  scout_id uuid references scout(id),
  alliance_color text check (alliance_color in ('red','blue')),
  station int check (station between 1 and 3),
  target_team_number int references team(team_number),
  source text check (source in ('manual','auto'))
);
```
Run: `grep -c "create table" supabase/migrations/0001_schema.sql`. Expected: `8` (so far).
(No commit yet — file continues in Step 4.)

- [ ] **Step 4: Append report tables + indexes to 0001_schema.sql.** Append to the same file.
```sql

create table match_scouting_report (
  id uuid primary key default gen_random_uuid(),
  schema_version int not null,
  app_version text,
  device_id text,
  created_at timestamptz not null default now(),
  server_received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_revision bigint not null default 1,
  deleted boolean not null default false,
  event_key text not null references event(event_key),
  match_key text not null references match(match_key),
  scout_id uuid not null references scout(id),
  target_team_number int not null references team(team_number),
  alliance_color text not null check (alliance_color in ('red','blue')),
  station int not null check (station between 1 and 3),
  inactive_first boolean,
  inactive_first_source text check (inactive_first_source in ('derived','scout','official')),
  teleop_clock_unconfirmed boolean default false,
  fuel_bursts jsonb not null default '[]'::jsonb,
  auto_fuel int default 0,
  teleop_fuel_active int default 0,
  teleop_fuel_inactive int default 0,
  endgame_fuel int default 0,
  fuel_by_shift int[] default '{0,0,0,0}',
  fuel_points int default 0,
  fuel_estimate_confidence numeric,
  climb_level int default 0 check (climb_level between 0 and 3),
  climb_attempted boolean default false,
  climb_success boolean default false,
  auto_start_position jsonb,
  auto_path jsonb,
  auto_left_starting_line boolean default false,
  auto_climb_level1 boolean default false,
  intake_sources text[] default '{}',
  max_fuel_capacity_observed int default 0,
  defense_rating int default 0 check (defense_rating between 0 and 3),
  pins int default 0,
  fouls_minor int default 0,
  fouls_major int default 0,
  no_show boolean default false,
  died boolean default false,
  tipped boolean default false,
  dropped_fuel boolean default false,
  fed_corral boolean default false,
  notes text,
  constraint uq_report_match_scout unique (match_key, scout_id)
);

create table pit_scouting_report (
  event_key text references event(event_key),
  team_number int references team(team_number),
  drivetrain text,
  mechanisms jsonb,
  capabilities jsonb,
  photo_path text,
  notes text,
  row_revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  server_received_at timestamptz not null default now(),
  deleted boolean not null default false,
  author_scout_id uuid references scout(id),
  primary key (event_key, team_number)
);

create table pit_report_history (
  id uuid primary key default gen_random_uuid(),
  event_key text,
  team_number int,
  snapshot jsonb,
  created_at timestamptz default now()
);

-- Partial unique index (active reports only); coexists with uq_report_match_scout
-- which guards the hard table-level uniqueness. The partial index documents the
-- soft-delete-aware intent and is the index referenced by upsert ON CONFLICT.
create unique index idx_msr_match_scout_active
  on match_scouting_report (match_key, scout_id) where not deleted;

create index idx_msr_event_match on match_scouting_report (event_key, match_key);
create index idx_msr_target_team on match_scouting_report (target_team_number);
create index idx_msr_scout on match_scouting_report (scout_id);
create index idx_assignment_match on assignment (match_key);
create index idx_assignment_scout on assignment (scout_id);
```
Run: `grep -c "create table" supabase/migrations/0001_schema.sql`. Expected: `11`.
(No commit yet — push in Step 5.)

- [ ] **Step 5: Push migration and verify test passes.** Link + push the migration to the live project, then re-run the test.
```bash
npx supabase link --project-ref oztsfxyfovwnwutrxzmo
npx supabase db push
npm run test -- tests/db/schema.test.ts
```
Expected: `db push` reports `Applying migration 0001_schema.sql...` and finishes with no error; vitest prints all schema tests passing (`Test Files 1 passed`).
Commit: `git add supabase/migrations/0001_schema.sql && git commit -m "feat: 0001 database schema (tables + indexes)"`

### Task C2

**Files:**
- Create: `supabase/migrations/0002_triggers.sql`
- Test: `tests/db/triggers.test.ts`

**Interfaces:**
- Consumes: tables from `supabase/migrations/0001_schema.sql`. The fuel-by-window math FROZEN in `src/scoring/windows.ts` + `src/scoring/compute.ts` (teleop windows ms: transition [0,10000) shift1 [10000,35000) shift2 [35000,60000) shift3 [60000,85000) shift4 [85000,110000) endgame [110000,140000); auto [0,20000); `isInactive(n, inactiveFirst) = ((n%2)===1)===inactiveFirst`; fuel per burst = `rate*(endMs-startMs)/1000`; round half-up once per window; fuelPoints = sum of rounded fuel in active windows × 1).
- Produces: trigger function `msr_bump_meta()` (BEFORE UPDATE) bumping `updated_at`/`server_received_at` and incrementing `row_revision`; plpgsql `recompute_match_report_aggregates(uuid)` mirroring the TS math.

- [ ] **Step 1: Write failing trigger/recompute test.** Create `tests/db/triggers.test.ts`. Uses SECRET key to seed an event/team/match/scout, insert a report with known `fuel_bursts`, call `recompute_match_report_aggregates`, and assert aggregates equal the TS golden values. Also asserts the BEFORE UPDATE bump.
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
let admin: SupabaseClient;

const EVENT = 'TESTC2evt';
const TEAM = 999001;
const MATCH = 'TESTC2evt_qm1';
let scoutId = '';
let reportId = '';

beforeAll(async () => {
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  await admin.from('event').upsert({ event_key: EVENT, name: 'C2 Test', is_active: true });
  await admin.from('team').upsert({ team_number: TEAM, nickname: 'C2' });
  await admin.from('match').upsert({ match_key: MATCH, event_key: EVENT, comp_level: 'qm', match_number: 1 });
  const { data: s } = await admin.from('scout')
    .upsert({ event_key: EVENT, display_name: 'C2 scout', auth_uid: crypto.randomUUID() }, { onConflict: 'auth_uid' })
    .select().single();
  scoutId = s!.id;
});

afterAll(async () => {
  if (reportId) await admin.from('match_scouting_report').delete().eq('id', reportId);
  await admin.from('scout').delete().eq('id', scoutId);
  await admin.from('match').delete().eq('match_key', MATCH);
  await admin.from('event_team').delete().eq('event_key', EVENT);
  await admin.from('team').delete().eq('team_number', TEAM);
  await admin.from('event').delete().eq('event_key', EVENT);
});

it('recompute mirrors TS fuel-by-window math; inactiveFirst parity + boundary + rounding', async () => {
  // inactive_first = true => shift1,shift3 inactive; shift2,shift4 active.
  // Bursts (window labels are advisory; recompute classifies by startMs):
  //  auto: 20s @ rate 1.0     -> 20 fuel (active)
  //  transition: 10s @ 0.5    -> 5 fuel (active)
  //  shift1 (inactive): 25s @ 2 -> 50 fuel (NOT counted in points; in teleop_fuel_inactive)
  //  shift2 (active): 25s @ 2 -> 50 fuel
  //  burst straddling 1:45 endgame boundary: start 105000 end 115000 @ 1.0 -> 10 fuel; startMs=105000 is shift4 (active)
  //  rounding: 3s @ 0.5 = 1.5 -> rounds half-up to 2 (its own window)
  const bursts = [
    { startMs: 0, endMs: 20000, rate: 1.0, window: 'auto' },
    { startMs: 0, endMs: 10000, rate: 0.5, window: 'transition' },
    { startMs: 10000, endMs: 35000, rate: 2.0, window: 'shift1' },
    { startMs: 35000, endMs: 60000, rate: 2.0, window: 'shift2' },
    { startMs: 105000, endMs: 115000, rate: 1.0, window: 'shift4' },
    { startMs: 60000, endMs: 63000, rate: 0.5, window: 'shift3' },
  ];
  const { data: r, error: insErr } = await admin.from('match_scouting_report').insert({
    schema_version: 1, event_key: EVENT, match_key: MATCH, scout_id: scoutId,
    target_team_number: TEAM, alliance_color: 'red', station: 1,
    inactive_first: true, fuel_bursts: bursts,
  }).select().single();
  expect(insErr, insErr?.message).toBeNull();
  reportId = r!.id;

  const { error: rcErr } = await admin.rpc('recompute_match_report_aggregates', { p_report_id: reportId });
  expect(rcErr, rcErr?.message).toBeNull();

  const { data: out } = await admin.from('match_scouting_report')
    .select('auto_fuel,teleop_fuel_active,teleop_fuel_inactive,endgame_fuel,fuel_by_shift,fuel_points')
    .eq('id', reportId).single();

  // auto burst classified to auto window only.
  expect(out!.auto_fuel).toBe(20);
  // fuel_by_shift indexes 0..3 = shift1..shift4 rounded per window.
  // shift1: 25s*2=50 ; shift2: 25s*2=50 ; shift3: 3s*0.5=1.5 -> 2 ; shift4: burst start 105000 -> window shift4, 10s*1=10
  expect(out!.fuel_by_shift).toEqual([50, 50, 2, 10]);
  // endgame_fuel: no burst with startMs>=110000 -> 0
  expect(out!.endgame_fuel).toBe(0);
  // teleop_fuel_active = transition(5) + active shifts(shift2=50, shift4=10) = 65
  expect(out!.teleop_fuel_active).toBe(65);
  // teleop_fuel_inactive = inactive shifts shift1(50)+shift3(2) = 52
  expect(out!.teleop_fuel_inactive).toBe(52);
  // fuel_points = active windows: auto(20)+transition(5)+endgame(0)+shift2(50)+shift4(10) = 85, *1
  expect(out!.fuel_points).toBe(85);
});

it('BEFORE UPDATE bumps row_revision and updated_at', async () => {
  const before = await admin.from('match_scouting_report')
    .select('row_revision,updated_at').eq('id', reportId).single();
  await admin.from('match_scouting_report').update({ notes: 'touch' }).eq('id', reportId);
  const after = await admin.from('match_scouting_report')
    .select('row_revision,updated_at').eq('id', reportId).single();
  expect(after.data!.row_revision).toBe(before.data!.row_revision + 1);
  expect(new Date(after.data!.updated_at).getTime())
    .toBeGreaterThanOrEqual(new Date(before.data!.updated_at).getTime());
});
```
Run: `npm run test -- tests/db/triggers.test.ts`. Expected: FAIL (function `recompute_match_report_aggregates` does not exist).
Commit: `git add tests/db/triggers.test.ts && git commit -m "test: failing triggers + recompute golden test"`

- [ ] **Step 2: Write 0002_triggers.sql — meta-bump trigger.** Create `supabase/migrations/0002_triggers.sql`.
```sql
-- 0002_triggers.sql — server-authoritative metadata + recompute.

-- BEFORE UPDATE: bump revision + timestamps. row_revision is monotonic per row.
create or replace function msr_bump_meta()
returns trigger
language plpgsql
as $$
begin
  new.row_revision := old.row_revision + 1;
  new.updated_at := now();
  new.server_received_at := now();
  return new;
end;
$$;

drop trigger if exists trg_msr_bump_meta on match_scouting_report;
create trigger trg_msr_bump_meta
  before update on match_scouting_report
  for each row execute function msr_bump_meta();
```
Run: `grep -c "create or replace function" supabase/migrations/0002_triggers.sql`. Expected: `1` (so far).
(No commit — file continues.)

- [ ] **Step 3: Append recompute function (window classification mirroring TS).** Append to `0002_triggers.sql`. Helpers classify by `startMs`, compute float fuel per burst, round half-up once per window, then derive active/inactive sums using the FROZEN `isInactive` rule.
```sql

-- Maps a burst's startMs to a window label identical to src/scoring/windows.ts.
-- Auto [0,20000) is reported in separate bursts whose window='auto'; we trust the
-- explicit 'auto' label for the auto phase, and classify all other bursts by teleop ms.
create or replace function msr_window_of(p_window text, p_start_ms int)
returns text
language plpgsql
immutable
as $$
begin
  if p_window = 'auto' then
    return 'auto';
  end if;
  if p_start_ms < 10000 then return 'transition';
  elsif p_start_ms < 35000 then return 'shift1';
  elsif p_start_ms < 60000 then return 'shift2';
  elsif p_start_ms < 85000 then return 'shift3';
  elsif p_start_ms < 110000 then return 'shift4';
  else return 'endgame';
  end if;
end;
$$;

-- FROZEN: isInactive(n, inactiveFirst) = ((n % 2) = 1) = inactiveFirst
create or replace function msr_is_inactive(p_shift int, p_inactive_first boolean)
returns boolean
language plpgsql
immutable
as $$
begin
  return ((p_shift % 2) = 1) = p_inactive_first;
end;
$$;

-- Round half-up (away from +inf for non-negative values) to integer, mirroring TS.
create or replace function msr_round_half_up(p_val numeric)
returns int
language plpgsql
immutable
as $$
begin
  return floor(p_val + 0.5)::int;
end;
$$;

create or replace function recompute_match_report_aggregates(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  b jsonb;
  win text;
  -- float accumulators per window
  f_auto numeric := 0;
  f_transition numeric := 0;
  f_endgame numeric := 0;
  f_shift numeric[] := array[0,0,0,0]::numeric[];
  -- rounded results
  r_auto int; r_transition int; r_endgame int;
  r_shift int[] := array[0,0,0,0];
  v_active int := 0;
  v_inactive int := 0;
  v_points int := 0;
  v_inactive_first boolean;
  i int;
  burst_fuel numeric;
begin
  select * into r from match_scouting_report where id = p_report_id;
  if not found then
    return;
  end if;
  v_inactive_first := coalesce(r.inactive_first, false);

  for b in select * from jsonb_array_elements(r.fuel_bursts)
  loop
    burst_fuel := (b->>'rate')::numeric
      * ((b->>'endMs')::numeric - (b->>'startMs')::numeric) / 1000.0;
    win := msr_window_of(b->>'window', (b->>'startMs')::int);
    if win = 'auto' then
      f_auto := f_auto + burst_fuel;
    elsif win = 'transition' then
      f_transition := f_transition + burst_fuel;
    elsif win = 'endgame' then
      f_endgame := f_endgame + burst_fuel;
    elsif win = 'shift1' then
      f_shift[1] := f_shift[1] + burst_fuel;
    elsif win = 'shift2' then
      f_shift[2] := f_shift[2] + burst_fuel;
    elsif win = 'shift3' then
      f_shift[3] := f_shift[3] + burst_fuel;
    elsif win = 'shift4' then
      f_shift[4] := f_shift[4] + burst_fuel;
    end if;
  end loop;

  -- Round half-up once per window (matches TS: round per window, not per burst).
  r_auto := msr_round_half_up(f_auto);
  r_transition := msr_round_half_up(f_transition);
  r_endgame := msr_round_half_up(f_endgame);
  for i in 1..4 loop
    r_shift[i] := msr_round_half_up(f_shift[i]);
  end loop;

  -- Active/inactive teleop sums + points.
  -- Always-active windows: auto, transition, endgame.
  -- shiftN active iff NOT msr_is_inactive(N, inactiveFirst).
  v_active := r_transition + r_endgame; -- teleop active (excludes auto)
  for i in 1..4 loop
    if msr_is_inactive(i, v_inactive_first) then
      v_inactive := v_inactive + r_shift[i];
    else
      v_active := v_active + r_shift[i];
    end if;
  end loop;

  -- fuelPoints: all active windows incl auto, * FUEL_POINTS (=1).
  v_points := r_auto + r_transition + r_endgame;
  for i in 1..4 loop
    if not msr_is_inactive(i, v_inactive_first) then
      v_points := v_points + r_shift[i];
    end if;
  end loop;

  update match_scouting_report
  set auto_fuel = r_auto,
      teleop_fuel_active = v_active,
      teleop_fuel_inactive = v_inactive,
      endgame_fuel = r_endgame,
      fuel_by_shift = r_shift,
      fuel_points = v_points * 1  -- SCORING.FUEL_POINTS
  where id = p_report_id;
end;
$$;
```
Run: `grep -c "create or replace function" supabase/migrations/0002_triggers.sql`. Expected: `5`.
(No commit — push next.)

- [ ] **Step 4: Push 0002 and verify golden test passes.**
```bash
npx supabase db push
npm run test -- tests/db/triggers.test.ts
```
Expected: `db push` applies `0002_triggers.sql` with no error; vitest prints both tests passing (`2 passed`), confirming parity, the 1:45 boundary burst (start 105000 → shift4 active), and half-up rounding (1.5 → 2).
Commit: `git add supabase/migrations/0002_triggers.sql && git commit -m "feat: 0002 meta-bump trigger + recompute_match_report_aggregates"`

### Task C3

**Files:**
- Create: `supabase/migrations/0003_rls.sql`
- Test: `tests/db/rls.test.ts`

**Interfaces:**
- Consumes: tables from 0001, trigger/functions from 0002. RLS tests use `VITE_SUPABASE_PUBLISHABLE_KEY` (anon) and `SUPABASE_SECRET_KEY` (setup) from `.env.local`.
- Produces: RLS enabled default-deny on all tables; read policies via `EXISTS` on `scout` membership; anon insert-only write policy on `match_scouting_report` with `WITH CHECK` resolving `scout_id` from `auth.uid()`; `join_code` never readable (lives in `event_secret`, which stays deny-all to anon).

- [ ] **Step 1: Write failing RLS test.** Create `tests/db/rls.test.ts`. Seeds via SECRET, then proves: an anonymous user with a matching `scout` row can read its `event`/`match`, cannot read `event_secret`, can insert a report for its own `scout_id`, and CANNOT insert with a foreign `scout_id`.
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;

const EVENT = 'TESTC3evt';
const TEAM = 999003;
const MATCH = 'TESTC3evt_qm1';
let admin: SupabaseClient;
let anon: SupabaseClient;
let myScoutId = '';
let foreignScoutId = '';
let myUid = '';

beforeAll(async () => {
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  await admin.from('event').upsert({ event_key: EVENT, name: 'C3', is_active: true });
  await admin.from('event_secret').upsert({ event_key: EVENT, join_code: 'SECRET99' });
  await admin.from('team').upsert({ team_number: TEAM, nickname: 'C3' });
  await admin.from('match').upsert({ match_key: MATCH, event_key: EVENT, comp_level: 'qm', match_number: 1 });

  // anon client signs in anonymously to obtain a real auth.uid().
  anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: signin, error: sErr } = await anon.auth.signInAnonymously();
  expect(sErr, sErr?.message).toBeNull();
  myUid = signin!.user!.id;

  // bind a scout row to that uid (membership).
  const { data: s } = await admin.from('scout')
    .insert({ event_key: EVENT, display_name: 'me', auth_uid: myUid }).select().single();
  myScoutId = s!.id;

  // a foreign scout (different uid) used to prove impersonation is rejected.
  const { data: fs } = await admin.from('scout')
    .insert({ event_key: EVENT, display_name: 'other', auth_uid: crypto.randomUUID() }).select().single();
  foreignScoutId = fs!.id;
});

afterAll(async () => {
  await admin.from('match_scouting_report').delete().eq('event_key', EVENT);
  await admin.from('scout').delete().eq('event_key', EVENT);
  await admin.from('match').delete().eq('match_key', MATCH);
  await admin.from('team').delete().eq('team_number', TEAM);
  await admin.from('event_secret').delete().eq('event_key', EVENT);
  await admin.from('event').delete().eq('event_key', EVENT);
});

it('anon member can read its event', async () => {
  const { data, error } = await anon.from('event').select('event_key,name').eq('event_key', EVENT);
  expect(error).toBeNull();
  expect(data?.length).toBe(1);
});

it('anon CANNOT read event_secret (join_code hidden)', async () => {
  const { data, error } = await anon.from('event_secret').select('join_code').eq('event_key', EVENT);
  // RLS default-deny => empty result set (no rows), not an error.
  expect(error).toBeNull();
  expect(data?.length).toBe(0);
});

it('anon member can read its event matches', async () => {
  const { data, error } = await anon.from('match').select('match_key').eq('event_key', EVENT);
  expect(error).toBeNull();
  expect(data?.length).toBe(1);
});

it('anon can insert a report for its OWN scout_id', async () => {
  const { error } = await anon.from('match_scouting_report').insert({
    schema_version: 1, event_key: EVENT, match_key: MATCH, scout_id: myScoutId,
    target_team_number: TEAM, alliance_color: 'red', station: 1, fuel_bursts: [],
  });
  expect(error, error?.message).toBeNull();
});

it('anon CANNOT insert a report with a FOREIGN scout_id', async () => {
  const { error } = await anon.from('match_scouting_report').insert({
    schema_version: 1, event_key: EVENT, match_key: MATCH, scout_id: foreignScoutId,
    target_team_number: TEAM, alliance_color: 'blue', station: 2, fuel_bursts: [],
  });
  expect(error, 'foreign insert must be rejected by WITH CHECK').not.toBeNull();
  expect(error?.code).toBe('42501'); // RLS violation
});
```
Run: `npm run test -- tests/db/rls.test.ts`. Expected: FAIL (RLS not enabled yet — `event_secret` is readable and the foreign insert succeeds).
Commit: `git add tests/db/rls.test.ts && git commit -m "test: failing RLS membership + insert-guard test"`

- [ ] **Step 2: Write 0003_rls.sql — enable RLS default-deny on all tables.** Create `supabase/migrations/0003_rls.sql`.
```sql
-- 0003_rls.sql — default-deny everywhere; explicit grants below.
alter table event enable row level security;
alter table event_secret enable row level security;
alter table team enable row level security;
alter table event_team enable row level security;
alter table match enable row level security;
alter table scout enable row level security;
alter table profile enable row level security;
alter table assignment enable row level security;
alter table match_scouting_report enable row level security;
alter table pit_scouting_report enable row level security;
alter table pit_report_history enable row level security;

-- event_secret has NO policies -> default deny to anon/authenticated.
-- join_code is therefore never readable by the client; it is only read inside
-- SECURITY DEFINER RPCs (join_event/recover_identity) in 0004.
```
Run: `grep -c "enable row level security" supabase/migrations/0003_rls.sql`. Expected: `11`.
(No commit — file continues.)

- [ ] **Step 3: Append membership read policies.** Append to `0003_rls.sql`. Membership = the caller has a `scout` row (`auth_uid = auth.uid()`) in the same event.
```sql

-- Helper: events the current auth.uid() is a member of (via scout row).
-- Inlined as EXISTS in each policy to keep policies self-contained.

-- event: readable if caller is a scout in that event.
create policy event_read_member on event
  for select to authenticated
  using (exists (
    select 1 from scout s
    where s.auth_uid = auth.uid() and s.event_key = event.event_key
  ));

-- match: readable for matches in the caller's event.
create policy match_read_member on match
  for select to authenticated
  using (exists (
    select 1 from scout s
    where s.auth_uid = auth.uid() and s.event_key = match.event_key
  ));

-- team: readable if the team participates in any of the caller's events.
create policy team_read_member on team
  for select to authenticated
  using (exists (
    select 1 from event_team et
    join scout s on s.event_key = et.event_key
    where s.auth_uid = auth.uid() and et.team_number = team.team_number
  ));

-- event_team: readable within the caller's event.
create policy event_team_read_member on event_team
  for select to authenticated
  using (exists (
    select 1 from scout s
    where s.auth_uid = auth.uid() and s.event_key = event_team.event_key
  ));

-- scout: caller can read scout rows in its own event (to see teammates).
create policy scout_read_member on scout
  for select to authenticated
  using (exists (
    select 1 from scout me
    where me.auth_uid = auth.uid() and me.event_key = scout.event_key
  ));

-- profile: caller reads only its own profile.
create policy profile_read_self on profile
  for select to authenticated
  using (profile.auth_uid = auth.uid());

-- assignment: readable within the caller's event.
create policy assignment_read_member on assignment
  for select to authenticated
  using (exists (
    select 1 from scout s
    where s.auth_uid = auth.uid() and s.event_key = assignment.event_key
  ));

-- match_scouting_report: readable within the caller's event.
create policy msr_read_member on match_scouting_report
  for select to authenticated
  using (exists (
    select 1 from scout s
    where s.auth_uid = auth.uid() and s.event_key = match_scouting_report.event_key
  ));

-- pit_scouting_report: readable within the caller's event.
create policy pit_read_member on pit_scouting_report
  for select to authenticated
  using (exists (
    select 1 from scout s
    where s.auth_uid = auth.uid() and s.event_key = pit_scouting_report.event_key
  ));
```
Run: `grep -c "create policy" supabase/migrations/0003_rls.sql`. Expected: `9`.
(No commit — file continues.)

- [ ] **Step 4: Append insert-only write policies resolving scout_id from auth.uid().** Append to `0003_rls.sql`. The `WITH CHECK` requires the inserted `scout_id` to belong to the caller's own `auth.uid()` and matching event — this is what rejects a foreign `scout_id`.
```sql

-- match_scouting_report: anon (authenticated anon user) may INSERT only rows whose
-- scout_id resolves to its own auth.uid() and whose event matches that scout's event.
-- Updates/deletes from the client are NOT granted (server RPC owns mutation).
create policy msr_insert_self on match_scouting_report
  for insert to authenticated
  with check (exists (
    select 1 from scout s
    where s.id = match_scouting_report.scout_id
      and s.auth_uid = auth.uid()
      and s.event_key = match_scouting_report.event_key
  ));

-- pit_scouting_report: insert only as self (author_scout_id resolves to auth.uid()).
create policy pit_insert_self on pit_scouting_report
  for insert to authenticated
  with check (exists (
    select 1 from scout s
    where s.id = pit_scouting_report.author_scout_id
      and s.auth_uid = auth.uid()
      and s.event_key = pit_scouting_report.event_key
  ));
```
Run: `grep -c "create policy" supabase/migrations/0003_rls.sql`. Expected: `11`.
(No commit — push next.)

- [ ] **Step 5: Push 0003 and verify RLS test passes.**
```bash
npx supabase db push
npm run test -- tests/db/rls.test.ts
```
Expected: `db push` applies `0003_rls.sql`; vitest prints all 5 RLS tests passing — anon member reads its event/match, gets 0 rows from `event_secret`, inserts its own report, and the foreign-`scout_id` insert fails with code `42501`.
Commit: `git add supabase/migrations/0003_rls.sql && git commit -m "feat: 0003 RLS default-deny + membership reads + insert-self guard"`

### Task C4

**Files:**
- Create: `supabase/migrations/0004_rpcs.sql`
- Test: `tests/db/rpcs.test.ts`

**Interfaces:**
- Consumes: tables from 0001, `recompute_match_report_aggregates` from 0002, RLS from 0003. Tests use `VITE_SUPABASE_PUBLISHABLE_KEY` (anon, to prove `join_event` flow) and `SUPABASE_SECRET_KEY` (setup) from `.env.local`.
- Produces: `join_event(p_code text, p_display_name text) returns scout`; `recover_identity(p_code text, p_display_name text) returns scout`; `rotate_join_code(p_event_key text) returns text`; `upsert_match_report(p jsonb) returns void` (revision-guarded); all SECURITY DEFINER.

- [ ] **Step 1: Write failing RPC test.** Create `tests/db/rpcs.test.ts`. Proves anonymous sign-in + `join_event` creates a scout, idempotency, wrong code rejection, and revision-guarded `upsert_match_report` (lower revision is ignored, higher wins, recompute fires).
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env.local' });

const URL = process.env.VITE_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;

const EVENT = 'TESTC4evt';
const TEAM = 999004;
const MATCH = 'TESTC4evt_qm1';
const CODE = 'JOINC4';
let admin: SupabaseClient;
let anon: SupabaseClient;
let myUid = '';
let myScoutId = '';

beforeAll(async () => {
  admin = createClient(URL, SECRET, { auth: { persistSession: false } });
  await admin.from('event').upsert({ event_key: EVENT, name: 'C4', is_active: true });
  await admin.from('event_secret').upsert({ event_key: EVENT, join_code: CODE });
  await admin.from('team').upsert({ team_number: TEAM, nickname: 'C4' });
  await admin.from('match').upsert({ match_key: MATCH, event_key: EVENT, comp_level: 'qm', match_number: 1 });
  anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
});

afterAll(async () => {
  await admin.from('match_scouting_report').delete().eq('event_key', EVENT);
  await admin.from('scout').delete().eq('event_key', EVENT);
  await admin.from('match').delete().eq('match_key', MATCH);
  await admin.from('team').delete().eq('team_number', TEAM);
  await admin.from('event_secret').delete().eq('event_key', EVENT);
  await admin.from('event').delete().eq('event_key', EVENT);
});

it('anon sign-in + join_event creates a scout row', async () => {
  const { data: signin, error: sErr } = await anon.auth.signInAnonymously();
  expect(sErr, sErr?.message).toBeNull();
  myUid = signin!.user!.id;
  const { data, error } = await anon.rpc('join_event', { p_code: CODE, p_display_name: 'C4 scout' });
  expect(error, error?.message).toBeNull();
  expect(data?.event_key).toBe(EVENT);
  expect(data?.auth_uid).toBe(myUid);
  myScoutId = data!.id;
});

it('join_event is idempotent for same uid+event', async () => {
  const { data, error } = await anon.rpc('join_event', { p_code: CODE, p_display_name: 'C4 scout' });
  expect(error).toBeNull();
  expect(data?.id).toBe(myScoutId);
});

it('join_event rejects a wrong code', async () => {
  const { error } = await anon.rpc('join_event', { p_code: 'WRONG', p_display_name: 'x' });
  expect(error).not.toBeNull();
});

it('upsert_match_report is revision-guarded and triggers recompute', async () => {
  const reportId = crypto.randomUUID();
  const base = {
    id: reportId, schema_version: 1, event_key: EVENT, match_key: MATCH,
    scout_id: myScoutId, target_team_number: TEAM, alliance_color: 'red',
    station: 1, inactive_first: false, row_revision: 5,
    fuel_bursts: [{ startMs: 0, endMs: 20000, rate: 1.0, window: 'auto' }],
  };
  // initial insert at revision 5
  let res = await anon.rpc('upsert_match_report', { p: base });
  expect(res.error, res.error?.message).toBeNull();
  let row = await admin.from('match_scouting_report')
    .select('row_revision,auto_fuel,fuel_points').eq('id', reportId).single();
  expect(row.data!.auto_fuel).toBe(20);   // recompute ran
  expect(row.data!.fuel_points).toBe(20);

  // stale write at revision 3 must be IGNORED
  res = await anon.rpc('upsert_match_report', {
    p: { ...base, row_revision: 3, fuel_bursts: [{ startMs: 0, endMs: 10000, rate: 5, window: 'auto' }] },
  });
  expect(res.error).toBeNull();
  row = await admin.from('match_scouting_report').select('auto_fuel').eq('id', reportId).single();
  expect(row.data!.auto_fuel).toBe(20);    // unchanged — stale rejected

  // newer write at revision 9 wins
  res = await anon.rpc('upsert_match_report', {
    p: { ...base, row_revision: 9, fuel_bursts: [{ startMs: 0, endMs: 10000, rate: 4, window: 'auto' }] },
  });
  expect(res.error).toBeNull();
  row = await admin.from('match_scouting_report').select('auto_fuel,row_revision').eq('id', reportId).single();
  expect(row.data!.auto_fuel).toBe(40);    // 10s*4 = 40
  expect(row.data!.row_revision).toBe(9);
});
```
Run: `npm run test -- tests/db/rpcs.test.ts`. Expected: FAIL (`join_event`/`upsert_match_report` do not exist).
Commit: `git add tests/db/rpcs.test.ts && git commit -m "test: failing RPC join/upsert revision-guard test"`

- [ ] **Step 2: Write 0004_rpcs.sql — join_event + recover_identity.** Create `supabase/migrations/0004_rpcs.sql`. Both read `event_secret.join_code` (allowed: SECURITY DEFINER bypasses RLS).
```sql
-- 0004_rpcs.sql — all SECURITY DEFINER. search_path pinned to public.

-- join_event: validate code, create-or-return the scout bound to auth.uid().
create or replace function join_event(p_code text, p_display_name text)
returns scout
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text;
  v_uid uuid := auth.uid();
  v_scout scout;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- rate-limit note: production should throttle by uid; omitted in Phase 0.
  select event_key into v_event_key
  from event_secret where join_code = p_code;
  if v_event_key is null then
    raise exception 'invalid join code' using errcode = 'P0001';
  end if;

  -- idempotent per auth.uid()+event.
  select * into v_scout
  from scout where auth_uid = v_uid and event_key = v_event_key;
  if found then
    return v_scout;
  end if;

  insert into scout (event_key, display_name, auth_uid)
  values (v_event_key, p_display_name, v_uid)
  returning * into v_scout;

  insert into profile (auth_uid) values (v_uid)
  on conflict (auth_uid) do nothing;

  return v_scout;
end;
$$;

-- recover_identity: rebind auth.uid() to an EXISTING scout matched by code+name.
create or replace function recover_identity(p_code text, p_display_name text)
returns scout
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_key text;
  v_uid uuid := auth.uid();
  v_scout scout;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select event_key into v_event_key
  from event_secret where join_code = p_code;
  if v_event_key is null then
    raise exception 'invalid join code' using errcode = 'P0001';
  end if;

  select * into v_scout
  from scout
  where event_key = v_event_key and display_name = p_display_name;
  if not found then
    raise exception 'no scout to recover for that code + name' using errcode = 'P0002';
  end if;

  update scout set auth_uid = v_uid where id = v_scout.id
  returning * into v_scout;

  insert into profile (auth_uid) values (v_uid)
  on conflict (auth_uid) do nothing;

  return v_scout;
end;
$$;

grant execute on function join_event(text, text) to authenticated;
grant execute on function recover_identity(text, text) to authenticated;
```
Run: `grep -c "create or replace function" supabase/migrations/0004_rpcs.sql`. Expected: `2` (so far).
(No commit — file continues.)

- [ ] **Step 3: Append rotate_join_code + upsert_match_report.** Append to `0004_rpcs.sql`. `upsert_match_report` is revision-guarded: insert, or update only where the incoming `row_revision` exceeds the existing; then recompute. The meta-bump trigger increments `row_revision` on UPDATE, so we set it to the incoming value AFTER the trigger by writing it explicitly and letting the guard compare against the pre-update value.
```sql

-- rotate_join_code: admin only. Returns the new code.
create or replace function rotate_join_code(p_event_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_code text;
begin
  select role into v_role from profile where auth_uid = v_uid;
  if v_role is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;

  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  update event_secret set join_code = v_code where event_key = p_event_key;
  if not found then
    raise exception 'no such event' using errcode = 'P0001';
  end if;
  return v_code;
end;
$$;

-- upsert_match_report: revision-guarded insert/update + recompute.
-- The BEFORE UPDATE trigger (msr_bump_meta) would increment row_revision on its
-- own; to make the client-supplied revision authoritative we disable that trigger
-- for the duration of this function via a session GUC the trigger checks.
create or replace function msr_bump_meta()
returns trigger
language plpgsql
as $$
begin
  -- When inside upsert_match_report, the function manages revision explicitly.
  if current_setting('app.skip_msr_bump', true) = 'on' then
    new.updated_at := now();
    new.server_received_at := now();
    return new;
  end if;
  new.row_revision := old.row_revision + 1;
  new.updated_at := now();
  new.server_received_at := now();
  return new;
end;
$$;

create or replace function upsert_match_report(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_incoming_rev bigint := coalesce((p->>'row_revision')::bigint, 1);
  v_existing_rev bigint;
begin
  perform set_config('app.skip_msr_bump', 'on', true);

  select row_revision into v_existing_rev
  from match_scouting_report where id = v_id;

  if v_existing_rev is null then
    -- INSERT new report.
    insert into match_scouting_report (
      id, schema_version, app_version, device_id, event_key, match_key, scout_id,
      target_team_number, alliance_color, station, inactive_first, inactive_first_source,
      teleop_clock_unconfirmed, fuel_bursts, climb_level, climb_attempted, climb_success,
      auto_start_position, auto_path, auto_left_starting_line, auto_climb_level1,
      intake_sources, max_fuel_capacity_observed, defense_rating, pins, fouls_minor,
      fouls_major, no_show, died, tipped, dropped_fuel, fed_corral, notes,
      row_revision, deleted
    ) values (
      v_id,
      (p->>'schema_version')::int,
      p->>'app_version',
      p->>'device_id',
      p->>'event_key',
      p->>'match_key',
      (p->>'scout_id')::uuid,
      (p->>'target_team_number')::int,
      p->>'alliance_color',
      (p->>'station')::int,
      (p->>'inactive_first')::boolean,
      p->>'inactive_first_source',
      coalesce((p->>'teleop_clock_unconfirmed')::boolean, false),
      coalesce(p->'fuel_bursts', '[]'::jsonb),
      coalesce((p->>'climb_level')::int, 0),
      coalesce((p->>'climb_attempted')::boolean, false),
      coalesce((p->>'climb_success')::boolean, false),
      p->'auto_start_position',
      p->'auto_path',
      coalesce((p->>'auto_left_starting_line')::boolean, false),
      coalesce((p->>'auto_climb_level1')::boolean, false),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'intake_sources','[]'::jsonb)) as value),
        '{}'::text[]),
      coalesce((p->>'max_fuel_capacity_observed')::int, 0),
      coalesce((p->>'defense_rating')::int, 0),
      coalesce((p->>'pins')::int, 0),
      coalesce((p->>'fouls_minor')::int, 0),
      coalesce((p->>'fouls_major')::int, 0),
      coalesce((p->>'no_show')::boolean, false),
      coalesce((p->>'died')::boolean, false),
      coalesce((p->>'tipped')::boolean, false),
      coalesce((p->>'dropped_fuel')::boolean, false),
      coalesce((p->>'fed_corral')::boolean, false),
      p->>'notes',
      v_incoming_rev,
      coalesce((p->>'deleted')::boolean, false)
    );
  elsif v_incoming_rev > v_existing_rev then
    -- UPDATE only when strictly newer (revision guard).
    update match_scouting_report set
      schema_version = (p->>'schema_version')::int,
      app_version = p->>'app_version',
      device_id = p->>'device_id',
      target_team_number = (p->>'target_team_number')::int,
      alliance_color = p->>'alliance_color',
      station = (p->>'station')::int,
      inactive_first = (p->>'inactive_first')::boolean,
      inactive_first_source = p->>'inactive_first_source',
      teleop_clock_unconfirmed = coalesce((p->>'teleop_clock_unconfirmed')::boolean, false),
      fuel_bursts = coalesce(p->'fuel_bursts', '[]'::jsonb),
      climb_level = coalesce((p->>'climb_level')::int, 0),
      climb_attempted = coalesce((p->>'climb_attempted')::boolean, false),
      climb_success = coalesce((p->>'climb_success')::boolean, false),
      auto_start_position = p->'auto_start_position',
      auto_path = p->'auto_path',
      auto_left_starting_line = coalesce((p->>'auto_left_starting_line')::boolean, false),
      auto_climb_level1 = coalesce((p->>'auto_climb_level1')::boolean, false),
      intake_sources = coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(coalesce(p->'intake_sources','[]'::jsonb)) as value),
        '{}'::text[]),
      max_fuel_capacity_observed = coalesce((p->>'max_fuel_capacity_observed')::int, 0),
      defense_rating = coalesce((p->>'defense_rating')::int, 0),
      pins = coalesce((p->>'pins')::int, 0),
      fouls_minor = coalesce((p->>'fouls_minor')::int, 0),
      fouls_major = coalesce((p->>'fouls_major')::int, 0),
      no_show = coalesce((p->>'no_show')::boolean, false),
      died = coalesce((p->>'died')::boolean, false),
      tipped = coalesce((p->>'tipped')::boolean, false),
      dropped_fuel = coalesce((p->>'dropped_fuel')::boolean, false),
      fed_corral = coalesce((p->>'fed_corral')::boolean, false),
      notes = p->>'notes',
      deleted = coalesce((p->>'deleted')::boolean, false),
      row_revision = v_incoming_rev
    where id = v_id;
  else
    -- stale or equal revision: ignore.
    perform set_config('app.skip_msr_bump', 'off', true);
    return;
  end if;

  perform set_config('app.skip_msr_bump', 'off', true);
  perform recompute_match_report_aggregates(v_id);
end;
$$;

grant execute on function rotate_join_code(text) to authenticated;
grant execute on function upsert_match_report(jsonb) to authenticated;
```
Run: `grep -c "create or replace function" supabase/migrations/0004_rpcs.sql`. Expected: `5` (join_event, recover_identity, rotate_join_code, redefined msr_bump_meta, upsert_match_report).
(No commit — push next.)

- [ ] **Step 4: Push 0004 and verify RPC test passes.**
```bash
npx supabase db push
npm run test -- tests/db/rpcs.test.ts
```
Expected: `db push` applies `0004_rpcs.sql`; vitest prints all 4 RPC tests passing — anon `join_event` creates a scout bound to `auth.uid()`, idempotency returns the same id, a wrong code raises, and `upsert_match_report` ignores the stale revision-3 write (auto_fuel stays 20), accepts the revision-9 write (auto_fuel becomes 40, row_revision 9), with recompute confirmed.
Commit: `git add supabase/migrations/0004_rpcs.sql && git commit -m "feat: 0004 RPCs join_event/recover_identity/rotate_join_code/upsert_match_report"`

- [ ] **Step 5: Run the full DB suite to confirm cross-task integrity.**
```bash
npm run test -- tests/db
```
Expected: all four files pass (`Test Files 4 passed`), covering schema existence, recompute golden vectors (parity, 1:45 boundary, rounding), RLS membership + insert-self guard, and revision-guarded RPCs against the live project `oztsfxyfovwnwutrxzmo`.
Commit: `git commit --allow-empty -m "test: full Cluster C DB suite green against live project"`

<!-- ===== Cluster D ===== -->

### Task D1: Shared CORS headers

**Files:**
- Create: `supabase/functions/_shared/cors.ts`
- Test: (none — exercised indirectly by D2/D3/D4 deployed tests)

**Interfaces:**
- Produces: `export const corsHeaders: Record<string, string>` (consumed by tba-proxy, statbotics-proxy, ingest-reports)

- [ ] **Step 1: Create the shared CORS module.**
```typescript
// supabase/functions/_shared/cors.ts
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
```
Run + expected:
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && deno check supabase/functions/_shared/cors.ts
# expected: "Check file:///.../supabase/functions/_shared/cors.ts" with exit code 0, no errors
```
- [ ] **Step 2: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add supabase/functions/_shared/cors.ts && git commit -m "feat: add shared CORS headers for edge functions"
```

---

### Task D2: tba-proxy edge function

**Files:**
- Create: `supabase/functions/tba-proxy/index.ts`
- Test: `tests/functions/tba-proxy.test.ts`

**Interfaces:**
- Consumes: `corsHeaders` from `../_shared/cors.ts`; env `TBA_API_KEY` (injected as `X-TBA-Auth-Key`)
- Produces: `GET ?path=/event/2026casnv` -> TBA JSON (passthrough), 200 with CORS headers; in-memory cache keyed by `path`

- [ ] **Step 1: Write the failing deployed-function test.**
```typescript
// tests/functions/tba-proxy.test.ts
import { describe, it, expect } from "vitest";
import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = `${process.env.VITE_SUPABASE_URL}/functions/v1/tba-proxy`;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

describe("tba-proxy (deployed)", () => {
  it("returns the real name for event 2026casnv", async () => {
    const res = await fetch(`${BASE}?path=/event/2026casnv`, {
      headers: { Authorization: `Bearer ${ANON}`, apikey: ANON },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.name).toBe("string");
    expect(body.key).toBe("2026casnv");
  }, 30000);

  it("rejects a missing path with 400", async () => {
    const res = await fetch(BASE, {
      headers: { Authorization: `Bearer ${ANON}`, apikey: ANON },
    });
    expect(res.status).toBe(400);
  }, 30000);
});
```
Run + expected (fails — function not deployed yet):
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- tests/functions/tba-proxy.test.ts
# expected: FAIL — fetch returns 404 (function not found), assertions on status 200 fail
```
- [ ] **Step 2: Commit the failing test.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add tests/functions/tba-proxy.test.ts && git commit -m "test: add deployed tba-proxy event-name test (failing)"
```
- [ ] **Step 3: Implement the tba-proxy function.**
```typescript
// supabase/functions/tba-proxy/index.ts
import { corsHeaders } from "../_shared/cors.ts";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";
const TBA_API_KEY = Deno.env.get("TBA_API_KEY") ?? "";
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expires: number;
  status: number;
  body: string;
}
const cache = new Map<string, CacheEntry>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path || !path.startsWith("/")) {
    return new Response(
      JSON.stringify({ error: "missing or invalid 'path' query param" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  if (!TBA_API_KEY) {
    return new Response(
      JSON.stringify({ error: "TBA_API_KEY not configured" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const now = Date.now();
  const cached = cache.get(path);
  if (cached && cached.expires > now) {
    return new Response(cached.body, {
      status: cached.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Cache": "HIT",
      },
    });
  }

  const upstream = await fetch(`${TBA_BASE}${path}`, {
    headers: { "X-TBA-Auth-Key": TBA_API_KEY, Accept: "application/json" },
  });
  const body = await upstream.text();

  if (upstream.ok) {
    cache.set(path, { expires: now + CACHE_TTL_MS, status: upstream.status, body });
  }

  return new Response(body, {
    status: upstream.status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Cache": "MISS",
    },
  });
});
```
Run + expected:
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && deno check supabase/functions/tba-proxy/index.ts
# expected: exit code 0, no type errors
```
- [ ] **Step 4: Set the secret and deploy.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && set -a && . ./.env.local && set +a && \
npx supabase secrets set TBA_API_KEY="$TBA_API_KEY" --project-ref oztsfxyfovwnwutrxzmo && \
npx supabase functions deploy tba-proxy --project-ref oztsfxyfovwnwutrxzmo
# expected: "Setting secrets..." success, then "Deployed Functions on project oztsfxyfovwnwutrxzmo: tba-proxy"
```
- [ ] **Step 5: Run the test — verify pass.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- tests/functions/tba-proxy.test.ts
# expected: PASS — 2 passed; body.key === "2026casnv", body.name is a string
```
- [ ] **Step 6: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add supabase/functions/tba-proxy/index.ts && git commit -m "feat: add tba-proxy edge function with key injection and cache"
```

---

### Task D3: statbotics-proxy edge function (graceful degrade)

**Files:**
- Create: `supabase/functions/statbotics-proxy/index.ts`
- Test: `tests/functions/statbotics-proxy.test.ts`

**Interfaces:**
- Consumes: `corsHeaders` from `../_shared/cors.ts`
- Produces: proxies `https://api.statbotics.io/v3/...`; on upstream 5xx returns HTTP 200 `{ available: false }`; in-memory cache keyed by `path`

- [ ] **Step 1: Write the failing deployed-function test.**
```typescript
// tests/functions/statbotics-proxy.test.ts
import { describe, it, expect } from "vitest";
import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = `${process.env.VITE_SUPABASE_URL}/functions/v1/statbotics-proxy`;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

describe("statbotics-proxy (deployed)", () => {
  it("proxies a real team request", async () => {
    const res = await fetch(`${BASE}?path=/team/254`, {
      headers: { Authorization: `Bearer ${ANON}`, apikey: ANON },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team).toBe(254);
  }, 30000);

  it("degrades gracefully to {available:false} on upstream 5xx", async () => {
    // _forceUpstreamStatus is a test-only hook that makes the function
    // treat the upstream response as the given status.
    const res = await fetch(`${BASE}?path=/team/254&_forceUpstreamStatus=503`, {
      headers: { Authorization: `Bearer ${ANON}`, apikey: ANON },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
  }, 30000);
});
```
Run + expected (fails — not deployed):
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- tests/functions/statbotics-proxy.test.ts
# expected: FAIL — 404 from undeployed function, status-200 assertions fail
```
- [ ] **Step 2: Commit the failing test.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add tests/functions/statbotics-proxy.test.ts && git commit -m "test: add deployed statbotics-proxy degrade test (failing)"
```
- [ ] **Step 3: Implement the statbotics-proxy function.**
```typescript
// supabase/functions/statbotics-proxy/index.ts
import { corsHeaders } from "../_shared/cors.ts";

const SB_BASE = "https://api.statbotics.io/v3";
const CACHE_TTL_MS = 300_000;

interface CacheEntry {
  expires: number;
  body: string;
}
const cache = new Map<string, CacheEntry>();

function unavailable(): Response {
  return new Response(JSON.stringify({ available: false }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path || !path.startsWith("/")) {
    return new Response(
      JSON.stringify({ error: "missing or invalid 'path' query param" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const now = Date.now();
  const cached = cache.get(path);
  if (cached && cached.expires > now) {
    return new Response(cached.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Cache": "HIT",
      },
    });
  }

  // Test-only hook to simulate an upstream outage.
  const forced = url.searchParams.get("_forceUpstreamStatus");
  if (forced) {
    const code = Number(forced);
    if (code >= 500) return unavailable();
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${SB_BASE}${path}`, {
      headers: { Accept: "application/json" },
    });
  } catch (_err) {
    return unavailable();
  }

  if (upstream.status >= 500) {
    return unavailable();
  }

  const body = await upstream.text();
  if (upstream.ok) {
    cache.set(path, { expires: now + CACHE_TTL_MS, body });
  }

  return new Response(body, {
    status: upstream.status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Cache": "MISS",
    },
  });
});
```
Run + expected:
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && deno check supabase/functions/statbotics-proxy/index.ts
# expected: exit code 0, no type errors
```
- [ ] **Step 4: Deploy (no secret needed).**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npx supabase functions deploy statbotics-proxy --project-ref oztsfxyfovwnwutrxzmo
# expected: "Deployed Functions on project oztsfxyfovwnwutrxzmo: statbotics-proxy"
```
- [ ] **Step 5: Run the test — verify pass.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- tests/functions/statbotics-proxy.test.ts
# expected: PASS — 2 passed; degrade case returns {available:false} with HTTP 200
```
- [ ] **Step 6: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add supabase/functions/statbotics-proxy/index.ts && git commit -m "feat: add statbotics-proxy edge function with graceful degrade"
```

---

### Task D4: ingest-reports edge function (HMAC + upsert skeleton)

**Files:**
- Create: `supabase/functions/ingest-reports/index.ts`
- Test: `tests/functions/ingest-reports.test.ts`

**Interfaces:**
- Consumes: `corsHeaders` from `../_shared/cors.ts`; env `QR_INGEST_HMAC_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (Supabase injects `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`; we read our frozen `SUPABASE_SECRET_KEY`); RPC `upsert_match_report(p jsonb)`
- Produces: `POST { reports: [...], hmac }` -> verifies HMAC (hex SHA-256) over the canonical JSON of `reports`; on mismatch HTTP 401; on success calls `upsert_match_report` per report and returns `{ ingested: number }`

- [ ] **Step 1: Write the failing deployed-function test.**
```typescript
// tests/functions/ingest-reports.test.ts
import { describe, it, expect } from "vitest";
import { config } from "dotenv";
import { createHmac } from "node:crypto";
config({ path: ".env.local" });

const BASE = `${process.env.VITE_SUPABASE_URL}/functions/v1/ingest-reports`;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const SECRET = process.env.QR_INGEST_HMAC_SECRET as string;

function sign(reports: unknown[]): string {
  return createHmac("sha256", SECRET)
    .update(JSON.stringify(reports))
    .digest("hex");
}

describe("ingest-reports (deployed)", () => {
  it("rejects a bad HMAC with 401", async () => {
    const reports: unknown[] = [];
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ANON}`,
        apikey: ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reports, hmac: "deadbeef" }),
    });
    expect(res.status).toBe(401);
  }, 30000);

  it("accepts a valid HMAC over an empty batch", async () => {
    const reports: unknown[] = [];
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ANON}`,
        apikey: ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reports, hmac: sign(reports) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingested).toBe(0);
  }, 30000);
});
```
Run + expected (fails — not deployed):
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- tests/functions/ingest-reports.test.ts
# expected: FAIL — 404 from undeployed function
```
- [ ] **Step 2: Commit the failing test.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add tests/functions/ingest-reports.test.ts && git commit -m "test: add deployed ingest-reports HMAC test (failing)"
```
- [ ] **Step 3: Implement the ingest-reports function.**
```typescript
// supabase/functions/ingest-reports/index.ts
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HMAC_SECRET = Deno.env.get("QR_INGEST_HMAC_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Frozen server key name; fall back to the auto-injected service role key.
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

interface IngestPayload {
  reports: Record<string, unknown>[];
  hmac: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(sig));
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  if (!HMAC_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "server not configured" }, 500);
  }

  let payload: IngestPayload;
  try {
    payload = (await req.json()) as IngestPayload;
  } catch (_err) {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!payload || !Array.isArray(payload.reports) || typeof payload.hmac !== "string") {
    return json({ error: "expected { reports: [], hmac: string }" }, 400);
  }

  const expected = await hmacHex(HMAC_SECRET, JSON.stringify(payload.reports));
  if (!timingSafeEqual(expected, payload.hmac)) {
    return json({ error: "invalid hmac" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let ingested = 0;
  for (const report of payload.reports) {
    const { error } = await supabase.rpc("upsert_match_report", { p: report });
    if (error) {
      return json({ error: error.message, ingested }, 400);
    }
    ingested++;
  }

  return json({ ingested }, 200);
});
```
Run + expected:
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && deno check supabase/functions/ingest-reports/index.ts
# expected: exit code 0, no type errors
```
- [ ] **Step 4: Set the secret and deploy.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && set -a && . ./.env.local && set +a && \
npx supabase secrets set QR_INGEST_HMAC_SECRET="$QR_INGEST_HMAC_SECRET" SUPABASE_SECRET_KEY="$SUPABASE_SECRET_KEY" --project-ref oztsfxyfovwnwutrxzmo && \
npx supabase functions deploy ingest-reports --project-ref oztsfxyfovwnwutrxzmo
# expected: "Setting secrets..." success, then "Deployed Functions on project oztsfxyfovwnwutrxzmo: ingest-reports"
```
- [ ] **Step 5: Run the test — verify pass.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test -- tests/functions/ingest-reports.test.ts
# expected: PASS — 2 passed; bad HMAC -> 401, valid empty batch -> 200 {ingested:0}
```
- [ ] **Step 6: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add supabase/functions/ingest-reports/index.ts && git commit -m "feat: add ingest-reports edge function with HMAC verification and upsert"
```

<!-- ===== Cluster A2 ===== -->

I have enough context from the frozen contracts. The repo has no src yet (A1 scaffold runs first). I'll draft the A2 tasks referencing A1/C frozen names exactly.

### Task A21: roles helper + failing test

**Files:**
- Create: `src/auth/roles.ts`
- Test: `src/auth/__tests__/roles.test.ts`

**Interfaces:**
- Consumes: nothing (pure module)
- Produces: `export type Role='scouter'|'lead'|'admin'`; `export const ROLE_RANK: Record<Role,number>`; `export function hasRole(actual: Role|null|undefined, required: Role): boolean`

- [ ] **Step 1: Write failing test for hasRole.**
```ts
// src/auth/__tests__/roles.test.ts
import { describe, it, expect } from 'vitest';
import { hasRole, ROLE_RANK, type Role } from '../roles';

describe('roles', () => {
  it('ranks scouter < lead < admin', () => {
    expect(ROLE_RANK.scouter).toBeLessThan(ROLE_RANK.lead);
    expect(ROLE_RANK.lead).toBeLessThan(ROLE_RANK.admin);
  });

  it('admin satisfies every required role', () => {
    const reqs: Role[] = ['scouter', 'lead', 'admin'];
    for (const r of reqs) expect(hasRole('admin', r)).toBe(true);
  });

  it('lead satisfies scouter and lead but not admin', () => {
    expect(hasRole('lead', 'scouter')).toBe(true);
    expect(hasRole('lead', 'lead')).toBe(true);
    expect(hasRole('lead', 'admin')).toBe(false);
  });

  it('scouter satisfies only scouter', () => {
    expect(hasRole('scouter', 'scouter')).toBe(true);
    expect(hasRole('scouter', 'lead')).toBe(false);
    expect(hasRole('scouter', 'admin')).toBe(false);
  });

  it('null/undefined actual never satisfies', () => {
    expect(hasRole(null, 'scouter')).toBe(false);
    expect(hasRole(undefined, 'scouter')).toBe(false);
  });
});
```
Run: `npm run test -- src/auth/__tests__/roles.test.ts`
Expected: FAIL — `Cannot find module '../roles'`.

- [ ] **Step 2: Implement roles.ts.**
```ts
// src/auth/roles.ts
export type Role = 'scouter' | 'lead' | 'admin';

export const ROLE_RANK: Record<Role, number> = {
  scouter: 0,
  lead: 1,
  admin: 2,
};

/** True when `actual` is at least as privileged as `required`. */
export function hasRole(actual: Role | null | undefined, required: Role): boolean {
  if (actual == null) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
```
Run: `npm run test -- src/auth/__tests__/roles.test.ts`
Expected: PASS — 5 passed.

- [ ] **Step 3: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add src/auth/roles.ts src/auth/__tests__/roles.test.ts && git commit -m "feat: add role hierarchy helper (hasRole)"
```
Expected: one commit created, files listed.

---

### Task A22: joinEvent + recoverIdentity with failing test

**Files:**
- Create: `src/auth/joinEvent.ts`
- Test: `src/auth/__tests__/joinEvent.test.ts`

**Interfaces:**
- Consumes (A1): `import { supabase } from '../lib/supabase'` — `supabase.auth.signInAnonymously()`, `supabase.rpc(name, args)`
- Consumes (C, RPCs): `rpc('join_event', { p_code, p_display_name }) returns scout`; `rpc('recover_identity', { p_code, p_display_name }) returns scout`
- Produces:
  - `export interface ScoutRow { id: string; event_key: string; display_name: string; auth_uid: string; created_at: string }`
  - `export async function joinEvent(code: string, name: string): Promise<ScoutRow>`
  - `export async function recoverIdentity(code: string, name: string): Promise<ScoutRow>`

- [ ] **Step 1: Write failing test (mocks the A1 supabase module).**
```ts
// src/auth/__tests__/joinEvent.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const signInAnonymously = vi.fn();
const rpc = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { signInAnonymously: (...a: unknown[]) => signInAnonymously(...a) },
    rpc: (...a: unknown[]) => rpc(...a),
  },
}));

import { joinEvent, recoverIdentity, type ScoutRow } from '../joinEvent';

const scout: ScoutRow = {
  id: 'd1f4c7e2-0000-4000-8000-000000000001',
  event_key: '2026casnv',
  display_name: 'Ada',
  auth_uid: 'a0000000-0000-4000-8000-000000000002',
  created_at: '2026-06-23T00:00:00.000Z',
};

beforeEach(() => {
  signInAnonymously.mockReset();
  rpc.mockReset();
});

describe('joinEvent', () => {
  it('signs in anonymously then calls join_event rpc and returns the scout', async () => {
    signInAnonymously.mockResolvedValue({ data: { user: { id: scout.auth_uid } }, error: null });
    rpc.mockResolvedValue({ data: scout, error: null });

    const result = await joinEvent('ABCD', 'Ada');

    expect(signInAnonymously).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('join_event', { p_code: 'ABCD', p_display_name: 'Ada' });
    expect(result).toEqual(scout);
  });

  it('trims code and name before sending', async () => {
    signInAnonymously.mockResolvedValue({ data: { user: { id: scout.auth_uid } }, error: null });
    rpc.mockResolvedValue({ data: scout, error: null });

    await joinEvent('  abcd  ', '  Ada  ');

    expect(rpc).toHaveBeenCalledWith('join_event', { p_code: 'abcd', p_display_name: 'Ada' });
  });

  it('throws when sign-in fails and does not call rpc', async () => {
    signInAnonymously.mockResolvedValue({ data: { user: null }, error: { message: 'no anon' } });

    await expect(joinEvent('ABCD', 'Ada')).rejects.toThrow('no anon');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('throws when rpc returns an error', async () => {
    signInAnonymously.mockResolvedValue({ data: { user: { id: scout.auth_uid } }, error: null });
    rpc.mockResolvedValue({ data: null, error: { message: 'invalid join code' } });

    await expect(joinEvent('BAD', 'Ada')).rejects.toThrow('invalid join code');
  });

  it('rejects empty code or name without any network call', async () => {
    await expect(joinEvent('', 'Ada')).rejects.toThrow(/code/i);
    await expect(joinEvent('ABCD', '   ')).rejects.toThrow(/name/i);
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('recoverIdentity', () => {
  it('reuses existing anon session (no new sign-in if already signed in) then calls recover_identity', async () => {
    signInAnonymously.mockResolvedValue({ data: { user: { id: scout.auth_uid } }, error: null });
    rpc.mockResolvedValue({ data: scout, error: null });

    const result = await recoverIdentity('ABCD', 'Ada');

    expect(rpc).toHaveBeenCalledWith('recover_identity', { p_code: 'ABCD', p_display_name: 'Ada' });
    expect(result).toEqual(scout);
  });
});
```
Run: `npm run test -- src/auth/__tests__/joinEvent.test.ts`
Expected: FAIL — `Cannot find module '../joinEvent'`.

- [ ] **Step 2: Implement joinEvent.ts.**
```ts
// src/auth/joinEvent.ts
import { supabase } from '../lib/supabase';

/** Mirrors the frozen `scout` table row returned by join_event / recover_identity. */
export interface ScoutRow {
  id: string;
  event_key: string;
  display_name: string;
  auth_uid: string;
  created_at: string;
}

function normalize(code: string, name: string): { code: string; name: string } {
  const c = (code ?? '').trim();
  const n = (name ?? '').trim();
  if (!c) throw new Error('A join code is required.');
  if (!n) throw new Error('A display name is required.');
  return { code: c, name: n };
}

async function ensureAnonSession(): Promise<void> {
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error(error.message);
  if (!data?.user) throw new Error('Anonymous sign-in did not return a user.');
}

/**
 * Sign in anonymously, then call the SECURITY DEFINER `join_event` RPC.
 * Idempotent per auth.uid()+event on the server. Returns the scout row.
 */
export async function joinEvent(code: string, name: string): Promise<ScoutRow> {
  const { code: p_code, name: p_display_name } = normalize(code, name);
  await ensureAnonSession();
  const { data, error } = await supabase.rpc('join_event', { p_code, p_display_name });
  if (error) throw new Error(error.message);
  return data as ScoutRow;
}

/**
 * Rebind the current anonymous auth.uid() to an existing scout matched by
 * code+name via the `recover_identity` RPC.
 */
export async function recoverIdentity(code: string, name: string): Promise<ScoutRow> {
  const { code: p_code, name: p_display_name } = normalize(code, name);
  await ensureAnonSession();
  const { data, error } = await supabase.rpc('recover_identity', { p_code, p_display_name });
  if (error) throw new Error(error.message);
  return data as ScoutRow;
}
```
Run: `npm run test -- src/auth/__tests__/joinEvent.test.ts`
Expected: PASS — all join/recover specs pass.

- [ ] **Step 3: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add src/auth/joinEvent.ts src/auth/__tests__/joinEvent.test.ts && git commit -m "feat: add joinEvent and recoverIdentity (anon sign-in + RPC)"
```
Expected: one commit created.

---

### Task A23: useSession hook with failing test

**Files:**
- Create: `src/auth/useSession.ts`
- Test: `src/auth/__tests__/useSession.test.ts`

**Interfaces:**
- Consumes (A1): `import { supabase } from '../lib/supabase'` — `supabase.auth.getSession()`, `supabase.auth.onAuthStateChange(cb) => { data: { subscription: { unsubscribe } } }`, `supabase.from('scout')`, `supabase.from('profile')`
- Consumes (A21): `import { type Role } from './roles'`
- Consumes (C): tables `scout(auth_uid, event_key, display_name, id, created_at)`, `profile(auth_uid, role)`
- Produces: `export interface UseSessionResult { session: Session|null; scout: ScoutRow|null; role: Role|null; loading: boolean }`; `export function useSession(): UseSessionResult`

- [ ] **Step 1: Write failing test (mock supabase auth + queries).**
```ts
// src/auth/__tests__/useSession.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getSession = vi.fn();
const onAuthStateChange = vi.fn();
const unsubscribe = vi.fn();
const from = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => getSession(...a),
      onAuthStateChange: (...a: unknown[]) => onAuthStateChange(...a),
    },
    from: (...a: unknown[]) => from(...a),
  },
}));

import { useSession } from '../useSession';

const session = { user: { id: 'auth-uid-1' } };
const scoutRow = {
  id: 's1', event_key: '2026casnv', display_name: 'Ada',
  auth_uid: 'auth-uid-1', created_at: '2026-06-23T00:00:00.000Z',
};

function mockTable(table: string) {
  if (table === 'scout') {
    return {
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: scoutRow, error: null }) }) }),
    };
  }
  if (table === 'profile') {
    return {
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { auth_uid: 'auth-uid-1', role: 'lead' }, error: null }) }) }),
    };
  }
  throw new Error('unexpected table ' + table);
}

beforeEach(() => {
  getSession.mockReset();
  onAuthStateChange.mockReset();
  unsubscribe.mockReset();
  from.mockReset();
  onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe } } });
  from.mockImplementation(mockTable);
});

describe('useSession', () => {
  it('starts loading, then resolves session/scout/role', async () => {
    getSession.mockResolvedValue({ data: { session }, error: null });

    const { result } = renderHook(() => useSession());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toEqual(session);
    expect(result.current.scout).toEqual(scoutRow);
    expect(result.current.role).toBe('lead');
  });

  it('resolves to nulls when there is no session', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBeNull();
    expect(result.current.scout).toBeNull();
    expect(result.current.role).toBeNull();
  });

  it('unsubscribes the auth listener on unmount', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    const { unmount } = renderHook(() => useSession());
    await waitFor(() => expect(onAuthStateChange).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
```
Run: `npm run test -- src/auth/__tests__/useSession.test.ts`
Expected: FAIL — `Cannot find module '../useSession'`.

- [ ] **Step 2: Implement useSession.ts.**
```ts
// src/auth/useSession.ts
import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Role } from './roles';
import type { ScoutRow } from './joinEvent';

export interface UseSessionResult {
  session: Session | null;
  scout: ScoutRow | null;
  role: Role | null;
  loading: boolean;
}

async function loadIdentity(authUid: string): Promise<{ scout: ScoutRow | null; role: Role | null }> {
  const [{ data: scout }, { data: profile }] = await Promise.all([
    supabase.from('scout').select('*').eq('auth_uid', authUid).maybeSingle(),
    supabase.from('profile').select('*').eq('auth_uid', authUid).maybeSingle(),
  ]);
  return {
    scout: (scout as ScoutRow | null) ?? null,
    role: ((profile as { role?: Role } | null)?.role as Role | undefined) ?? null,
  };
}

export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session | null>(null);
  const [scout, setScout] = useState<ScoutRow | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    async function apply(next: Session | null): Promise<void> {
      if (!mounted.current) return;
      setSession(next);
      if (!next?.user) {
        setScout(null);
        setRole(null);
        setLoading(false);
        return;
      }
      const { scout: s, role: r } = await loadIdentity(next.user.id);
      if (!mounted.current) return;
      setScout(s);
      setRole(r);
      setLoading(false);
    }

    supabase.auth.getSession().then(({ data }) => {
      void apply(data.session ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setLoading(true);
      void apply(next ?? null);
    });

    return () => {
      mounted.current = false;
      subscription.unsubscribe();
    };
  }, []);

  return { session, scout, role, loading };
}
```
Run: `npm run test -- src/auth/__tests__/useSession.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 3: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add src/auth/useSession.ts src/auth/__tests__/useSession.test.ts && git commit -m "feat: add useSession hook (session + scout + role)"
```
Expected: one commit created.

---

### Task A2S: shadcn/ui foundation (dark theme, base components)

**Files:**
- Modify: `package.json` (deps), `tailwind.config.js`, `src/index.css`, `index.html`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`
- Create: `src/lib/utils.ts`, `components.json`, `src/components/ui/button.tsx`, `src/components/ui/input.tsx`, `src/components/ui/label.tsx`, `src/components/ui/card.tsx`
- Test: `src/components/ui/button.test.tsx`

**Interfaces:**
- Consumes: Tailwind (A12), the app scaffold (A11).
- Produces:
  - `export function cn(...inputs: ClassValue[]): string` from `src/lib/utils.ts`
  - shadcn base components from `src/components/ui/*`: `Button` (+ `buttonVariants`), `Input`, `Label`, `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`
  - `@/*` path alias → `./src/*` (tsconfig + vite + vitest), so later `npx shadcn add <c>` and `@/lib/utils` imports work.
  - shadcn CSS-variable design tokens, **dark by default** (`<html class="dark">`).

This establishes the shadcn/ui styling system (new-york style, slate base, CSS variables) used by every UI screen (JoinScreen, placeholders, and all Phase 2+ UI). Use the **canonical shadcn/ui (new-york) component source** for the four components — they are standard; import `cn` from `@/lib/utils`.

- [ ] **Step 1: Install dependencies.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm install class-variance-authority clsx tailwind-merge lucide-react @radix-ui/react-slot @radix-ui/react-label
npm install -D tailwindcss-animate
```
Expected: installs without errors.

- [ ] **Step 2: Add the `@/*` path alias (tsconfig + vite + vitest).**
In `tsconfig.json` `compilerOptions`, add `"baseUrl": "."` and `"paths": { "@/*": ["./src/*"] }`.
In `vite.config.ts` and `vitest.config.ts`, add `resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }` (import `fileURLToPath` from `'node:url'`). Keep the existing plugins.
Run: `npm run typecheck` → exit 0 (no errors introduced).

- [ ] **Step 3: Create `src/lib/utils.ts`.**
```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 4: Create `components.json`** (so the shadcn CLI can add more components later).
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "tailwind.config.js", "css": "src/index.css", "baseColor": "slate", "cssVariables": true },
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui" }
}
```

- [ ] **Step 5: Replace `tailwind.config.js`** with the shadcn token config (keep the existing `content` globs).
```js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1400px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))', input: 'hsl(var(--input))', ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))', foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: { 'accordion-down': 'accordion-down 0.2s ease-out', 'accordion-up': 'accordion-up 0.2s ease-out' },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
```
(Note: `require('tailwindcss-animate')` in an ESM config file works because Vite/PostCSS loads the Tailwind config in a CJS-compatible context; if the build errors on `require`, switch to `import tailwindcssAnimate from 'tailwindcss-animate'` at top and `plugins: [tailwindcssAnimate]`.)

- [ ] **Step 6: Replace `src/index.css`** with Tailwind layers + shadcn design tokens (dark-first app; both palettes defined).
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%; --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%; --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%; --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%; --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%; --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%; --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%; --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%; --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%; --input: 214.3 31.8% 91.4%; --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }
  .dark {
    --background: 222.2 84% 4.9%; --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%; --card-foreground: 210 40% 98%;
    --popover: 222.2 84% 4.9%; --popover-foreground: 210 40% 98%;
    --primary: 210 40% 98%; --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%; --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%; --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%; --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 30.6%; --destructive-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%; --input: 217.2 32.6% 17.5%; --ring: 212.7 26.8% 83.9%;
  }
}

@layer base {
  * { @apply border-border; }
  body { @apply bg-background text-foreground; }
}
```

- [ ] **Step 7: Set dark theme by default** — in `index.html`, change `<html lang="en">` to `<html lang="en" class="dark">`.

- [ ] **Step 8: Create the four base components** using the **canonical shadcn/ui (new-york) source**, importing `cn` from `@/lib/utils`:
  - `src/components/ui/button.tsx` — exports `Button` and `buttonVariants` (CVA: variants `default|destructive|outline|secondary|ghost|link`, sizes `default|sm|lg|icon`), `asChild` via `@radix-ui/react-slot`. Touch-friendly: ensure the `default` size height is at least `h-10` (≈44px) for mobile.
  - `src/components/ui/input.tsx` — exports `Input`.
  - `src/components/ui/label.tsx` — exports `Label` (using `@radix-ui/react-label`).
  - `src/components/ui/card.tsx` — exports `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`.

- [ ] **Step 9: Write a Button smoke test** `src/components/ui/button.test.tsx`.
```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Button } from '@/components/ui/button';

describe('Button', () => {
  it('renders its children as a button', () => {
    render(<Button>Join event</Button>);
    expect(screen.getByRole('button', { name: 'Join event' })).toBeInTheDocument();
  });
  it('applies the destructive variant class', () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toMatch(/destructive/);
  });
});
```
Run: `npm run test -- src/components/ui/button.test.tsx` → PASS.

- [ ] **Step 10: Verify + commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app
npm run typecheck && npm run test && npm run build
git add -A
git commit -m "feat: shadcn/ui foundation — cn util, design tokens, Button/Input/Label/Card, @ alias"
```
Expected: typecheck/test/build all green; one commit.

### Task A24: JoinScreen component

**Files:**
- Create: `src/auth/JoinScreen.tsx`
- Test: `src/auth/__tests__/JoinScreen.test.tsx`

**Interfaces:**
- Consumes (A22): `joinEvent(code, name)`, `recoverIdentity(code, name)`
- Consumes: `react-router-dom` `useNavigate`
- Produces: `export function JoinScreen(): JSX.Element` (default export too). Data-testids: `join-code`, `join-name`, `join-submit`, `recover-submit`, `join-error`. On success navigates to `/scout`.

- [ ] **Step 1: Write failing test.**
```tsx
// src/auth/__tests__/JoinScreen.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

const joinEvent = vi.fn();
const recoverIdentity = vi.fn();
vi.mock('../joinEvent', () => ({
  joinEvent: (...a: unknown[]) => joinEvent(...a),
  recoverIdentity: (...a: unknown[]) => recoverIdentity(...a),
}));

import { JoinScreen } from '../JoinScreen';

beforeEach(() => {
  navigate.mockReset();
  joinEvent.mockReset();
  recoverIdentity.mockReset();
});

describe('JoinScreen', () => {
  it('joins and navigates to /scout on success', async () => {
    joinEvent.mockResolvedValue({ id: 's1', event_key: '2026casnv' });
    render(<JoinScreen />);

    fireEvent.change(screen.getByTestId('join-code'), { target: { value: 'ABCD' } });
    fireEvent.change(screen.getByTestId('join-name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByTestId('join-submit'));

    await waitFor(() => expect(joinEvent).toHaveBeenCalledWith('ABCD', 'Ada'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/scout'));
  });

  it('shows an error message and does not navigate on failure', async () => {
    joinEvent.mockRejectedValue(new Error('invalid join code'));
    render(<JoinScreen />);

    fireEvent.change(screen.getByTestId('join-code'), { target: { value: 'BAD' } });
    fireEvent.change(screen.getByTestId('join-name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByTestId('join-submit'));

    await waitFor(() => expect(screen.getByTestId('join-error')).toHaveTextContent('invalid join code'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('recover path calls recoverIdentity then navigates', async () => {
    recoverIdentity.mockResolvedValue({ id: 's1', event_key: '2026casnv' });
    render(<JoinScreen />);

    fireEvent.change(screen.getByTestId('join-code'), { target: { value: 'ABCD' } });
    fireEvent.change(screen.getByTestId('join-name'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByTestId('recover-submit'));

    await waitFor(() => expect(recoverIdentity).toHaveBeenCalledWith('ABCD', 'Ada'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/scout'));
  });
});
```
Run: `npm run test -- src/auth/__tests__/JoinScreen.test.tsx`
Expected: FAIL — `Cannot find module '../JoinScreen'`.

- [ ] **Step 2: Implement JoinScreen.tsx.**
```tsx
// src/auth/JoinScreen.tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { joinEvent, recoverIdentity } from './joinEvent';

export function JoinScreen(): JSX.Element {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: (c: string, n: string) => Promise<unknown>): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await action(code, name);
      navigate('/scout');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function onJoin(e: FormEvent): void {
    e.preventDefault();
    void run(joinEvent);
  }

  function onRecover(): void {
    void run(recoverIdentity);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">Join Event</h1>
      <form className="flex flex-col gap-3" onSubmit={onJoin}>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Join code
          <input
            data-testid="join-code"
            className="rounded border border-gray-300 p-2"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Display name
          <input
            data-testid="join-name"
            className="rounded border border-gray-300 p-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </label>
        {error && (
          <p data-testid="join-error" role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button
          data-testid="join-submit"
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 p-2 font-semibold text-white disabled:opacity-50"
        >
          Join
        </button>
        <button
          data-testid="recover-submit"
          type="button"
          onClick={onRecover}
          disabled={busy}
          className="rounded border border-blue-600 p-2 font-semibold text-blue-600 disabled:opacity-50"
        >
          Recover my identity
        </button>
      </form>
    </main>
  );
}

export default JoinScreen;
```
Run: `npm run test -- src/auth/__tests__/JoinScreen.test.tsx`
Expected: PASS — 3 passed.

- [ ] **Step 3: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add src/auth/JoinScreen.tsx src/auth/__tests__/JoinScreen.test.tsx && git commit -m "feat: add JoinScreen (join + recover, navigates to /scout)"
```
Expected: one commit created.

---

### Task A25: Placeholder route screens

**Files:**
- Create: `src/routes/ScoutPlaceholder.tsx`
- Create: `src/routes/AdminPlaceholder.tsx`
- Create: `src/routes/DashboardPlaceholder.tsx`
- Create: `src/routes/JoinPlaceholder.tsx`

**Interfaces:**
- Consumes (A24): `JoinScreen` (re-exported by JoinPlaceholder)
- Produces: four default-exported components. Each non-join placeholder renders a stable `data-testid` and an `<h1>` for E2E assertions: `scout-screen`, `admin-screen`, `dashboard-screen`.

- [ ] **Step 1: Create the three simple placeholders.**
```tsx
// src/routes/ScoutPlaceholder.tsx
export default function ScoutPlaceholder(): JSX.Element {
  return (
    <main data-testid="scout-screen" className="p-6">
      <h1 className="text-xl font-bold">Scout</h1>
      <p>Scouting form coming soon.</p>
    </main>
  );
}
```
```tsx
// src/routes/AdminPlaceholder.tsx
export default function AdminPlaceholder(): JSX.Element {
  return (
    <main data-testid="admin-screen" className="p-6">
      <h1 className="text-xl font-bold">Admin</h1>
      <p>Admin tools coming soon.</p>
    </main>
  );
}
```
```tsx
// src/routes/DashboardPlaceholder.tsx
export default function DashboardPlaceholder(): JSX.Element {
  return (
    <main data-testid="dashboard-screen" className="p-6">
      <h1 className="text-xl font-bold">Dashboard</h1>
      <p>Analytics coming soon.</p>
    </main>
  );
}
```

- [ ] **Step 2: Create JoinPlaceholder that wraps JoinScreen.**
```tsx
// src/routes/JoinPlaceholder.tsx
import JoinScreen from '../auth/JoinScreen';

export default function JoinPlaceholder(): JSX.Element {
  return <JoinScreen />;
}
```

- [ ] **Step 3: Typecheck the new files.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npx tsc --noEmit
```
Expected: exit code 0, no output.

- [ ] **Step 4: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add src/routes/ScoutPlaceholder.tsx src/routes/AdminPlaceholder.tsx src/routes/DashboardPlaceholder.tsx src/routes/JoinPlaceholder.tsx && git commit -m "feat: add placeholder route screens (scout/admin/dashboard/join)"
```
Expected: one commit created.

---

### Task A26: RequireRole + RequireSession guards with failing test

**Files:**
- Create: `src/routes/guards.tsx`
- Test: `src/auth/__tests__/guards.test.tsx`

**Interfaces:**
- Consumes (A23): `useSession()`
- Consumes (A21): `type Role`, `hasRole`
- Consumes: `react-router-dom` `Navigate`, `Outlet`
- Produces:
  - `export function RequireSession(): JSX.Element` — redirects to `/join` when no scout; renders `<Outlet/>` otherwise; shows loading fallback while `loading`.
  - `export function RequireRole({ role }: { role: Role }): JSX.Element` — additionally redirects to `/scout` when role insufficient.

- [ ] **Step 1: Write failing test.**
```tsx
// src/auth/__tests__/guards.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const useSession = vi.fn();
vi.mock('../useSession', () => ({ useSession: () => useSession() }));

import { RequireSession, RequireRole } from '../../routes/guards';

function renderAt(path: string, ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={ui}>
          <Route path="/scout" element={<div data-testid="scout">SCOUT</div>} />
          <Route path="/admin" element={<div data-testid="admin">ADMIN</div>} />
        </Route>
        <Route path="/join" element={<div data-testid="join">JOIN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => useSession.mockReset());

describe('RequireSession', () => {
  it('shows loading fallback while loading', () => {
    useSession.mockReturnValue({ loading: true, scout: null, role: null });
    renderAt('/scout', <RequireSession />);
    expect(screen.getByTestId('auth-loading')).toBeInTheDocument();
  });

  it('redirects to /join when no scout', () => {
    useSession.mockReturnValue({ loading: false, scout: null, role: null });
    renderAt('/scout', <RequireSession />);
    expect(screen.getByTestId('join')).toBeInTheDocument();
  });

  it('renders outlet when scout present', () => {
    useSession.mockReturnValue({ loading: false, scout: { id: 's1' }, role: 'scouter' });
    renderAt('/scout', <RequireSession />);
    expect(screen.getByTestId('scout')).toBeInTheDocument();
  });
});

describe('RequireRole', () => {
  it('renders when role sufficient', () => {
    useSession.mockReturnValue({ loading: false, scout: { id: 's1' }, role: 'admin' });
    renderAt('/admin', <RequireRole role="admin" />);
    expect(screen.getByTestId('admin')).toBeInTheDocument();
  });

  it('redirects to /scout when role insufficient', () => {
    useSession.mockReturnValue({ loading: false, scout: { id: 's1' }, role: 'scouter' });
    renderAt('/admin', <RequireRole role="admin" />);
    expect(screen.getByTestId('scout')).toBeInTheDocument();
  });

  it('redirects to /join when no scout regardless of role', () => {
    useSession.mockReturnValue({ loading: false, scout: null, role: null });
    renderAt('/admin', <RequireRole role="admin" />);
    expect(screen.getByTestId('join')).toBeInTheDocument();
  });
});
```
Run: `npm run test -- src/auth/__tests__/guards.test.tsx`
Expected: FAIL — `Cannot find module '../../routes/guards'`.

- [ ] **Step 2: Implement guards.tsx.**
```tsx
// src/routes/guards.tsx
import { Navigate, Outlet } from 'react-router-dom';
import { useSession } from '../auth/useSession';
import { hasRole, type Role } from '../auth/roles';

function AuthLoading(): JSX.Element {
  return (
    <div data-testid="auth-loading" className="flex min-h-screen items-center justify-center">
      <p className="text-gray-500">Loading…</p>
    </div>
  );
}

/** Gate that requires a joined scout; otherwise redirect to /join. */
export function RequireSession(): JSX.Element {
  const { loading, scout } = useSession();
  if (loading) return <AuthLoading />;
  if (!scout) return <Navigate to="/join" replace />;
  return <Outlet />;
}

/** Gate that requires a scout AND a sufficient role; otherwise redirect. */
export function RequireRole({ role }: { role: Role }): JSX.Element {
  const { loading, scout, role: actual } = useSession();
  if (loading) return <AuthLoading />;
  if (!scout) return <Navigate to="/join" replace />;
  if (!hasRole(actual, role)) return <Navigate to="/scout" replace />;
  return <Outlet />;
}
```
Run: `npm run test -- src/auth/__tests__/guards.test.tsx`
Expected: PASS — 6 passed.

- [ ] **Step 3: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add src/routes/guards.tsx src/auth/__tests__/guards.test.tsx && git commit -m "feat: add RequireSession and RequireRole route guards"
```
Expected: one commit created.

---

### Task A27: Router wiring

**Files:**
- Create: `src/routes/router.tsx`
- Modify: `src/App.tsx` (owned by A1; A2 wires the router into it)
- Test: `src/auth/__tests__/router.test.tsx`

**Interfaces:**
- Consumes (A25): the four placeholder components
- Consumes (A26): `RequireSession`, `RequireRole`
- Consumes: `react-router-dom` `createBrowserRouter`, `RouterProvider`, `Navigate`
- Produces: `export const router` (a `createBrowserRouter` instance); `export function AppRouter(): JSX.Element` rendering `<RouterProvider router={router} />`. Route map: `/join` → JoinPlaceholder (public); `/` → redirect to `/scout`; `/scout` under RequireSession; `/dashboard` under RequireRole lead; `/admin` under RequireRole admin.

- [ ] **Step 1: Write failing test (route map shape, using createMemoryRouter equivalent assertions).**
```tsx
// src/auth/__tests__/router.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

// Force a "no scout" session so guards redirect predictably.
vi.mock('../useSession', () => ({
  useSession: () => ({ loading: false, scout: null, role: null }),
}));

import { routes } from '../../routes/router';

function renderAt(path: string) {
  const r = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<RouterProvider router={r} />);
}

describe('router', () => {
  it('serves /join publicly', () => {
    renderAt('/join');
    expect(screen.getByTestId('join-submit')).toBeInTheDocument();
  });

  it('guards /scout -> /join when no scout', () => {
    renderAt('/scout');
    expect(screen.getByTestId('join-submit')).toBeInTheDocument();
  });

  it('guards /admin -> /join when no scout', () => {
    renderAt('/admin');
    expect(screen.getByTestId('join-submit')).toBeInTheDocument();
  });

  it('redirects / to a guarded route (lands on /join when unauthenticated)', () => {
    renderAt('/');
    expect(screen.getByTestId('join-submit')).toBeInTheDocument();
  });
});
```
Run: `npm run test -- src/auth/__tests__/router.test.tsx`
Expected: FAIL — `Cannot find module '../../routes/router'`.

- [ ] **Step 2: Implement router.tsx (export `routes` array + `router` + `AppRouter`).**
```tsx
// src/routes/router.tsx
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  type RouteObject,
} from 'react-router-dom';
import { RequireSession, RequireRole } from './guards';
import JoinPlaceholder from './JoinPlaceholder';
import ScoutPlaceholder from './ScoutPlaceholder';
import AdminPlaceholder from './AdminPlaceholder';
import DashboardPlaceholder from './DashboardPlaceholder';

export const routes: RouteObject[] = [
  { path: '/', element: <Navigate to="/scout" replace /> },
  { path: '/join', element: <JoinPlaceholder /> },
  {
    element: <RequireSession />,
    children: [{ path: '/scout', element: <ScoutPlaceholder /> }],
  },
  {
    element: <RequireRole role="lead" />,
    children: [{ path: '/dashboard', element: <DashboardPlaceholder /> }],
  },
  {
    element: <RequireRole role="admin" />,
    children: [{ path: '/admin', element: <AdminPlaceholder /> }],
  },
  { path: '*', element: <Navigate to="/scout" replace /> },
];

export const router = createBrowserRouter(routes);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
```
Run: `npm run test -- src/auth/__tests__/router.test.tsx`
Expected: PASS — 4 passed.

- [ ] **Step 3: Wire AppRouter into App.tsx (A1-owned shell; replace its body to render the router).**
```tsx
// src/App.tsx
import { AppRouter } from './routes/router';

export default function App(): JSX.Element {
  return <AppRouter />;
}
```
Run: `cd /Users/ryanabraham/Downloads/FRC-scouting-app && npx tsc --noEmit && npm run build`
Expected: tsc exits 0; `npm run build` prints `built in …` and a `dist/` is produced.

- [ ] **Step 4: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add src/routes/router.tsx src/App.tsx src/auth/__tests__/router.test.tsx && git commit -m "feat: wire react-router (public /join, guarded /scout /dashboard /admin)"
```
Expected: one commit created.

---

### Task A28: Playwright config + smoke E2E (app loads, join flow reaches /scout)

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/smoke.spec.ts`
- Modify: `package.json` (A1-owned; add the FROZEN `test:e2e` script if absent)

**Interfaces:**
- Consumes: built/dev app served by Vite on `http://localhost:5173`; routes `/join`, `/scout`; testids `join-code`, `join-name`, `join-submit`, `scout-screen`.
- Consumes (C, live project): a seeded/active event with a known join code. The spec reads `E2E_JOIN_CODE` and `E2E_DISPLAY_NAME` from env (loaded from `.env.local`); if unset it skips the join-success assertion but still asserts the app loads and `/join` renders.
- Produces: `npm run test:e2e` passing.

- [ ] **Step 1: Create playwright.config.ts (auto-starts Vite dev server).**
```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

- [ ] **Step 2: Write the smoke spec.**
```ts
// tests/e2e/smoke.spec.ts
import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

const JOIN_CODE = process.env.E2E_JOIN_CODE;
const DISPLAY_NAME = process.env.E2E_DISPLAY_NAME ?? 'E2E Scout';

test('app loads and unauthenticated user lands on /join', async ({ page }) => {
  await page.goto('/');
  // Root redirects to a guarded route; unauthenticated -> /join.
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.getByTestId('join-submit')).toBeVisible();
  await expect(page.getByTestId('join-code')).toBeVisible();
  await expect(page.getByTestId('join-name')).toBeVisible();
});

test('join flow reaches /scout', async ({ page }) => {
  test.skip(!JOIN_CODE, 'Set E2E_JOIN_CODE in .env.local to run the live join flow.');

  await page.goto('/join');
  await page.getByTestId('join-code').fill(JOIN_CODE as string);
  await page.getByTestId('join-name').fill(DISPLAY_NAME);
  await page.getByTestId('join-submit').click();

  await expect(page).toHaveURL(/\/scout$/, { timeout: 15_000 });
  await expect(page.getByTestId('scout-screen')).toBeVisible();
});
```

- [ ] **Step 3: Ensure the FROZEN `test:e2e` script exists in package.json (A1 shell).**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && node -e "const fs=require('fs');const p=require('./package.json');p.scripts=p.scripts||{};if(!p.scripts['test:e2e'])p.scripts['test:e2e']='playwright test';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');console.log(p.scripts['test:e2e']);"
```
Expected: prints `playwright test`.

- [ ] **Step 4: Install the Chromium browser and run the E2E suite.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npx playwright install chromium && npm run test:e2e
```
Expected: `2 passed` (or `1 passed, 1 skipped` when `E2E_JOIN_CODE` is unset). The "app loads / lands on /join" test always passes.

- [ ] **Step 5: Commit.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git add playwright.config.ts tests/e2e/smoke.spec.ts package.json && git commit -m "test: add Playwright smoke E2E (app loads, join flow reaches /scout)"
```
Expected: one commit created.

---

### Task A29: Full A2 verification gate

**Files:**
- Modify: none (verification-only task)
- Test: runs the full unit + e2e suites for this cluster

**Interfaces:**
- Consumes: all A2 modules above plus A1 (`src/lib/supabase.ts`, `src/lib/env.ts`, `vitest.config.ts`, `package.json` scripts `test`, `test:e2e`, `build`) and C (live RPCs).
- Produces: green gate proving Phase 0 acceptance criteria #3 (join creates a scout, reaches /scout).

- [ ] **Step 1: Run the full unit suite.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test
```
Expected: all A2 suites pass — `roles`, `joinEvent`, `useSession`, `JoinScreen`, `guards`, `router` (alongside other clusters' tests). No failures.

- [ ] **Step 2: Typecheck + production build.**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npx tsc --noEmit && npm run build
```
Expected: tsc exits 0; build prints `built in …` and emits `dist/`.

- [ ] **Step 3: Run E2E against the live project (acceptance #3).**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && npm run test:e2e
```
Expected: smoke spec passes; with `E2E_JOIN_CODE` set, the join flow lands on `/scout` and `scout-screen` is visible — demonstrating anonymous sign-in + `join_event` created a scout and the guard admitted them.

- [ ] **Step 4: Final cluster commit (chore marker).**
```bash
cd /Users/ryanabraham/Downloads/FRC-scouting-app && git commit --allow-empty -m "chore: A2 cluster (auth/routing/guards/e2e) verification gate green"
```
Expected: one empty commit recording the gate.
