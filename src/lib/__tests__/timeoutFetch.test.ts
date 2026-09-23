import { afterEach, describe, expect, it, vi } from 'vitest';
import { FETCH_TIMEOUTS_MS, fetchTimeoutFor, timeoutFetch } from '@/lib/timeoutFetch';
import { isNetworkFailure } from '@/sync/classifyError';

const BASE = 'https://x.supabase.co';

/** A fetch that never answers until its signal aborts (a dead venue link). */
function hangingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchTimeoutFor', () => {
  it('routes budgets by Supabase service path', () => {
    expect(fetchTimeoutFor(`${BASE}/auth/v1/token?grant_type=refresh_token`)).toBe(
      FETCH_TIMEOUTS_MS.auth,
    );
    expect(fetchTimeoutFor(`${BASE}/rest/v1/match?select=*`)).toBe(FETCH_TIMEOUTS_MS.rest);
    expect(fetchTimeoutFor(`${BASE}/storage/v1/object/pit-photos/a.jpg`)).toBe(
      FETCH_TIMEOUTS_MS.storage,
    );
    expect(fetchTimeoutFor(`${BASE}/functions/v1/tba-proxy?path=%2Fstatus`)).toBe(
      FETCH_TIMEOUTS_MS.functions,
    );
    expect(fetchTimeoutFor(new URL(`${BASE}/functions/v1/import-event`))).toBe(90_000);
  });

  it('leaves non-Supabase requests alone', () => {
    expect(fetchTimeoutFor('/assets/field/field.webp')).toBe(0);
    expect(fetchTimeoutFor('https://example.com/data.json')).toBe(0);
  });
});

describe('timeoutFetch', () => {
  it('rejects a stalled request with a TypeError the outboxes treat as a network gap', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const pending = timeoutFetch(`${BASE}/auth/v1/token`, { method: 'POST' });
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUTS_MS.auth + 1);
    const error = await settled;
    expect(error).toBeInstanceOf(TypeError);
    expect(String((error as Error).message)).toMatch(/timed out/);
    expect(isNetworkFailure(error)).toBe(true);
  });

  it("forwards the caller's own abort (and its reason) immediately", async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const caller = new AbortController();
    const pending = timeoutFetch(`${BASE}/rest/v1/match`, { signal: caller.signal });
    const reason = new Error('caller gave up');
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('passes the response through and clears its timer when the server answers', async () => {
    vi.useFakeTimers();
    const response = new Response('{}', { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(timeoutFetch(`${BASE}/functions/v1/nexus-proxy`)).resolves.toBe(response);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock.mock.calls[0][1]).toHaveProperty('signal');
  });

  it('does not wrap requests without a budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('x'));
    vi.stubGlobal('fetch', fetchMock);
    const init = { method: 'GET' };
    await timeoutFetch('/assets/field/field.webp', init);
    expect(fetchMock).toHaveBeenCalledWith('/assets/field/field.webp', init);
  });
});
