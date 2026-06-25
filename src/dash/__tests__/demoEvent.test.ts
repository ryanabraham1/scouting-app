import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => getSessionMock(...a),
    },
  },
}));

vi.mock('@/lib/env', () => ({
  env: { SUPABASE_URL: 'https://demo.supabase.co' },
}));

const setActiveEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../setActiveEvent', () => ({
  setActiveEvent: (...a: unknown[]) => setActiveEventMock(...a),
}));

const deleteEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../deleteEvent', () => ({
  deleteEvent: (...a: unknown[]) => deleteEventMock(...a),
}));

import {
  DEMO_EVENT_KEY,
  DEMO_SOURCE_EVENT_KEY,
  isDemoEvent,
  enableDemoMode,
  disableDemoMode,
} from '../demoEvent';

const qc = { invalidateQueries: vi.fn().mockResolvedValue(undefined) } as never;

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}
function errResponse(status: number, body: unknown): Response {
  return { ok: false, status, json: () => Promise.resolve(body) } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  getSessionMock
    .mockReset()
    .mockResolvedValue({ data: { session: { access_token: 'tok-123' } } });
  fetchMock
    .mockReset()
    .mockResolvedValue(okResponse({ team_count: 40, match_count: 80, report_count: 480 }));
  vi.stubGlobal('fetch', fetchMock);
  setActiveEventMock.mockClear();
  deleteEventMock.mockClear();
  (qc as { invalidateQueries: ReturnType<typeof vi.fn> }).invalidateQueries.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('demoEvent', () => {
  it('exposes the demo + source event keys', () => {
    expect(DEMO_EVENT_KEY).toBe('2026demo');
    expect(DEMO_SOURCE_EVENT_KEY).toBe('2026casnv');
  });

  it('isDemoEvent matches only the demo key', () => {
    expect(isDemoEvent('2026demo')).toBe(true);
    expect(isDemoEvent('2026casnv')).toBe(false);
    expect(isDemoEvent(null)).toBe(false);
  });

  it('enableDemoMode throws when there is no session token', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    await expect(enableDemoMode(qc)).rejects.toThrow('Not signed in.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setActiveEventMock).not.toHaveBeenCalled();
  });

  it('enableDemoMode POSTs to seed-demo with the bearer + body, then activates and invalidates', async () => {
    const result = await enableDemoMode(qc);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/functions\/v1\/seed-demo$/);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body.source_event_key).toBe('2026casnv');
    expect(body.demo_event_key).toBe('2026demo');

    expect(setActiveEventMock).toHaveBeenCalledWith('2026demo', qc);
    expect(
      (qc as { invalidateQueries: ReturnType<typeof vi.fn> }).invalidateQueries,
    ).toHaveBeenCalled();
    expect(result).toEqual({ team_count: 40, match_count: 80, report_count: 480 });

    // Ordering: POST resolves before activate before invalidate.
    const activateOrder = setActiveEventMock.mock.invocationCallOrder[0];
    const invalidateOrder = (
      qc as { invalidateQueries: ReturnType<typeof vi.fn> }
    ).invalidateQueries.mock.invocationCallOrder[0];
    expect(activateOrder).toBeLessThan(invalidateOrder);
  });

  it('enableDemoMode throws (and does NOT activate) when the function responds non-ok', async () => {
    fetchMock.mockResolvedValue(errResponse(500, { error: 'boom' }));
    await expect(enableDemoMode(qc)).rejects.toThrow('boom');
    expect(setActiveEventMock).not.toHaveBeenCalled();
    expect(
      (qc as { invalidateQueries: ReturnType<typeof vi.fn> }).invalidateQueries,
    ).not.toHaveBeenCalled();
  });

  it('enableDemoMode falls back to a status message when the error body is unusable', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error('no body')),
    } as Response);
    await expect(enableDemoMode(qc)).rejects.toThrow('Demo setup failed (503)');
  });

  it('disableDemoMode deletes the demo event then invalidates', async () => {
    await disableDemoMode(qc);
    expect(deleteEventMock).toHaveBeenCalledWith('2026demo', qc);
    expect(
      (qc as { invalidateQueries: ReturnType<typeof vi.fn> }).invalidateQueries,
    ).toHaveBeenCalled();
  });
});
