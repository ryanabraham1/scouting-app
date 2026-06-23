// src/auth/__tests__/joinEvent.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSession = vi.fn();
const signInAnonymously = vi.fn();
const rpc = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => getSession(...a),
      signInAnonymously: (...a: unknown[]) => signInAnonymously(...a),
    },
    rpc: (...a: unknown[]) => rpc(...a),
  },
}));

import { joinEvent, recoverIdentity, type ScoutRow } from '../joinEvent';

const scout: ScoutRow = {
  id: 'd1f4c7e2-0000-4000-8000-000000000001',
  event_key: '2026casnv',
  display_name: 'Ada',
  auth_uid: 'a0000000-0000-4000-8000-000000000002',
  created_at: '2026-06-23T00:00:00.000Z',
};

beforeEach(() => {
  getSession.mockReset();
  signInAnonymously.mockReset();
  rpc.mockReset();
  // Default: fresh device, no persisted session.
  getSession.mockResolvedValue({ data: { session: null }, error: null });
});

describe('joinEvent', () => {
  it('signs in anonymously when no session, then calls join_event rpc and returns the scout', async () => {
    signInAnonymously.mockResolvedValue({ data: { user: { id: scout.auth_uid } }, error: null });
    rpc.mockResolvedValue({ data: scout, error: null });

    const result = await joinEvent('ABCD', 'Ada');

    expect(signInAnonymously).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('join_event', { p_code: 'ABCD', p_display_name: 'Ada' });
    expect(result).toEqual(scout);
  });

  it('reuses an existing anon session without signing in again', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: scout.auth_uid } } },
      error: null,
    });
    rpc.mockResolvedValue({ data: scout, error: null });

    const result = await joinEvent('ABCD', 'Ada');

    expect(signInAnonymously).toHaveBeenCalledTimes(0);
    expect(rpc).toHaveBeenCalledWith('join_event', { p_code: 'ABCD', p_display_name: 'Ada' });
    expect(result).toEqual(scout);
  });

  it('trims code and name before sending', async () => {
    signInAnonymously.mockResolvedValue({ data: { user: { id: scout.auth_uid } }, error: null });
    rpc.mockResolvedValue({ data: scout, error: null });

    await joinEvent('  abcd  ', '  Ada  ');

    expect(rpc).toHaveBeenCalledWith('join_event', { p_code: 'abcd', p_display_name: 'Ada' });
  });

  it('throws when sign-in fails and does not call rpc', async () => {
    signInAnonymously.mockResolvedValue({ data: { user: null }, error: { message: 'no anon' } });

    await expect(joinEvent('ABCD', 'Ada')).rejects.toThrow('no anon');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('throws when rpc returns an error', async () => {
    signInAnonymously.mockResolvedValue({ data: { user: { id: scout.auth_uid } }, error: null });
    rpc.mockResolvedValue({ data: null, error: { message: 'invalid join code' } });

    await expect(joinEvent('BAD', 'Ada')).rejects.toThrow('invalid join code');
  });

  it('rejects empty code or name without any network call', async () => {
    await expect(joinEvent('', 'Ada')).rejects.toThrow(/code/i);
    await expect(joinEvent('ABCD', '   ')).rejects.toThrow(/name/i);
    expect(getSession).not.toHaveBeenCalled();
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('recoverIdentity', () => {
  it('signs in when no session then calls recover_identity', async () => {
    signInAnonymously.mockResolvedValue({ data: { user: { id: scout.auth_uid } }, error: null });
    rpc.mockResolvedValue({ data: scout, error: null });

    const result = await recoverIdentity('ABCD', 'Ada');

    expect(rpc).toHaveBeenCalledWith('recover_identity', { p_code: 'ABCD', p_display_name: 'Ada' });
    expect(result).toEqual(scout);
  });

  it('reuses an existing anon session (no new sign-in) then calls recover_identity', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: scout.auth_uid } } },
      error: null,
    });
    rpc.mockResolvedValue({ data: scout, error: null });

    const result = await recoverIdentity('ABCD', 'Ada');

    expect(signInAnonymously).toHaveBeenCalledTimes(0);
    expect(rpc).toHaveBeenCalledWith('recover_identity', { p_code: 'ABCD', p_display_name: 'Ada' });
    expect(result).toEqual(scout);
  });
});
