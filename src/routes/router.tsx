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
import { AlertTriangle } from 'lucide-react';
import HomeScreen from '../home/HomeScreen';
import { applyRouteTheme } from './routeTheme';

/**
 * Catch-all for a render/loader error on any route. Without an errorElement,
 * React Router unmounts to a blank white screen when a screen throws — which
 * offline (a failed fetch path, missing cache) read as "the page stopped
 * loading". This keeps the user on a recoverable page instead of a dead end.
 */
function RouteError(): JSX.Element {
  const error = useRouteError();
  const message =
    error instanceof Error ? error.message : 'This screen ran into an unexpected problem.';
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
    path: '/sync',
    lazy: async () => ({ Component: (await import('../sync/SyncStatusScreen')).default }),
  },
  // Legacy admin entry point folds into the dashboard Setup tab.
  { path: '/admin', element: <Navigate to="/dashboard?tab=setup" replace /> },
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
