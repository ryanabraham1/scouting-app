// src/auth/__tests__/adminAuth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const signInWithPassword = vi.fn();
const signOut = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: { auth: { signInWithPassword: (...a: unknown[]) => signInWithPassword(...a), signOut: (...a: unknown[]) => signOut(...a) } },
}));

import { adminSignIn, adminSignOut } from '../adminAuth';

beforeEach(() => {
  signInWithPassword.mockReset();
  signOut.mockReset();
});

describe('adminSignIn', () => {
  it('calls signInWithPassword with credentials on success', async () => {
    signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
    await expect(adminSignIn('a@b.com', 'pw')).resolves.toBeUndefined();
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.com', password: 'pw' });
  });

  it('throws when supabase returns an error', async () => {
    signInWithPassword.mockResolvedValue({ data: { session: null }, error: { message: 'Invalid login credentials' } });
    await expect(adminSignIn('a@b.com', 'bad')).rejects.toThrow('Invalid login credentials');
  });
});

describe('adminSignOut', () => {
  it('calls signOut', async () => {
    signOut.mockResolvedValue({ error: null });
    await expect(adminSignOut()).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalled();
  });
});
