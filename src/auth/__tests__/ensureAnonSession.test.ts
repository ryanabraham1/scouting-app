// src/auth/__tests__/ensureAnonSession.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSession = vi.fn();
const signInAnonymously = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => getSession(...a),
      signInAnonymously: (...a: unknown[]) => signInAnonymously(...a),
    },
  },
}));

import { ensureAnonSession } from '../ensureAnonSession';

const user = { id: 'auth-uid-1' };

// Instant sleep + pinned RNG so the retry loop runs synchronously-fast and the
// jitter is deterministic; capture requested delays so we can assert backoff.
function makeOpts() {
  const delays: number[] = [];
  return {
    delays,
    opts: {
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: () => 0, // full-jitter floor → predictable 0.5 * exponential
    },
  };
}

beforeEach(() => {
  getSession.mockReset();
  signInAnonymously.mockReset();
  getSession.mockResolvedValue({ data: { session: null }, error: null });
});

describe('ensureAnonSession', () => {
  it('reuses an existing session without signing in', async () => {
    getSession.mockResolvedValue({ data: { session: { user } }, error: null });

    await ensureAnonSession(makeOpts().opts);

    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('retries on 429 then succeeds', async () => {
    signInAnonymously
      .mockResolvedValueOnce({ data: null, error: { status: 429, message: 'over_request_rate_limit' } })
      .mockResolvedValueOnce({ data: null, error: { status: 429, message: 'over_request_rate_limit' } })
      .mockResolvedValueOnce({ data: { user }, error: null });

    const { delays, opts } = makeOpts();
    await expect(ensureAnonSession(opts)).resolves.toBeUndefined();

    expect(signInAnonymously).toHaveBeenCalledTimes(3);
    // Two backoff waits (before attempts 2 and 3), exponential with jittered floor.
    expect(delays).toEqual([250, 500]);
  });

  it('retries on 5xx / network (no status) failures', async () => {
    signInAnonymously
      .mockResolvedValueOnce({ data: null, error: { status: 503, message: 'server error' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } }) // network: no status
      .mockResolvedValueOnce({ data: { user }, error: null });

    const { opts } = makeOpts();
    await expect(ensureAnonSession(opts)).resolves.toBeUndefined();
    expect(signInAnonymously).toHaveBeenCalledTimes(3);
  });

  it('respects Retry-After when present', async () => {
    signInAnonymously
      .mockResolvedValueOnce({
        data: null,
        error: { status: 429, message: 'slow down', headers: { get: () => '3' } },
      })
      .mockResolvedValueOnce({ data: { user }, error: null });

    const { delays, opts } = makeOpts();
    await ensureAnonSession(opts);

    expect(delays).toEqual([3_000]); // 3s from Retry-After, not the exponential 250ms
  });

  it('gives up after the max attempts and throws', async () => {
    signInAnonymously.mockResolvedValue({
      data: null,
      error: { status: 429, message: 'over_request_rate_limit' },
    });

    const { delays, opts } = makeOpts();
    await expect(ensureAnonSession(opts)).rejects.toThrow('over_request_rate_limit');

    expect(signInAnonymously).toHaveBeenCalledTimes(5); // MAX_ATTEMPTS
    expect(delays).toHaveLength(4); // one fewer sleep than attempts (none after the last)
  });

  it('does not retry before a long server Retry-After expires', async () => {
    signInAnonymously
      .mockResolvedValueOnce({ data: null, error: { status: 429, retryAfter: 60 } })
      .mockResolvedValueOnce({ data: { user }, error: null });
    const { delays, opts } = makeOpts();
    await ensureAnonSession(opts);
    expect(delays).toEqual([60_000]);
  });

  it('retries a rejected network request and an HTTP timeout', async () => {
    signInAnonymously
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ data: null, error: { status: 408 } })
      .mockResolvedValueOnce({ data: { user }, error: null });
    await expect(ensureAnonSession(makeOpts().opts)).resolves.toBeUndefined();
    expect(signInAnonymously).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a terminal non-429 4xx error', async () => {
    signInAnonymously.mockResolvedValue({
      data: null,
      error: { status: 422, message: 'anonymous sign-ins disabled' },
    });

    const { opts } = makeOpts();
    await expect(ensureAnonSession(opts)).rejects.toThrow('anonymous sign-ins disabled');

    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('throws if a successful response returns no user', async () => {
    signInAnonymously.mockResolvedValue({ data: {}, error: null });

    const { opts } = makeOpts();
    await expect(ensureAnonSession(opts)).rejects.toThrow('did not return a user');
  });

  it('de-dupes concurrent callers into a single sign-in chain', async () => {
    signInAnonymously.mockResolvedValue({ data: { user }, error: null });

    // Both calls in the same tick share the module-level in-flight promise, so
    // dozens of simultaneous callers can't each spawn their own signup storm.
    const { opts } = makeOpts();
    const a = ensureAnonSession(opts);
    const b = ensureAnonSession(opts);
    await Promise.all([a, b]);

    // getSession + signInAnonymously each called once despite two callers.
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });
});
