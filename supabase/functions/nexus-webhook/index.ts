// supabase/functions/nexus-webhook/index.ts
// Receives FRC Nexus pushLiveEventStatus webhooks and stores the latest live
// field snapshot per event into `nexus_event_status`. The dashboard reads that
// row over Supabase Realtime, so "On Field" / "Queuing" / our-next-match advance
// the instant Nexus pushes — no polling lag, no stale snapshot.
//
// Security: Nexus sends a `Nexus-Token` header (the token shown when you register
// the webhook at frc.nexus/api). We compare it to NEXUS_WEBHOOK_TOKEN.
//
// Staleness: the nexus_upsert_status RPC only writes when the incoming
// dataAsOfTime is >= the stored one, so an out-of-order push can never roll the
// field backwards (the root cause of "On Field" freezing on an old match).
//
// Resilience: Nexus auto-disables endpoints that don't return 200, so every code
// path here returns 200 except a real auth failure. Deployed verify_jwt = false.
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_TOKEN = Deno.env.get("NEXUS_WEBHOOK_TOKEN") ?? "";

function ok(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** SHA-256 hex of a string — used to compare tokens at a fixed length so the
 *  secret token's length isn't leaked by an early length-mismatch return. */
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-length, constant-time token compare (hashes both sides first). */
async function tokensMatch(presented: string, secret: string): Promise<boolean> {
  return timingSafeEqual(await sha256Hex(presented), await sha256Hex(secret));
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return ok({ ok: true, note: "nexus-webhook up" });

  // Verify token. FAIL CLOSED when unset: we 200 (so Nexus doesn't disable the
  // endpoint) but do NOT store an unauthenticated snapshot. Set NEXUS_WEBHOOK_TOKEN
  // (shown when you register the webhook at frc.nexus/api) to start ingesting.
  if (!WEBHOOK_TOKEN) {
    console.warn("[nexus-webhook] NEXUS_WEBHOOK_TOKEN unset — push ignored (set the token)");
    return ok({ ok: true, note: "NEXUS_WEBHOOK_TOKEN unset; push ignored" });
  }
  const token = req.headers.get("Nexus-Token") ?? "";
  if (!(await tokensMatch(token, WEBHOOK_TOKEN))) {
    console.warn("[nexus-webhook] token mismatch");
    return new Response(JSON.stringify({ error: "invalid token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(await req.text());
  } catch {
    return ok({ ok: true, note: "non-JSON body ignored" });
  }

  const eventKey = asString(payload.eventKey);
  if (!eventKey) {
    console.warn("[nexus-webhook] payload missing eventKey");
    return ok({ ok: true, note: "no eventKey" });
  }
  const dataAsOfTime = asFiniteNumber(payload.dataAsOfTime);
  const nowQueuing = asString(payload.nowQueuing);

  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error("[nexus-webhook] service env not configured");
      return ok({ ok: true, note: "not configured" });
    }
    const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: written, error } = await svc.rpc("nexus_upsert_status", {
      p_event_key: eventKey,
      p_data_as_of_time: dataAsOfTime,
      p_now_queuing: nowQueuing,
      p_payload: payload,
    });
    if (error) {
      console.error("[nexus-webhook] upsert failed", error.message);
    } else {
      console.log(`[nexus-webhook] ${eventKey} asOf=${dataAsOfTime} written=${written}`);
    }
  } catch (e) {
    console.error("[nexus-webhook] processing error", (e as Error).message);
  }
  return ok();
});
