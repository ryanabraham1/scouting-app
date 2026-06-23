import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the browser supabase client + env exactly like the other *Client tests.
const getSession = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: (...a: unknown[]) => getSession(...a) } },
}));
vi.mock('@/lib/env', () => ({
  env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub-key-123' },
}));

import { postIngest } from '../ingestClient';

const reports = [
  { id: 'r1', event_key: '2026casnv', match_key: 'qm1' },
  { id: 'r2', event_key: '2026casnv', match_key: 'qm2' },
];

beforeEach(() => {
  getSession.mockReset();
  vi.unstubAllGlobals();
});

describe('postIngest', () => {
  it('POSTs to ingest-reports with bearer + apikey headers and a { reports } body, returns { ingested }', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok-abc' } } });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ingested: 2 }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await postIngest(reports);

    expect(result).toEqual({ ingested: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.supabase.co/functions/v1/ingest-reports',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-abc',
          apikey: 'pub-key-123',
        }),
        body: JSON.stringify({ reports }),
      }),
    );
  });

  it('throws "not signed in" when there is no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(postIngest(reports)).rejects.toThrow(/not signed in/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws the server error message on a non-2xx response', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok-abc' } } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'forbidden: not an event member' }),
      }),
    );

    await expect(postIngest(reports)).rejects.toThrow(/forbidden: not an event member/);
  });

  it('falls back to a status-based message when the error body has no error field', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok-abc' } } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );

    await expect(postIngest(reports)).rejects.toThrow(/500/);
  });
});
