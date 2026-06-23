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

/**
 * Gate for staff areas: requires an authenticated SESSION and a sufficient
 * role. Does NOT require a `scout` row — admins/leads authenticate by
 * email/password and have a `profile` (role) but no `scout`. (The scout-join
 * requirement lives in RequireSession, for the scouter capture flow.)
 * Not-logged-in or insufficient role → redirectTo (e.g. /login for /admin).
 */
export function RequireRole({
  role,
  redirectTo = '/scout',
}: {
  role: Role;
  redirectTo?: string;
}): JSX.Element {
  const { loading, session, role: actual } = useSession();
  if (loading) return <AuthLoading />;
  if (!session) return <Navigate to={redirectTo} replace />;
  if (!hasRole(actual, role)) return <Navigate to={redirectTo} replace />;
  return <Outlet />;
}
