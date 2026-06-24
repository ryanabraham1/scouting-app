// supabase/functions/ingest-reports/index.ts
// QR/cross-scout ingest path: any joined event member may submit reports for
// THEIR events. Authorization is JWT event-membership (the HMAC model is gone).
//
// Gate (mirrors the import-event admin-gate pattern):
//   1. Read the Authorization header (the receiver's session JWT). 401 if absent.
//   2. Build a caller client bound to that JWT (anon key) and call
//      get_my_event_keys() → string[]. 403 if it errors or is empty (not a member).
//   3. Pre-check every report.event_key is a string ∈ the caller's events; if any
//      is not, 403 and write NOTHING (a bad batch must not partially land).
//   4. Upsert with a service-role client (auth.uid() NULL ⇒ the upsert_match_report
//      ownership gate is exempt) so QR can carry OTHER scouts' reports. The RPC is
//      revision-guarded ⇒ re-ingesting the same id+revision is an idempotent no-op.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Supabase auto-injects all three of these as function env.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

interface IngestPayload {
  reports: Record<string, unknown>[];
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    return json({ error: "server not configured" }, 500);
  }

  // (1) Require an Authorization header (the receiver's session JWT).
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "missing authorization" }, 401);
  }

  // (2) Membership gate: bind a caller client to the JWT and ask which events
  //     this caller is a member of.
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: myEvents, error: eventsErr } = await caller.rpc(
    "get_my_event_keys",
  );
  // Distinguish a transient lookup failure (retryable) from a genuine
  // non-member (terminal). A DB/network error must NOT be reported as 403, or
  // the receiver would treat a recoverable blip as "you're not allowed".
  if (eventsErr) {
    return json({ error: "membership lookup failed" }, 503);
  }
  if (!Array.isArray(myEvents) || myEvents.length === 0) {
    return json({ error: "forbidden: not an event member" }, 403);
  }
  const memberEvents = new Set<string>(myEvents as string[]);

  // Parse the body: { reports: [...] }. No HMAC.
  let payload: IngestPayload;
  try {
    payload = (await req.json()) as IngestPayload;
  } catch (_err) {
    return json({ error: "invalid JSON" }, 400);
  }

  if (!payload || !Array.isArray(payload.reports)) {
    return json({ error: "expected { reports: [] }" }, 400);
  }

  // (3) Pre-check EVERY report's event_key BEFORE any write so a bad batch
  //     writes nothing.
  for (const report of payload.reports) {
    const eventKey = report?.event_key;
    if (typeof eventKey !== "string" || !memberEvents.has(eventKey)) {
      return json({ error: "forbidden: report outside your events" }, 403);
    }
  }

  // (4) Service-role upsert loop (ownership gate exempt; revision-guarded).
  //     Continue-on-error: attempt EVERY report so a single bad row never
  //     partial-commits-then-400 and strands the rest. The revision guard makes
  //     re-sending the whole batch idempotent, so the receiver can safely re-send
  //     to retry only the failures.
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let ingested = 0;
  const failed: { index: number; error: string }[] = [];
  for (let index = 0; index < payload.reports.length; index++) {
    const { error } = await svc.rpc("upsert_match_report", {
      p: payload.reports[index],
    });
    if (error) {
      failed.push({ index, error: error.message });
    } else {
      ingested++;
    }
  }

  return json({ ingested, failed }, 200);
});
