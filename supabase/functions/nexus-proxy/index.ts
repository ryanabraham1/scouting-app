// supabase/functions/nexus-proxy/index.ts
// Live FRC Nexus field-status proxy. Attaches the Nexus-Api-Key header from the
// NEXUS_API_KEY secret. Graceful { available: false } on a missing key, any
// network error, OR any non-OK upstream status — so a Nexus outage / a 404 for
// an event with no live data never surfaces as a hard error to the dashboard.
//
// NO CACHING: Nexus reports the LIVE field (what's queuing / on the field right
// now), so every request must hit upstream fresh. A stale cache would freeze the
// "On Field" / "Queuing" tiles mid-event. Responses are sent with no-store.
import { corsHeaders } from "../_shared/cors.ts";
import { isSafeProxyPath } from "../_shared/validatePath.ts";

const NEXUS_BASE = "https://frc.nexus/api/v1";

// No-store on every response: this is live data; nothing here may be cached by
// the browser, a CDN, or React Query's HTTP layer.
const NO_STORE = "no-store, no-cache, must-revalidate";

function unavailable(): Response {
  return new Response(JSON.stringify({ available: false }), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": NO_STORE,
    },
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

  // Test-only hook to simulate an upstream outage deterministically.
  // Disabled in production to prevent misuse.
  if (Deno.env.get("DENO_ENV") !== "production") {
    const forced = url.searchParams.get("_forceUpstreamStatus");
    if (forced) {
      const code = Number(forced);
      if (code >= 400) return unavailable();
    }
  }

  // No key configured -> degrade gracefully (clients treat this as "Nexus down").
  const apiKey = Deno.env.get("NEXUS_API_KEY");
  if (!apiKey) {
    return unavailable();
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${NEXUS_BASE}${path}`, {
      headers: { Accept: "application/json", "Nexus-Api-Key": apiKey },
    });
  } catch (_err) {
    return unavailable();
  }

  // ANY non-OK upstream status (404 for an event with no live data, 4xx, 5xx)
  // degrades to the sentinel rather than surfacing a hard error to the client.
  if (!upstream.ok) {
    return unavailable();
  }

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": NO_STORE,
    },
  });
});
