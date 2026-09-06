// src/dash/__tests__/proxies.coverage.test.ts
//
// Complements proxies.test.ts by covering the degrade-gracefully paths the base
// suite does not exercise: nexusGet, tbaGetOptional, syncEventResults, and the
// anonymous (no access token) auth-header branch. These guard the contract that
// an upstream TBA/Statbotics/Nexus outage NEVER throws into the dashboard —
// every optional read collapses to the `{ available: false }` sentinel and
// syncEventResults is best-effort (swallows all failures).

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'pub-key-123',
  },
}));

const getSessionMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
    },
  },
}));

import { nexusGet, tbaGetOptional, syncEventResults, isUnavailable } from '../proxies';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('proxies — degrade-gracefully coverage', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok-abc' } } });
  });

  describe('isUnavailable', () => {
    it('recognizes the sentinel and rejects everything else', () => {
      expect(isUnavailable({ available: false })).toBe(true);
      expect(isUnavailable({ available: true })).toBe(false);
      expect(isUnavailable({})).toBe(false);
      expect(isUnavailable(null)).toBe(false);
      expect(isUnavailable('nope')).toBe(false);
    });
  });

  describe('anonymous auth header (no session token)', () => {
    it('omits Authorization but always sends the apikey', async () => {
      getSessionMock.mockResolvedValue({ data: { session: null } });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: 1 }));
      vi.stubGlobal('fetch', fetchMock);

      await nexusGet('/live/2026casf');

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.apikey).toBe('pub-key-123');
      expect(init.headers.Authorization).toBeUndefined();
    });
  });

  describe('nexusGet', () => {
    it('hits the nexus-proxy function and returns parsed JSON on 200', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'live' }));
      vi.stubGlobal('fetch', fetchMock);
      const result = await nexusGet<{ status: string }>('/live/2026casf');
      expect(result).toEqual({ status: 'live' });
      expect(fetchMock.mock.calls[0][0]).toContain('/functions/v1/nexus-proxy?path=');
    });

    it('degrades to the sentinel on non-2xx, a thrown fetch, and the sentinel body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ e: 1 }, 502)));
      expect(await nexusGet('/x')).toEqual({ available: false });

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
      expect(await nexusGet('/x')).toEqual({ available: false });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ available: false })));
      expect(await nexusGet('/x')).toEqual({ available: false });
    });
  });

  describe('tbaGetOptional', () => {
    it('returns the parsed body on success', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ key: 'frc3256' }])));
      const result = await tbaGetOptional<Array<{ key: string }>>('/team/frc3256/media');
      expect(result).toEqual([{ key: 'frc3256' }]);
    });

    it('degrades to the sentinel on non-2xx, a thrown fetch, and the sentinel body (never throws)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ e: 1 }, 404)));
      expect(await tbaGetOptional('/x')).toEqual({ available: false });

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
      expect(await tbaGetOptional('/x')).toEqual({ available: false });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ available: false })));
      expect(await tbaGetOptional('/x')).toEqual({ available: false });
    });
  });

  describe('syncEventResults', () => {
    it('POSTs to sync-event-results with the event_key in the URL and body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
      vi.stubGlobal('fetch', fetchMock);

      await syncEventResults('2026casf');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://proj.supabase.co/functions/v1/sync-event-results?event_key=2026casf',
      );
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({ event_key: '2026casf' });
    });

    it('is best-effort — swallows a thrown fetch without rejecting', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      await expect(syncEventResults('2026casf')).resolves.toBeUndefined();
    });
  });
});
