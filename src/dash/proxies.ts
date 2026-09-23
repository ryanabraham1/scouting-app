import { env } from '@/lib/env';
import { timeoutFetch } from '@/lib/timeoutFetch';
import { supabase } from '@/lib/supabase';

/** Sentinel the Edge proxies return when the upstream service is unavailable. */
export interface ProxyUnavailable {
  available: false;
}

export function isUnavailable(body: unknown): body is ProxyUnavailable {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { available?: unknown }).available === false
  );
}

function proxyUrl(fn: string, path: string): string {
  return `${env.SUPABASE_URL}/functions/v1/${fn}?path=${encodeURIComponent(path)}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers: Record<string, string> = { apikey: env.SUPABASE_PUBLISHABLE_KEY };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Read through the TBA Edge proxy. Throws on any non-2xx response.
 */
export async function tbaGet<T>(path: string): Promise<T> {
  const res = await timeoutFetch(proxyUrl('tba-proxy', path), {
    headers: await authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`tba-proxy request failed (${res.status}) for ${path}`);
  }
  return (await res.json()) as T;
}

/**
 * Read through the TBA Edge proxy, but never throws: degrades to
 * `{ available: false }` on any fetch/non-2xx error or the sentinel body,
 * so an OPTIONAL TBA lookup (e.g. team media fallback photos) can fail
 * silently without breaking the dashboard. Use the strict `tbaGet` when a
 * TBA failure should surface as an error instead.
 */
export async function tbaGetOptional<T>(path: string): Promise<T | ProxyUnavailable> {
  try {
    const res = await timeoutFetch(proxyUrl('tba-proxy', path), {
      headers: await authHeaders(),
    });
    if (!res.ok) {
      return { available: false };
    }
    const body = (await res.json()) as unknown;
    if (isUnavailable(body)) {
      return { available: false };
    }
    return body as T;
  } catch {
    return { available: false };
  }
}

/**
 * Read through the Statbotics Edge proxy. Never throws: degrades to
 * `{ available: false }` on the sentinel body OR on any fetch/non-2xx error,
 * so the dashboard keeps working through a Statbotics outage.
 */
export async function statboticsGet<T>(path: string): Promise<T | ProxyUnavailable> {
  try {
    const res = await timeoutFetch(proxyUrl('statbotics-proxy', path), {
      headers: await authHeaders(),
    });
    if (!res.ok) {
      return { available: false };
    }
    const body = (await res.json()) as unknown;
    if (isUnavailable(body)) {
      return { available: false };
    }
    return body as T;
  } catch {
    return { available: false };
  }
}

/**
 * Read through the Nexus Edge proxy. Never throws: degrades to
 * `{ available: false }` on the sentinel body OR on any fetch/non-2xx error,
 * so the dashboard keeps working when Nexus (live field status) is unavailable.
 */
export async function nexusGet<T>(path: string): Promise<T | ProxyUnavailable> {
  try {
    const res = await timeoutFetch(proxyUrl('nexus-proxy', path), {
      headers: await authHeaders(),
    });
    if (!res.ok) {
      return { available: false };
    }
    const body = (await res.json()) as unknown;
    if (isUnavailable(body)) {
      return { available: false };
    }
    return body as T;
  } catch {
    return { available: false };
  }
}

/** Summary returned by a successful `sync-event-results` reconcile. */
export interface SyncEventResultsSummary {
  /** Number of `match` rows the reconcile actually wrote (0 = nothing changed). */
  written: number;
}

/**
 * Trigger the server-side TBA match reconcile for an event. Best-effort and
 * never throws: lands current predicted/scheduled times plus real results into
 * our `match` table (service-role write), healing dropped webhooks. Safe to call
 * repeatedly (idempotent upsert). Resolves to the reconcile summary so a caller
 * can refresh its match cache when rows changed; `undefined` on any failure
 * (network, non-JSON, `{ available: false }` sentinel).
 */
export async function syncEventResults(
  eventKey: string,
): Promise<SyncEventResultsSummary | undefined> {
  try {
    const url = `${env.SUPABASE_URL}/functions/v1/sync-event-results?event_key=${encodeURIComponent(eventKey)}`;
    const res = await timeoutFetch(url, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_key: eventKey }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as unknown;
    if (isUnavailable(body)) return undefined;
    const written = (body as { written?: unknown }).written;
    return { written: typeof written === 'number' && written > 0 ? written : 0 };
  } catch {
    /* best-effort safety net — the webhook is the primary path */
    return undefined;
  }
}

/**
 * Defensively extract a team's EPA (total points) from a Statbotics
 * `team_event` payload. Prefers `epa.breakdown.total_points`, falls back to
 * `epa.total_points.mean`. Returns null when neither is a finite number.
 */
export function epaFromTeamEvent(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }
  const epa = (json as { epa?: unknown }).epa;
  if (typeof epa !== 'object' || epa === null) {
    return null;
  }
  const breakdown = (epa as { breakdown?: unknown }).breakdown;
  if (typeof breakdown === 'object' && breakdown !== null) {
    const v = (breakdown as { total_points?: unknown }).total_points;
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
  }
  const totalPoints = (epa as { total_points?: unknown }).total_points;
  if (typeof totalPoints === 'object' && totalPoints !== null) {
    const mean = (totalPoints as { mean?: unknown }).mean;
    if (typeof mean === 'number' && Number.isFinite(mean)) {
      return mean;
    }
  }
  return null;
}

/** youtube-proxy result: when a livestream actually started (null = not yet). */
export interface YoutubeStreamStart {
  available: true;
  videoId: string;
  actualStartTime: string | null;
  actualEndTime: string | null;
}

/**
 * Read a livestream's start through the youtube-proxy Edge Function. Never
 * throws: degrades to `{ available: false }` on the sentinel body OR on any
 * fetch/non-2xx error.
 */
export async function youtubeStreamStart(
  videoId: string,
): Promise<YoutubeStreamStart | ProxyUnavailable> {
  try {
    const res = await timeoutFetch(
      `${env.SUPABASE_URL}/functions/v1/youtube-proxy?video=${encodeURIComponent(videoId)}`,
      { headers: await authHeaders() },
    );
    if (!res.ok) return { available: false };
    const body = (await res.json()) as unknown;
    if (isUnavailable(body)) return { available: false };
    return body as YoutubeStreamStart;
  } catch {
    return { available: false };
  }
}
