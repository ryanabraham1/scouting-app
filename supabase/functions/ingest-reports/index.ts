// supabase/functions/ingest-reports/index.ts
// QR/cross-scout ingest path: the receiving device submits reports authored on
// ANOTHER device. Authorization is the receiver's JWT (the HMAC model is gone).
//
// Gate (mirrors the import-event admin-gate pattern):
//   1. Read the Authorization header (the receiver's session JWT). 401 if absent.
//   2. Build a caller client bound to that JWT (anon key) and call
//      get_my_event_keys() → string[] to learn the receiver's events.
//   3. Validate every report.event_key. A receiver WITH events may only ingest
//      into those events. A receiver with NO events (BUG-7: this device hasn't
//      picked a scouter yet, so it has no scout row and get_my_event_keys() is
//      EMPTY) must NOT 403 the whole backlog — instead every report.event_key is
//      validated against the `event` table directly (service role). Either way a
//      bad batch writes NOTHING (an unknown event_key 403s before any write).
//   4. Upsert with a service-role client (auth.uid() NULL ⇒ the upsert_match_report
//      ownership gate is exempt; it RESOLVES/PROVISIONS the scout row per 0022/0032)
//      so QR can carry OTHER scouts' reports. The RPC is revision-guarded ⇒
//      re-ingesting the same id+revision is an idempotent no-op.

import { corsHeaders } from "../_shared/cors.ts";
import {
  BodyTooLargeError,
  readJsonBody,
} from "../_shared/readJsonBody.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Supabase auto-injects all three of these as function env.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_REPORTS = 100;
const MAX_REPORT_BYTES = 256 * 1024;

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

  // (2) Look up the receiver's events (which events this caller is a member of).
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: myEvents, error: eventsErr } = await caller.rpc(
    "get_my_event_keys",
  );
  // Distinguish a transient lookup failure (retryable) from a legitimate empty
  // result. A DB/network error must NOT be silently treated as "no events", or a
  // recoverable blip would route a member through the looser event-table fallback.
  if (eventsErr) {
    return json({ error: "membership lookup failed" }, 503);
  }
  // BUG-7: a receiver that hasn't picked a scouter yet has NO scout row, so
  // get_my_event_keys() is EMPTY. Do NOT 403 the whole backlog — fall back to
  // validating each report's event_key against the `event` table (service role).
  // The whole point of QR is recovering a sender on a device that may not itself
  // be a member; the service-role upsert resolves/provisions the scout row anyway.
  const memberEvents = new Set<string>(
    Array.isArray(myEvents) ? (myEvents as string[]) : [],
  );

  // Service-role client: used both for the event-existence fallback and the
  // ownership-exempt, revision-guarded upsert loop.
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Parse the body: { reports: [...] }. No HMAC.
  let payload: IngestPayload;
  try {
    payload = await readJsonBody(req, MAX_REQUEST_BYTES) as IngestPayload;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json({ error: error.message }, 413);
    }
    return json({ error: "invalid JSON" }, 400);
  }

  if (!payload || !Array.isArray(payload.reports)) {
    return json({ error: "expected { reports: [] }" }, 400);
  }
  if (payload.reports.length > MAX_REPORTS) {
    return json({ error: `at most ${MAX_REPORTS} reports per batch` }, 413);
  }
  for (const report of payload.reports) {
    if (
      report == null ||
      typeof report !== "object" ||
      new TextEncoder().encode(JSON.stringify(report)).byteLength >
        MAX_REPORT_BYTES
    ) {
      return json({ error: "report is malformed or too large" }, 413);
    }
  }

  // (3) Pre-check EVERY report's event_key BEFORE any write so a bad batch
  //     writes nothing. A member is restricted to their OWN events; a receiver
  //     with no events validates each key against real, existing events instead.
  const knownEvents = new Set<string>(memberEvents);
  for (const report of payload.reports) {
    const eventKey = report?.event_key;
    if (typeof eventKey !== "string") {
      return json({ error: "forbidden: report missing event_key" }, 403);
    }
    if (knownEvents.has(eventKey)) continue;
    if (memberEvents.size > 0) {
      // Caller IS a member of some events — they may only ingest into those.
      return json({ error: "forbidden: report outside your events" }, 403);
    }
    // Scouter-less receiver: accept the key only if it names a REAL event.
    const { data: ev, error: evErr } = await svc
      .from("event")
      .select("event_key")
      .eq("event_key", eventKey)
      .maybeSingle();
    if (evErr) {
      return json({ error: "event lookup failed" }, 503);
    }
    if (!ev) {
      return json({ error: "forbidden: unknown event" }, 403);
    }
    knownEvents.add(eventKey); // cache so repeats in the batch don't re-query
  }

  // (4) Service-role upsert loop (ownership gate exempt; revision-guarded).
  //     Continue-on-error: attempt EVERY report so a single bad row never
  //     partial-commits-then-400 and strands the rest. The revision guard makes
  //     re-sending the whole batch idempotent, so the receiver can safely re-send
  //     to retry only the failures.
  let ingested = 0;
  const failed: { index: number; error: string }[] = [];
  for (let index = 0; index < payload.reports.length; index++) {
    const { data, error } = await svc.rpc("upsert_match_report", {
      p: payload.reports[index],
    });
    if (error) {
      failed.push({ index, error: error.message });
    } else if (
      data?.status === "applied" ||
      data?.status === "idempotent"
    ) {
      ingested++;
    } else {
      failed.push({
        index,
        error: `sync ${data?.status ?? "invalid-result"}; current revision ${
          data?.current_revision ?? "unknown"
        }`,
      });
    }
  }

  return json({ ingested, failed }, 200);
});
