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

import { tbaGet, statboticsGet, epaFromTeamEvent } from '../proxies';

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

  describe('statboticsGet', () => {
    it('returns parsed JSON on a 200 response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ epa: { total_points: { mean: 42 } } })),
      );
      const result = await statboticsGet<{ epa: { total_points: { mean: number } } }>(
        '/team_event/254/2026casnv',
      );
      expect(result).toEqual({ epa: { total_points: { mean: 42 } } });
    });

    it('hits the statbotics-proxy function (not tba-proxy)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ epa: {} }));
      vi.stubGlobal('fetch', fetchMock);
      await statboticsGet('/team_event/254/2026casnv');
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/functions/v1/statbotics-proxy?path=');
    });

    it('degrades to { available: false } when the body is the sentinel', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ available: false })));
      const result = await statboticsGet('/team_event/254/2026casnv');
      expect(result).toEqual({ available: false });
    });

    it('degrades to { available: false } on a thrown fetch error (never throws)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const result = await statboticsGet('/team_event/254/2026casnv');
      expect(result).toEqual({ available: false });
    });

    it('degrades to { available: false } on a non-2xx response (never throws)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'oops' }, 503)));
      const result = await statboticsGet('/team_event/254/2026casnv');
      expect(result).toEqual({ available: false });
    });
  });

  describe('epaFromTeamEvent', () => {
    it('reads epa.breakdown.total_points', () => {
      expect(epaFromTeamEvent({ epa: { breakdown: { total_points: 55.5 } } })).toBe(55.5);
    });

    it('falls back to epa.total_points.mean', () => {
      expect(epaFromTeamEvent({ epa: { total_points: { mean: 33 } } })).toBe(33);
    });

    it('prefers breakdown.total_points over total_points.mean', () => {
      expect(
        epaFromTeamEvent({ epa: { breakdown: { total_points: 10 }, total_points: { mean: 20 } } }),
      ).toBe(10);
    });

    it('returns null for missing/unparseable data', () => {
      expect(epaFromTeamEvent(null)).toBeNull();
      expect(epaFromTeamEvent({})).toBeNull();
      expect(epaFromTeamEvent({ epa: {} })).toBeNull();
      expect(epaFromTeamEvent({ epa: { total_points: {} } })).toBeNull();
      expect(epaFromTeamEvent({ epa: { breakdown: { total_points: 'x' } } })).toBeNull();
    });

    it('returns null for the sentinel { available: false }', () => {
      expect(epaFromTeamEvent({ available: false })).toBeNull();
    });
  });
});
