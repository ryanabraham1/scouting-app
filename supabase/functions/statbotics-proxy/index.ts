// supabase/functions/statbotics-proxy/index.ts
import { corsHeaders } from "../_shared/cors.ts";
import { isSafeProxyPath } from "../_shared/validatePath.ts";

const SB_BASE = "https://api.statbotics.io/v3";
const CACHE_TTL_MS = 300_000;

interface CacheEntry {
  expires: number;
  body: string;
}
const cache = new Map<string, CacheEntry>();

function unavailable(): Response {
  return new Response(JSON.stringify({ available: false }), {
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
    return new Response(cached.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Cache": "HIT",
      },
    });
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
    });
  } catch (_err) {
    return unavailable();
  }

  // ANY non-OK upstream status degrades to the sentinel so the dashboard can
  // fall back (e.g. to local EPA) instead of seeing a hard 4xx/5xx.
  if (!upstream.ok) {
    return unavailable();
  }

  const body = await upstream.text();
  cache.set(path, { expires: now + CACHE_TTL_MS, body });

  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Cache": "MISS",
    },
  });
});
