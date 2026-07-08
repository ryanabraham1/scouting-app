// supabase/functions/tba-proxy/index.ts
import { corsHeaders } from "../_shared/cors.ts";
import { isSafeProxyPath } from "../_shared/validatePath.ts";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";
const TBA_API_KEY = Deno.env.get("TBA_API_KEY") ?? "";
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expires: number;
  status: number;
  body: string;
}
const cache = new Map<string, CacheEntry>();

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
  if (!TBA_API_KEY) {
    return new Response(
      JSON.stringify({ error: "TBA_API_KEY not configured" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const now = Date.now();
  const cached = cache.get(path);
  if (cached && cached.expires > now) {
    return new Response(cached.body, {
      status: cached.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Cache": "HIT",
      },
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${TBA_BASE}${path}`, {
      headers: { "X-TBA-Auth-Key": TBA_API_KEY, Accept: "application/json" },
    });
  } catch (_err) {
    // Upstream network failure: return a clean, CORS-friendly handled error
    // (502) instead of letting the rejection bubble to an unhandled 500.
    // Optional callers (tbaGetOptional) degrade on this; strict callers surface it.
    return new Response(
      JSON.stringify({ error: "tba upstream unreachable" }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  const body = await upstream.text();

  if (upstream.ok) {
    cache.set(path, { expires: now + CACHE_TTL_MS, status: upstream.status, body });
  }

  return new Response(body, {
    status: upstream.status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Cache": "MISS",
    },
  });
});
