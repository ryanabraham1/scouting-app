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

/** A team's season numbers from match13 (any field may be missing). */
export interface Match13Team {
  /** match13's season xP rating, on the points scale. */
  xp: number | null;
  /** World rank by xP among the season's teams. */
  rank: number | null;
  auto: number | null;
  teleop: number | null;
  endgame: number | null;
}

/** How long to stop calling match13 after it reports an outage. */
export const MATCH13_BACKOFF_MS = 60_000;
let match13DownUntil = 0;

/** Test hook: forget a remembered match13 outage. */
export function resetMatch13Backoff(): void {
  match13DownUntil = 0;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Decode the proxy's `{ columns, teams: [[team, xp, rank, auto, teleop, endgame]] }` table. */
export function parseMatch13Season(body: unknown): Map<number, Match13Team> | null {
  if (typeof body !== 'object' || body === null) return null;
  const { columns, teams } = body as { columns?: unknown; teams?: unknown };
  if (!Array.isArray(columns) || !Array.isArray(teams)) return null;
  const col = (name: string) => columns.indexOf(name);
  const [iTeam, iXp, iRank, iAuto, iTele, iEnd] =
    ['team', 'xp', 'rank', 'auto', 'teleop', 'endgame'].map(col);
  if (iTeam < 0) return null;
  const at = (row: unknown[], i: number) => (i < 0 ? null : finiteOrNull(row[i]));
  const out = new Map<number, Match13Team>();
  for (const row of teams) {
    if (!Array.isArray(row)) continue;
    const team = at(row, iTeam);
    if (team == null) continue;
    out.set(team, {
      xp: at(row, iXp),
      rank: at(row, iRank),
      auto: at(row, iAuto),
      teleop: at(row, iTele),
      endgame: at(row, iEnd),
    });
  }
  return out;
}

/**
 * Every team's season numbers from match13, through the match13-proxy Edge
 * Function (which holds the API key and caches the season). One request covers
 * the whole season, so callers look teams up in the returned map instead of
 * fetching per team. Never throws: degrades to `{ available: false }`, and once
 * match13 reports an outage answers that locally for MATCH13_BACKOFF_MS so no
 * screen keeps waiting on a dead upstream.
 */
export async function match13Season(
  year: string,
): Promise<Map<number, Match13Team> | ProxyUnavailable> {
  if (Date.now() < match13DownUntil) {
    return { available: false };
  }
  const down = (): ProxyUnavailable => {
    match13DownUntil = Date.now() + MATCH13_BACKOFF_MS;
    return { available: false };
  };
  try {
    const res = await timeoutFetch(
      `${env.SUPABASE_URL}/functions/v1/match13-proxy?year=${encodeURIComponent(year)}`,
      { headers: await authHeaders() },
    );
    if (!res.ok) return down();
    const table = parseMatch13Season((await res.json()) as unknown);
    return table ?? down();
  } catch {
    return down();
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
