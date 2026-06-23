// src/routes/router.tsx
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  type RouteObject,
} from 'react-router-dom';
import { RequireSession, RequireRole } from './guards';
import JoinPlaceholder from './JoinPlaceholder';
import DashboardPlaceholder from './DashboardPlaceholder';
import AdminLogin from '../auth/AdminLogin';
import AdminPage from '../admin/AdminPage';
import ScoutHome from '../capture/ScoutHome';
import PitRoute from '../pit/PitRoute';
import QrSendScreen from '../qr/QrSendScreen';
import QrReceiveScreen from '../qr/QrReceiveScreen';
import SyncStatusScreen from '../sync/SyncStatusScreen';

export const routes: RouteObject[] = [
  { path: '/', element: <Navigate to="/scout" replace /> },
  { path: '/join', element: <JoinPlaceholder /> },
  { path: '/login', element: <AdminLogin /> },
  {
    element: <RequireSession />,
    children: [
      { path: '/scout', element: <ScoutHome /> },
      { path: '/pit', element: <PitRoute /> },
      { path: '/qr/send', element: <QrSendScreen /> },
      { path: '/qr/receive', element: <QrReceiveScreen /> },
    ],
  },
  {
    element: <RequireRole role="lead" redirectTo="/login" />,
    children: [
      { path: '/dashboard', element: <DashboardPlaceholder /> },
      { path: '/sync', element: <SyncStatusScreen /> },
    ],
  },
  {
    element: <RequireRole role="admin" redirectTo="/login" />,
    children: [{ path: '/admin', element: <AdminPage /> }],
  },
  { path: '*', element: <Navigate to="/scout" replace /> },
];

export const router = createBrowserRouter(routes);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
