import { describe, it, expect, beforeEach, vi } from 'vitest';

const rpcMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a) },
}));

import { selectScouter, getRememberedScouterName } from '../selectScouter';

const scoutRow = {
  id: 's1',
  event_key: '2026demo',
  display_name: 'Ada',
  auth_uid: 'uid-1',
  created_at: '2026-06-23T00:00:00.000Z',
};

beforeEach(() => {
  rpcMock.mockReset();
});

describe('selectScouter', () => {
  it('calls select_scouter with the event + name and returns the row', async () => {
    rpcMock.mockResolvedValue({ data: scoutRow, error: null });
    const row = await selectScouter('2026demo', 'Ada');
    expect(rpcMock).toHaveBeenCalledWith('select_scouter', {
      p_event_key: '2026demo',
      p_name: 'Ada',
    });
    expect(row).toEqual(scoutRow);
  });

  it('unwraps a one-element array result shape', async () => {
    rpcMock.mockResolvedValue({ data: [scoutRow], error: null });
    const row = await selectScouter('2026demo', 'Ada');
    expect(row).toEqual(scoutRow);
  });

  it('throws on RPC error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'nope' } });
    await expect(selectScouter('2026demo', 'Ada')).rejects.toThrow('nope');
  });

  it('getRememberedScouterName is safe when storage is unavailable', () => {
    // jsdom-compat localStorage is non-functional; must not throw.
    expect(() => getRememberedScouterName()).not.toThrow();
  });
});
