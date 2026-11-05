// supabase/functions/autoscout-worker/index.ts
// The Auto-Scout computer's only door into the app. It calls out to here, so it stays unreachable
// from the internet and needs no Supabase key: just a dedicated worker token that can do nothing
// except what the two actions below allow. Only its hash is stored (autoscout_worker_secret).
//
// POST { action: 'sync', worker, jobs: JobReport[] }
//   -> { jobs: Job[], cancel: string[] }    heartbeat + status in, new work and stops out
// POST { action: 'result', job_id, match_key, envelope }
//   -> { stored: boolean }                  false = a newer run of this match already landed

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { BodyTooLargeError, readJsonBody } from "../_shared/readJsonBody.ts";
import {
  isJobId,
  isMatchKey,
  hashMatches,
  isValidEnvelope,
  MAX_REQUEST_BYTES,
  parseJobReport,
  parseWorkerInfo,
  tokenHash,
} from "../_shared/autoscoutWorker.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAX_JOBS_PER_SYNC = 10;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function authorized(header: string | null): Promise<boolean> {
  const hash = await tokenHash(header);
  if (!hash) return false;
  const { data, error } = await db.from("autoscout_worker_secret").select("token_sha256").maybeSingle();
  if (error) throw error;
  return hashMatches(hash, data?.token_sha256);
}

async function sync(body: Record<string, unknown>): Promise<Response> {
  const now = new Date().toISOString();
  const worker = parseWorkerInfo(body.worker);
  const beat = await db.from("autoscout_worker").upsert({ id: true, last_seen_at: now, ...worker });
  if (beat.error) throw beat.error;

  const reports = (Array.isArray(body.jobs) ? body.jobs : []).slice(0, 200).map(parseJobReport);
  for (const report of reports) {
    if (!report) continue;
    const { id, status, ...fields } = report;
    const update: Record<string, unknown> = { ...fields, updated_at: now };
    if (status !== "queued") update.status = status;
    // Finished is final: a late retry must not reopen a job or wipe its results.
    const done = await db.from("autoscout_job").update(update).eq("id", id).in("status", ["queued", "running"]);
    if (done.error) throw done.error;
  }

  const open = await db
    .from("autoscout_job")
    .select("id,event_key,kind,match_keys,source_url,stream_starts,force,scout,created_at,status,cancel_requested")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(200);
  if (open.error) throw open.error;
  const rows = open.data ?? [];

  const jobs = rows.filter((j) => j.status === "queued" && !j.cancel_requested).slice(0, MAX_JOBS_PER_SYNC);
  if (jobs.length > 0) {
    const claim = await db
      .from("autoscout_job")
      .update({ claimed_at: now })
      .in("id", jobs.map((j) => j.id))
      .is("claimed_at", null);
    if (claim.error) throw claim.error;
  }
  return json({ jobs, cancel: rows.filter((j) => j.cancel_requested).map((j) => j.id) });
}

async function result(body: Record<string, unknown>): Promise<Response> {
  const { job_id: jobId, match_key: matchKey, envelope } = body;
  if (!isJobId(jobId) || !isMatchKey(matchKey) || !isValidEnvelope(envelope, matchKey)) {
    return json({ error: "invalid result" }, 422);
  }
  const stored = await db.rpc("autoscout_store_result", {
    p_job_id: jobId,
    p_match_key: matchKey,
    p_envelope: envelope,
  });
  if (stored.error) throw stored.error;
  return json({ stored: stored.data === true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    if (!await authorized(req.headers.get("authorization"))) return json({ error: "unauthorized" }, 401);
    const body = await readJsonBody(req, MAX_REQUEST_BYTES) as Record<string, unknown>;
    if (body?.action === "sync") return await sync(body);
    if (body?.action === "result") return await result(body);
    return json({ error: "unknown action" }, 400);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return json({ error: "too large" }, 413);
    if (error instanceof SyntaxError || error instanceof TypeError) return json({ error: "bad request" }, 400);
    console.error("[autoscout-worker]", error);
    return json({ error: "server error" }, 500);
  }
});
