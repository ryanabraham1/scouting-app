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
import AdminLogin from '../auth/AdminLogin';

export const routes: RouteObject[] = [
  { path: '/', element: <Navigate to="/scout" replace /> },
  { path: '/join', element: <JoinPlaceholder /> },
  { path: '/login', element: <AdminLogin /> },
  {
    element: <RequireSession />,
    children: [{ path: '/scout', element: <ScoutPlaceholder /> }],
  },
  {
    element: <RequireRole role="lead" redirectTo="/login" />,
    children: [{ path: '/dashboard', element: <DashboardPlaceholder /> }],
  },
  {
    element: <RequireRole role="admin" redirectTo="/login" />,
    children: [{ path: '/admin', element: <AdminPlaceholder /> }],
  },
  { path: '*', element: <Navigate to="/scout" replace /> },
];

export const router = createBrowserRouter(routes);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
