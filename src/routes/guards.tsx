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
