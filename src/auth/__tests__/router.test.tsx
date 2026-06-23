// src/auth/__tests__/router.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

// Force an unauthenticated state (no session, no scout) so guards redirect predictably.
vi.mock('../useSession', () => ({
  useSession: () => ({ loading: false, session: null, scout: null, role: null }),
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

  it('guards /admin -> /login when unauthenticated (admin area uses email/password)', () => {
    renderAt('/admin');
    expect(screen.getByTestId('admin-login-submit')).toBeInTheDocument();
  });

  it('redirects / to a guarded route (lands on /join when unauthenticated)', () => {
    renderAt('/');
    expect(screen.getByTestId('join-submit')).toBeInTheDocument();
  });
});

describe('router /login', () => {
  it('serves /login publicly (AdminLogin)', () => {
    renderAt('/login');
    expect(screen.getByTestId('admin-login-submit')).toBeInTheDocument();
  });
});
