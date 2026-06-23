// src/auth/__tests__/guards.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const useSession = vi.fn();
vi.mock('../useSession', () => ({ useSession: () => useSession() }));

import { RequireSession, RequireRole } from '../../routes/guards';

/** Routes for RequireSession: /scout and /admin live inside the guard. */
function renderSessionAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RequireSession />}>
          <Route path="/scout" element={<div data-testid="scout">SCOUT</div>} />
          <Route path="/admin" element={<div data-testid="admin">ADMIN</div>} />
        </Route>
        <Route path="/join" element={<div data-testid="join">JOIN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Routes for RequireRole: /admin lives inside the guard, /scout is a
 * standalone landing page so insufficient-role redirects can resolve.
 */
function renderRoleAt(path: string, role: 'scouter' | 'lead' | 'admin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RequireRole role={role} />}>
          <Route path="/admin" element={<div data-testid="admin">ADMIN</div>} />
        </Route>
        <Route path="/scout" element={<div data-testid="scout">SCOUT</div>} />
        <Route path="/join" element={<div data-testid="join">JOIN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => useSession.mockReset());

describe('RequireSession', () => {
  it('shows loading fallback while loading', () => {
    useSession.mockReturnValue({ loading: true, scout: null, role: null });
    renderSessionAt('/scout');
    expect(screen.getByTestId('auth-loading')).toBeInTheDocument();
  });

  it('redirects to /join when no scout', () => {
    useSession.mockReturnValue({ loading: false, scout: null, role: null });
    renderSessionAt('/scout');
    expect(screen.getByTestId('join')).toBeInTheDocument();
  });

  it('renders outlet when scout present', () => {
    useSession.mockReturnValue({ loading: false, scout: { id: 's1' }, role: 'scouter' });
    renderSessionAt('/scout');
    expect(screen.getByTestId('scout')).toBeInTheDocument();
  });
});

describe('RequireRole', () => {
  it('renders when role sufficient', () => {
    useSession.mockReturnValue({ loading: false, scout: { id: 's1' }, role: 'admin' });
    renderRoleAt('/admin', 'admin');
    expect(screen.getByTestId('admin')).toBeInTheDocument();
  });

  it('redirects to /scout when role insufficient', () => {
    useSession.mockReturnValue({ loading: false, scout: { id: 's1' }, role: 'scouter' });
    renderRoleAt('/admin', 'admin');
    expect(screen.getByTestId('scout')).toBeInTheDocument();
  });

  it('redirects to /join when no scout regardless of role', () => {
    useSession.mockReturnValue({ loading: false, scout: null, role: null });
    renderRoleAt('/admin', 'admin');
    expect(screen.getByTestId('join')).toBeInTheDocument();
  });
});
