// supabase/functions/statbotics-proxy/index.ts
import { corsHeaders } from "../_shared/cors.ts";
import { readTextResponse } from "../_shared/readJsonBody.ts";
import { isSafeProxyPath } from "../_shared/validatePath.ts";

const SB_BASE = "https://api.statbotics.io/v3";
const CACHE_TTL_MS = 300_000;
/** A good body older than its TTL is still served when the upstream is failing. */
const STALE_MAX_MS = 24 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 128;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Statbotics answers in well under a second when healthy; a slow reply is an outage. */
const UPSTREAM_TIMEOUT_MS = 4_000;
/**
 * Circuit breaker: after an upstream failure, skip Statbotics for this long and
 * answer immediately (stale body or the sentinel). Without it, every request in
 * a season-EPA fan-out re-waited the full timeout on a dead upstream, stalling
 * the dashboard's EPA load for many seconds per team.
 */
const BREAKER_OPEN_MS = 60_000;
let upstreamDownUntil = 0;

interface CacheEntry {
  expires: number;
  body: string;
}
const cache = new Map<string, CacheEntry>();

function cacheResponse(path: string, entry: CacheEntry): void {
  cache.delete(path);
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(path, entry);
}

function cachedBody(body: string, cacheStatus: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Cache": cacheStatus,
    },
  });
}

function unavailable(notFound = false): Response {
  const body = notFound ? { available: false, notFound: true } : { available: false };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!isSafeProxyPath(path)) {
    return new Response(
      JSON.stringify({ error: "missing or invalid 'path' query param" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const now = Date.now();
  const cached = cache.get(path);
  if (cached && cached.expires > now) {
    return cachedBody(cached.body, "HIT");
  }
  const stale = cached && cached.expires + STALE_MAX_MS > now ? cached : null;
  // Upstream failing → degrade instantly: last good body if we have one, else
  // the sentinel.
  const degrade = (): Response => stale ? cachedBody(stale.body, "STALE") : unavailable();
  const fail = (): Response => {
    upstreamDownUntil = Date.now() + BREAKER_OPEN_MS;
    return degrade();
  };
  if (now < upstreamDownUntil) {
    return degrade();
  }

  // Test-only hook to simulate an upstream outage deterministically.
  // Disabled in production to prevent misuse.
  if (Deno.env.get("DENO_ENV") !== "production") {
    const forced = url.searchParams.get("_forceUpstreamStatus");
    if (forced) {
      const code = Number(forced);
      if (code >= 500) return unavailable();
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${SB_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (_err) {
    return fail();
  }

  // ANY non-OK upstream status degrades to the sentinel so the dashboard can
  // fall back (e.g. to local EPA) instead of seeing a hard 4xx/5xx.
  if (!upstream.ok) {
    // A 404 is a real answer (team has no season row), not an outage.
    if (upstream.status === 404) return unavailable(true);
    return fail();
  }

  let body: string;
  try {
    body = await readTextResponse(upstream, MAX_RESPONSE_BYTES);
  } catch {
    return fail();
  }
  upstreamDownUntil = 0;
  cacheResponse(path, { expires: now + CACHE_TTL_MS, body });

  return cachedBody(body, "MISS");
});
