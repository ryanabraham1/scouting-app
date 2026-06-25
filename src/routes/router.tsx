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
import DashboardScreen from '../dash/DashboardScreen';
import HomeScreen from '../home/HomeScreen';
import ScoutHome from '../capture/ScoutHome';
import MyDataView from '../scout/MyDataView';
import QrSendScreen from '../qr/QrSendScreen';
import QrReceiveScreen from '../qr/QrReceiveScreen';
import SyncStatusScreen from '../sync/SyncStatusScreen';

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

const rawRoutes: RouteObject[] = [
  { path: '/', element: <HomeScreen /> },
  { path: '/scout', element: <ScoutHome /> },
  { path: '/my-data', element: <MyDataView /> },
  // Pit scouting folds into the Scout Home Match/Pit toggle.
  { path: '/pit', element: <Navigate to="/scout?mode=pit" replace /> },
  { path: '/qr/send', element: <QrSendScreen /> },
  { path: '/qr/receive', element: <QrReceiveScreen /> },
  { path: '/dashboard', element: <DashboardScreen /> },
  { path: '/sync', element: <SyncStatusScreen /> },
  // Legacy admin entry point folds into the dashboard Setup tab.
  { path: '/admin', element: <Navigate to="/dashboard?tab=setup" replace /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

// Attach the same recovery boundary to every route so no screen can blank the
// app — an error in one route's element renders RouteError in its place.
export const routes: RouteObject[] = rawRoutes.map((r) => ({
  ...r,
  errorElement: <RouteError />,
}));

export const router = createBrowserRouter(routes);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
