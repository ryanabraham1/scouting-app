import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the browser supabase client + env exactly like the other *Client tests.
const getSession = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: (...a: unknown[]) => getSession(...a) } },
}));
vi.mock('@/lib/env', () => ({
  env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub-key-123' },
}));

import { postIngest, batchReports } from '../ingestClient';
import { sampleUpsertPayloads } from './fixtures';

// The exact snake_case wire payloads the QR hand-off carries (shared fixture).
const reports = sampleUpsertPayloads();

beforeEach(() => {
  getSession.mockReset();
  vi.unstubAllGlobals();
});

describe('postIngest', () => {
  it('POSTs to ingest-reports with bearer + apikey headers and a snake_case { reports } body, returns { ingested, failed }', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok-abc' } } });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ingested: 2, failed: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await postIngest(reports);

    expect(result).toEqual({ ingested: 2, failed: [] });
    // The body carries the snake_case wire payloads verbatim (event_key, etc.).
    expect(reports[0]).toHaveProperty('event_key');
    expect(reports[0]).not.toHaveProperty('eventKey');
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

  // The `ingest-reports` function rejects (413) any batch >100 reports, but a QR
  // hand-off can carry up to MAX_QR_REPORTS (1000). Chunk into ≤100-report POSTs
  // so a big rescue backlog transfers instead of dead-failing "at most 100 …".
  it('splits a >100-report backlog into ≤100-report POSTs and aggregates results', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok-abc' } } });
    const big = Array.from({ length: 250 }, (_, i) => ({ event_key: '2026x', i }));
    const fetchMock = vi.fn().mockImplementation((_url, init: { body: string }) => {
      const { reports: batch } = JSON.parse(init.body) as { reports: unknown[] };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ingested: batch.length, failed: [] }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await postIngest(big);

    expect(fetchMock).toHaveBeenCalledTimes(3); // 100 + 100 + 50
    for (const call of fetchMock.mock.calls) {
      const { reports: batch } = JSON.parse((call[1] as { body: string }).body) as {
        reports: unknown[];
      };
      expect(batch.length).toBeLessThanOrEqual(100);
    }
    expect(result).toEqual({ ingested: 250, failed: [] });
  });

  it('re-bases per-batch failed[].index onto the original backlog', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok-abc' } } });
    const big = Array.from({ length: 150 }, (_, i) => ({ event_key: '2026x', i }));
    let batchNo = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      const isSecond = batchNo === 1;
      batchNo += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        // First batch (indices 0..99) clean; second batch fails its local index 5,
        // which is global index 105.
        json: async () =>
          isSecond
            ? { ingested: 49, failed: [{ index: 5, error: 'boom' }] }
            : { ingested: 100, failed: [] },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await postIngest(big);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ingested).toBe(149);
    expect(result.failed).toEqual([{ index: 105, error: 'boom' }]);
  });

  it('batchReports keeps each chunk within the count limit', () => {
    const many = Array.from({ length: 305 }, (_, i) => ({ event_key: '2026x', i }));
    const batches = batchReports(many);
    expect(batches).toHaveLength(4); // 100 + 100 + 100 + 5
    expect(batches.flat()).toHaveLength(305);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(100);
  });

  it('reports an oversized row without blocking valid reports before or after it', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok-abc' } } });
    const valid = { event_key: '2026x' };
    const oversized = { notes: 'x'.repeat(1024 * 1024) };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ingested: 1, failed: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await postIngest([valid, oversized, valid])).toEqual({
      ingested: 2,
      failed: [{ index: 1, error: 'Report exceeds the QR upload size limit.' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body)).toEqual({ reports: [valid] });
    }
  });

  it('splits by UTF-8 bytes even when the report count is below the limit', () => {
    const wide = Array.from({ length: 6 }, () => ({ notes: '🤖'.repeat(60_000) }));
    const batches = batchReports(wide);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(wide);
    for (const batch of batches) {
      expect(new TextEncoder().encode(JSON.stringify({ reports: batch })).length)
        .toBeLessThan(1024 * 1024);
    }
  });
});
