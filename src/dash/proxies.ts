import { env } from '@/lib/env';
import { supabase } from '@/lib/supabase';

/** Sentinel the Edge proxies return when the upstream service is unavailable. */
export interface ProxyUnavailable {
  available: false;
}

function isUnavailable(body: unknown): body is ProxyUnavailable {
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
  const res = await fetch(proxyUrl('tba-proxy', path), {
    headers: await authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`tba-proxy request failed (${res.status}) for ${path}`);
  }
  return (await res.json()) as T;
}

/**
 * Read through the Statbotics Edge proxy. Never throws: degrades to
 * `{ available: false }` on the sentinel body OR on any fetch/non-2xx error,
 * so the dashboard keeps working through a Statbotics outage.
 */
export async function statboticsGet<T>(path: string): Promise<T | ProxyUnavailable> {
  try {
    const res = await fetch(proxyUrl('statbotics-proxy', path), {
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
