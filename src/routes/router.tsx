// src/routes/router.tsx — no auth, no role gates. Every route is open; a silent
// anonymous session (see main.tsx -> ensureAnonSession) satisfies RLS.
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  Link,
  useRouteError,
  type RouteObject,
} from 'react-router-dom';
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import HomeScreen from '../home/HomeScreen';
import { applyRouteTheme } from './routeTheme';

/**
 * A lazy route/tab chunk that failed to download. After a deploy, a tab still
 * running the previous build asks for chunk hashes that no longer exist (every
 * browser words this differently); offline, a chunk this device never cached
 * fails the same way. Exported for tests.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '');
  return /dynamically imported module|importing a module script failed|ChunkLoadError|loading (css )?chunk \S+ failed|unable to preload css/i.test(
    message,
  );
}

/** One automatic reload per this window: a second failure is shown, not looped. */
export const CHUNK_RELOAD_GUARD_MS = 60_000;
const CHUNK_RELOAD_KEY = 'frc-chunk-reload-at';

function lastChunkReloadAt(): number | null {
  try {
    const last = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY));
    return Number.isFinite(last) && last > 0 ? last : null;
  } catch {
    return null;
  }
}

/** Whether an automatic reload is allowed right now (pure — safe during render). */
function chunkReloadAllowed(now = Date.now()): boolean {
  try {
    window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
  } catch {
    // No storage means no loop guard: never auto-reload blind.
    return false;
  }
  const last = lastChunkReloadAt();
  return last === null || now - last < 0 || now - last >= CHUNK_RELOAD_GUARD_MS;
}

function markChunkReload(now = Date.now()): void {
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    /* chunkReloadAllowed already refused when storage is unavailable */
  }
}

/**
 * Catch-all for a render/loader error on any route. Without an errorElement,
 * React Router unmounts to a blank white screen when a screen throws — which
 * offline (a failed fetch path, missing cache) read as "the page stopped
 * loading". This keeps the user on a recoverable page instead of a dead end.
 *
 * A stale-build chunk failure reloads itself once (the fresh HTML references
 * chunks that exist); capture drafts and outboxes live in IndexedDB, so a
 * reload loses nothing.
 */
export function RouteError(): JSX.Element {
  const error = useRouteError();
  const chunkError = isChunkLoadError(error);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  // Decided once per mount (render stays pure; React may render this boundary
  // more than once before committing). The guard is stamped in the effect.
  const [autoReloading] = useState(() => chunkError && !offline && chunkReloadAllowed());
  useEffect(() => {
    if (!autoReloading || !chunkReloadAllowed()) return;
    markChunkReload();
    window.location.reload();
  }, [autoReloading]);

  const message = chunkError
    ? offline
      ? 'This screen has not been downloaded to this device yet. Reconnect to the internet, then tap Reload.'
      : autoReloading
        ? 'A newer version of the app is available. Reloading…'
        : 'This screen could not be downloaded. Check the connection, then tap Reload.'
    : error instanceof Error
      ? error.message
      : 'This screen ran into an unexpected problem.';
  return (
    <div
      data-testid="route-error"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-safe py-safe text-center text-foreground"
    >
      <h1 className="flex items-center gap-2 text-2xl font-bold">
        <AlertTriangle className="size-6 text-warning" />
        Something went wrong
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-brand px-4 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand/90"
        >
          Reload
        </button>
        <Link
          to="/"
          className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

function RouteLoading(): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-background px-safe py-safe text-sm font-medium text-muted-foreground"
    >
      Loading scouting tools…
    </div>
  );
}

const rawRoutes: RouteObject[] = [
  { path: '/', element: <HomeScreen /> },
  {
    path: '/scout',
    lazy: async () => ({ Component: (await import('../capture/ScoutHome')).default }),
  },
  // Standalone, app-native practice sandbox. It intentionally has no identity or
  // event gate so a brand-new/offline device can learn without touching real data.
  {
    path: '/scout/tutorial',
    lazy: async () => ({ Component: (await import('../tutorial/ScoutTutorial')).default }),
  },
  {
    path: '/my-data',
    lazy: async () => ({ Component: (await import('../scout/MyDataView')).default }),
  },
  // Pit scouting folds into the Scout Home Match/Pit toggle.
  { path: '/pit', element: <Navigate to="/scout?mode=pit" replace /> },
  {
    path: '/qr/send',
    lazy: async () => ({ Component: (await import('../qr/QrSendScreen')).default }),
  },
  {
    path: '/qr/receive',
    lazy: async () => ({ Component: (await import('../qr/QrReceiveScreen')).default }),
  },
  {
    path: '/dashboard',
    lazy: async () => ({ Component: (await import('../dash/DashboardScreen')).default }),
  },
  {
    path: '/analysis',
    lazy: async () => ({ Component: (await import('../dash/AnalysisScreen')).default }),
  },
  {
    path: '/sync',
    lazy: async () => ({ Component: (await import('../sync/SyncStatusScreen')).default }),
  },
  // Legacy admin entry point folds into Lead Dashboard Settings.
  { path: '/admin', element: <Navigate to="/dashboard?tab=settings" replace /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

// Attach the same recovery boundary to every route so no screen can blank the
// app — an error in one route's element renders RouteError in its place.
export const routes: RouteObject[] = rawRoutes.map((r) => ({
  ...r,
  errorElement: <RouteError />,
  hydrateFallbackElement: <RouteLoading />,
}));

export const router = createBrowserRouter(routes);

// The lead dashboard keeps its original dark console theme, while scout-facing
// screens use the light palette. Subscribe so client-side navigation updates the
// document class and browser/PWA chrome without a reload.
applyRouteTheme(router.state.location.pathname);
router.subscribe((state) => applyRouteTheme(state.location.pathname));

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
