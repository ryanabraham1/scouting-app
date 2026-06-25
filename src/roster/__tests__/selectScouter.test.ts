import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const rpcMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a) },
}));

import { selectScouter, getRememberedScouterName } from '../selectScouter';
import { getCachedScoutIdentity, rememberScoutIdentity } from '../scoutIdentityCache';

const scoutRow = {
  id: 's1',
  event_key: '2026demo',
  display_name: 'Ada',
  auth_uid: 'uid-1',
  created_at: '2026-06-23T00:00:00.000Z',
};

// jsdom-compat ships a localStorage object whose methods are non-functional;
// install a real in-memory store so the offline identity cache actually round-trips.
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  });
}

beforeEach(() => {
  rpcMock.mockReset();
  installMemoryLocalStorage();
});

afterEach(() => {
  // Restore navigator.onLine if a test forced it offline.
  try {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  } catch {
    /* ignore */
  }
});

function goOffline(): void {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
}

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

  it('remembers the resolved identity so the name can be re-picked offline', async () => {
    rpcMock.mockResolvedValue({ data: scoutRow, error: null });
    await selectScouter('2026demo', 'Ada');
    expect(getCachedScoutIdentity('2026demo', 'Ada')).toEqual(scoutRow);
  });

  it('falls back to the cached identity when offline (TypeError: Failed to fetch)', async () => {
    rememberScoutIdentity(scoutRow); // a prior online sign-in cached this device's row
    goOffline();
    rpcMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const row = await selectScouter('2026demo', 'Ada');
    expect(row).toEqual(scoutRow);
    expect(getRememberedScouterName()).toBe('Ada');
  });

  it('surfaces a friendly message offline when the name was never signed in here', async () => {
    goOffline();
    rpcMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(selectScouter('2026demo', 'Ada')).rejects.toThrow(/offline/i);
  });

  it('getRememberedScouterName is safe when storage is unavailable', () => {
    // jsdom-compat localStorage is non-functional; must not throw.
    expect(() => getRememberedScouterName()).not.toThrow();
  });
});
