// src/auth/__tests__/AdminLogin.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

const adminSignIn = vi.fn();
vi.mock('../adminAuth', () => ({
  adminSignIn: (...a: unknown[]) => adminSignIn(...a),
}));

import { AdminLogin } from '../AdminLogin';

beforeEach(() => {
  navigate.mockReset();
  adminSignIn.mockReset();
});

describe('AdminLogin', () => {
  it('signs in and navigates to /admin on success', async () => {
    adminSignIn.mockResolvedValue(undefined);
    render(<AdminLogin />);

    fireEvent.change(screen.getByTestId('admin-email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByTestId('admin-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('admin-login-submit'));

    await waitFor(() => expect(adminSignIn).toHaveBeenCalledWith('a@b.com', 'pw'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin'));
  });

  it('shows an error and does not navigate on failure', async () => {
    adminSignIn.mockRejectedValue(new Error('Invalid login credentials'));
    render(<AdminLogin />);

    fireEvent.change(screen.getByTestId('admin-email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByTestId('admin-password'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('admin-login-submit'));

    await waitFor(() => expect(screen.getByTestId('admin-login-error')).toHaveTextContent('Invalid login credentials'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('disables submit while in flight (no double submit)', async () => {
    let resolve!: () => void;
    adminSignIn.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    render(<AdminLogin />);

    fireEvent.change(screen.getByTestId('admin-email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByTestId('admin-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('admin-login-submit'));
    fireEvent.click(screen.getByTestId('admin-login-submit'));

    await waitFor(() => expect(adminSignIn).toHaveBeenCalledTimes(1));
    resolve();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin'));
  });
});
