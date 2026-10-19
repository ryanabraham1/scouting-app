import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- mocks ---------------------------------------------------------------
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

import { tbaGet, match13Season, parseMatch13Season, resetMatch13Backoff } from '../proxies';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('proxies', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok-abc' } } });
    vi.stubGlobal('fetch', vi.fn());
    resetMatch13Backoff();
  });

  describe('tbaGet', () => {
    it('hits the tba-proxy function with encoded path + apikey + Authorization headers', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ rank: 1 }]));
      vi.stubGlobal('fetch', fetchMock);

      const result = await tbaGet<Array<{ rank: number }>>('/event/2026casnv/rankings');

      expect(result).toEqual([{ rank: 1 }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://proj.supabase.co/functions/v1/tba-proxy?path=' +
          encodeURIComponent('/event/2026casnv/rankings'),
      );
      expect(init.headers.apikey).toBe('pub-key-123');
      expect(init.headers.Authorization).toBe('Bearer tok-abc');
    });

    it('throws on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500)));
      await expect(tbaGet('/event/x/rankings')).rejects.toThrow();
    });
  });

  describe('match13Season', () => {
    const body = { year: 2026, columns: ['team', 'xp', 'rank', 'auto', 'teleop', 'endgame'], teams: [[3256, 191.3, 89, 48.6, 142.7, 0]] };

    it('hits match13-proxy with the year and decodes the season table', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
      vi.stubGlobal('fetch', fetchMock);
      const result = await match13Season('2026');
      expect(fetchMock.mock.calls[0][0]).toBe('https://proj.supabase.co/functions/v1/match13-proxy?year=2026');
      expect(result).toBeInstanceOf(Map);
      expect((result as Map<number, unknown>).get(3256)).toEqual({
        xp: 191.3, rank: 89, auto: 48.6, teleop: 142.7, endgame: 0,
      });
    });

    it('degrades to { available: false } on the sentinel, an error status or a thrown fetch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ available: false })));
      expect(await match13Season('2026')).toEqual({ available: false });
      resetMatch13Backoff();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'oops' }, 503)));
      expect(await match13Season('2026')).toEqual({ available: false });
      resetMatch13Backoff();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      expect(await match13Season('2026')).toEqual({ available: false });
    });

    it('stops calling the proxy for a while after an outage', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ available: false }));
      vi.stubGlobal('fetch', fetchMock);
      await match13Season('2026');
      expect(await match13Season('2026')).toEqual({ available: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseMatch13Season', () => {
    it('rejects garbage and skips malformed rows', () => {
      expect(parseMatch13Season(null)).toBeNull();
      expect(parseMatch13Season({ teams: [] })).toBeNull();
      const t = parseMatch13Season({
        columns: ['team', 'xp', 'rank'],
        teams: [[254, 'x', 3], 'junk', ['nope', 1, 1], [1678, 80, null]],
      });
      expect(t?.get(254)).toEqual({ xp: null, rank: 3, auto: null, teleop: null, endgame: null });
      expect(t?.get(1678)?.xp).toBe(80);
      expect(t?.size).toBe(2);
    });
  });
});
