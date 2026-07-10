import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installMemoryStorage } from '@/tutorial/__tests__/memoryStorage';
import {
  ACTIVE_EVENT_STORAGE_KEY,
  getStoredActiveEvent,
  setStoredActiveEvent,
} from '../activeEventStore';

describe('activeEventStore', () => {
  beforeAll(installMemoryStorage);

  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips normal and synthetic event keys', () => {
    setStoredActiveEvent('2026casnv');
    expect(getStoredActiveEvent()).toBe('2026casnv');
    setStoredActiveEvent('_e2etest');
    expect(getStoredActiveEvent()).toBe('_e2etest');
  });

  it('discards malformed browser storage instead of treating it as authority', () => {
    for (const malformed of ['', ' 2026casnv ', '{"event":"2026casnv"}', 'event key']) {
      localStorage.setItem(ACTIVE_EVENT_STORAGE_KEY, malformed);
      expect(getStoredActiveEvent()).toBeNull();
      expect(localStorage.getItem(ACTIVE_EVENT_STORAGE_KEY)).toBeNull();
    }
  });
});
