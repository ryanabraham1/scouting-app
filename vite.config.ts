import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    react(),
    VitePWA({
      // Data-entry screens explicitly defer activation; autoUpdate bypasses
      // onNeedRefresh and can reload a capture in progress.
      registerType: 'prompt',
      injectRegister: null,
      manifest: false,
      includeAssets: ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'],
      workbox: {
        // Workbox's terser render hook exits early under the current Node toolchain.
        // Development mode emits the same production caching behavior without
        // minifying the small generated worker.
        mode: 'development',
        // woff2: the self-hosted mono telemetry font must be PREcached, or an
        // installed-then-offline device silently falls back to system mono
        // (the /assets/ runtime rule only caches it after a first online render).
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,woff2}'],
        navigateFallback: '/index.html',
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            // The globally active event is server authority while online. Never
            // let Workbox's 4-second NetworkFirst timeout answer this one query
            // from a stale response cache; the app already owns an explicit
            // localStorage fallback for genuine offline starts.
            urlPattern: ({ url }) =>
              url.hostname.endsWith('.supabase.co') &&
              url.pathname.endsWith('/rest/v1/event') &&
              url.searchParams.get('is_active') === 'eq.true',
            handler: 'NetworkOnly',
          },
          {
            // Same-origin static assets (notably the ~2.4 MB field image used by
            // every capture/review/auto screen). These are also precached via
            // globPatterns, but a CacheFirst runtime rule is belt-and-suspenders:
            // if the precache ever skips the image (e.g. a stale SW generated
            // under the old 2 MB size cap), the first online view durably caches
            // it so it still renders offline.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && url.pathname.startsWith('/assets/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-assets-v2',
              expiration: {
                maxEntries: 32,
                maxAgeSeconds: 60 * 60 * 24 * 60,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Supabase auth/token endpoints — never cache.
            urlPattern: ({ url }) =>
              url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/auth/v1/'),
            handler: 'NetworkOnly',
          },
          {
            // Dexie/TanStack own the app's explicit offline data model. A
            // Workbox-cached API 200 looks fresh to those layers and can
            // overwrite newer local data, so never response-cache API reads.
            urlPattern: ({ url }) =>
              url.hostname.endsWith('.supabase.co') &&
              (url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/functions/v1/')),
            handler: 'NetworkOnly',
          },
          {
            // Supabase storage (pit photos). ignoreSearch: signed URLs embed a
            // rotating ?token= — without it every re-signed URL is a cache miss,
            // so a photo cached online Friday is unreachable offline Saturday.
            // Object paths are deterministic (event/team.jpg), so path-only
            // matching is safe.
            urlPattern: ({ url }) =>
              url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/storage/v1/'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'supabase-storage-v2',
              matchOptions: { ignoreSearch: true },
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
            },
          },
          {
            // Cross-origin images (TBA team media: imgur/instagram direct_urls).
            // Opaque responses cache fine; once viewed online they keep working
            // offline instead of turning into broken images.
            urlPattern: ({ request, sameOrigin, url }) =>
              !sameOrigin &&
              request.destination === 'image' &&
              !url.hostname.endsWith('.supabase.co'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'external-images-v2',
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
      devOptions: {
        // SW active in dev too, so offline testing (airplane-mode the laptop,
        // toggle devtools offline) behaves like the installed PWA: the
        // /assets/ CacheFirst rule serves the field image, NetworkFirst covers
        // supabase data. Dev JS modules are NOT matched by any rule, so HMR is
        // unaffected. Without this, "offline" on localhost fails every asset
        // fetch and looks like an app bug.
        enabled: true,
        suppressWarnings: true,
      },
    }),
  ],
});
