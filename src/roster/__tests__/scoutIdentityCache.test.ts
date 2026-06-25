import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  rememberScoutIdentity,
  getCachedScoutIdentity,
} from '../scoutIdentityCache';

const scoutRow = {
  id: 's1',
  event_key: '2026demo',
  display_name: 'Ada Lovelace',
  auth_uid: 'uid-1',
  created_at: '2026-06-23T00:00:00.000Z',
};

// jsdom-compat ships a localStorage object whose methods are non-functional;
// install a real in-memory store so we exercise the cache logic, not the env.
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
  installMemoryLocalStorage();
});

describe('scoutIdentityCache', () => {
  it('round-trips a remembered identity by (event, name)', () => {
    rememberScoutIdentity(scoutRow);
    expect(getCachedScoutIdentity('2026demo', 'Ada Lovelace')).toEqual(scoutRow);
  });

  it('matches the name case- and whitespace-insensitively', () => {
    rememberScoutIdentity(scoutRow);
    expect(getCachedScoutIdentity('2026demo', '  ADA LOVELACE ')).toEqual(scoutRow);
  });

  it('returns null for a name never signed in on this device', () => {
    rememberScoutIdentity(scoutRow);
    expect(getCachedScoutIdentity('2026demo', 'Grace Hopper')).toBeNull();
    expect(getCachedScoutIdentity('2026other', 'Ada Lovelace')).toBeNull();
  });

  it('keeps separate rows per event for the same name', () => {
    rememberScoutIdentity(scoutRow);
    rememberScoutIdentity({ ...scoutRow, id: 's2', event_key: '2026other' });
    expect(getCachedScoutIdentity('2026demo', 'Ada Lovelace')?.id).toBe('s1');
    expect(getCachedScoutIdentity('2026other', 'Ada Lovelace')?.id).toBe('s2');
  });

  it('ignores malformed rows', () => {
    rememberScoutIdentity(null);
    rememberScoutIdentity({ ...scoutRow, display_name: '' });
    expect(getCachedScoutIdentity('2026demo', '')).toBeNull();
  });
});
