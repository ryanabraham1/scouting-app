import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateSWMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('virtual:pwa-register', () => ({
  registerSW: vi.fn(() => updateSWMock),
}));

import {
  applyPendingPwaUpdate,
  beginPwaUpdateBlock,
  getPwaUpdateState,
  registerPwa,
} from './registerPwa';
import { registerSW } from 'virtual:pwa-register';

describe('registerPwa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSWMock.mockResolvedValue(undefined);
  });

  it('registers the service worker and requests persistent storage', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist },
    });

    await registerPwa();

    expect(registerSW).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('checks on launch and defers activation until editing is safe', async () => {
    vi.useFakeTimers();
    const registrationUpdate = vi.fn().mockResolvedValue(undefined);
    try {
      await registerPwa();
      const options = vi.mocked(registerSW).mock.calls[0]?.[0];
      expect(options).toBeDefined();

      options?.onRegisteredSW?.('/sw.js', {
        update: registrationUpdate,
      } as unknown as ServiceWorkerRegistration);
      expect(registrationUpdate).toHaveBeenCalledTimes(1);

      const release = beginPwaUpdateBlock();
      options?.onNeedRefresh?.();
      expect(updateSWMock).not.toHaveBeenCalled();
      expect(getPwaUpdateState()).toEqual({ pending: true, blocked: true });
      expect(await applyPendingPwaUpdate()).toBe(false);

      release();
      expect(getPwaUpdateState()).toEqual({ pending: true, blocked: false });
      expect(await applyPendingPwaUpdate()).toBe(true);
      expect(updateSWMock).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw when storage.persist is unavailable', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: undefined,
    });

    await expect(registerPwa()).resolves.toBeUndefined();
    expect(registerSW).toHaveBeenCalledTimes(1);
  });

  it('retains a pending update when activation fails so it can be retried', async () => {
    updateSWMock.mockRejectedValueOnce(new Error('activation failed'));
    await registerPwa();
    const options = vi.mocked(registerSW).mock.calls[0]?.[0];
    options?.onNeedRefresh?.();

    await expect(applyPendingPwaUpdate()).rejects.toThrow('activation failed');
    expect(getPwaUpdateState()).toEqual({ pending: true, blocked: false });

    updateSWMock.mockResolvedValueOnce(undefined);
    await expect(applyPendingPwaUpdate()).resolves.toBe(true);
    expect(getPwaUpdateState()).toEqual({ pending: false, blocked: false });
  });
});
