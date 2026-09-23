// supabase/functions/sync-event-results/index.ts
// Pull-based RECONCILE of TBA match results into our `match` table. The
// tba-webhook lands results in real time, but TBA webhooks can be dropped or
// delayed; the app calls this periodically (and once on load to backfill) so a
// missed webhook self-heals, predicted times keep moving, and previously-played
// matches are never stuck "unplayed". Writes with the service role (clients
// can't UPDATE `match`).
//
// Idempotent: re-running upserts the same rows. Returns a small summary.
// Deployed with verify_jwt = false (it only pulls public TBA data and writes
// authentic results keyed by the globally-unique TBA match_key; event_key is
// format-validated). This also means a cold-load reconcile works before the
// anon session is established. Matches the app's open posture (import-event etc).
import { corsHeaders } from "../_shared/cors.ts";
import { readTextResponse } from "../_shared/readJsonBody.ts";
import {
  shouldWriteMatchRow,
  tbaMatchToRow,
  type MappedMatch,
  type StoredMatch,
  type TbaMatch,
} from "../_shared/tbaMatchRow.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";
const TBA_API_KEY = Deno.env.get("TBA_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Bounded upstream: a hung TBA request must not pin this function (and the
// dashboard's reconcile) for the platform's full wall-clock limit, and a
// runaway body must not exhaust the isolate. A championship division's full
// match list is ~1 MB.
const TBA_TIMEOUT_MS = 10_000;
const MAX_TBA_RESPONSE_BYTES = 4 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  let eventKey = url.searchParams.get("event_key") ?? "";
  if (!eventKey && req.method === "POST") {
    try {
      const body = await req.json();
      eventKey = body?.event_key ?? "";
    } catch { /* ignore */ }
  }
  // TBA keys are lowercase and `match.event_key` references them verbatim; an
  // upper-cased key would fetch fine and then fail every write on the FK.
  eventKey = typeof eventKey === "string" ? eventKey.trim().toLowerCase() : "";
  if (!eventKey) return json({ error: "missing event_key" }, 400);
  // Validate shape (a TBA event key: year + code) before interpolating into the
  // upstream URL / using it as a write scope. Rejects junk + path-traversal.
  if (!/^20\d{2}[a-z0-9]+$/i.test(eventKey)) {
    return json({ error: "invalid event_key format" }, 400);
  }
  if (!TBA_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "function not configured" }, 500);
  }

  let matches: TbaMatch[];
  try {
    const res = await fetch(`${TBA_BASE}/event/${eventKey}/matches`, {
      headers: { "X-TBA-Auth-Key": TBA_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(TBA_TIMEOUT_MS),
    });
    if (!res.ok) return json({ available: false, status: res.status });
    matches = JSON.parse(await readTextResponse(res, MAX_TBA_RESPONSE_BYTES)) as TbaMatch[];
  } catch {
    return json({ available: false, error: "tba unreachable" });
  }
  if (!Array.isArray(matches)) return json({ available: false });

  const now = new Date();
  const rows: MappedMatch[] = [];
  for (const m of matches) {
    const mapped = tbaMatchToRow(m, eventKey, { timing: "authoritative", now });
    if (mapped) rows.push(mapped);
  }

  const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Only write rows that actually changed, so a 60s reconcile doesn't rewrite
  // the whole schedule every minute (see shouldWriteMatchRow).
  const { data: existing, error: existingError } = await svc
    .from("match")
    .select(
      "match_key, scheduled_time, predicted_time, actual_time, actual_red_score, " +
        "actual_blue_score, winner, red1, red2, red3, blue1, blue2, blue3",
    )
    .eq("event_key", eventKey);
  if (existingError) {
    // Without the stored rows every match looks "new", which bypasses the guard
    // that stops a regressed (unplayed-shaped) TBA payload from erasing a result
    // we already hold. Skip this pass; the next reconcile tick retries.
    console.error("[sync-event-results] existing-row read failed", existingError.message);
    return json({ available: false, error: "existing rows unavailable" });
  }
  const prev = new Map<string, StoredMatch>(
    ((existing ?? []) as Array<StoredMatch & { match_key: string }>).map((r) => [r.match_key, r]),
  );
  const toWrite = rows
    .filter((mapped) => shouldWriteMatchRow(prev.get(mapped.row.match_key as string), mapped))
    .map((mapped) => mapped.row);

  if (toWrite.length > 0) {
    // A bulk upsert sends the UNION of every row's keys and pads the gaps with
    // NULL, so a roster-less row batched with rostered rows would have its
    // stored teams wiped. Group rows by their exact column set instead.
    const batches = new Map<string, typeof toWrite>();
    for (const row of toWrite) {
      const signature = Object.keys(row).sort().join(",");
      batches.set(signature, [...(batches.get(signature) ?? []), row]);
    }
    for (const batch of batches.values()) {
      const { error } = await svc.from("match").upsert(batch, { onConflict: "match_key" });
      if (error) {
        // Degrade to a sentinel (200) instead of 500 — e.g. an FK error for an
        // un-imported event must not crash the dashboard's periodic reconcile.
        console.error("[sync-event-results] upsert failed", error.message);
        return json({ available: false, error: error.message });
      }
    }
  }

  return json({
    event_key: eventKey,
    total: rows.length,
    played: rows.filter((r) => r.played).length,
    written: toWrite.length,
  });
});
