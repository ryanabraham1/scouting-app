// supabase/functions/tba-webhook/index.ts
// Receives The Blue Alliance webhook notifications (real-time, push) and lands
// match RESULTS into our `match` table so the dashboard knows which matches have
// been played. Without this, every match looks "unplayed" forever and the
// next-match selector is stuck on each team's first match.
//
// Security: TBA signs every POST with X-TBA-HMAC = HMAC-SHA256(secret, rawBody),
// hex-encoded, where `secret` is what you entered when creating the webhook
// (TBA_WEBHOOK_SECRET here). We verify it constant-time. (Older TBA builds sent
// X-TBA-Checksum = SHA1(secret + body); accepted as a fallback.)
//
// Resilience: TBA gives each POST a 10s timeout and DELETES endpoints that error
// or time out. So we (a) answer verification/ping fast, and (b) swallow internal
// processing errors as 200 (logged) — the periodic results reconcile self-heals
// anything we drop. Only a failed signature check returns non-200.
//
// Deployed with verify_jwt = false (TBA does not send a Supabase JWT).
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  tbaMatchToRow,
  upcomingMatchToRow,
  withoutUnplayedResult,
  type TbaMatch,
} from "../_shared/tbaMatchRow.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TBA_WEBHOOK_SECRET") ?? "";

function ok(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time string compare (lengths may differ; still no early-out on content). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(sig);
}

async function sha1Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(message));
  return toHex(digest);
}

type SigResult = "ok" | "bad" | "no-secret";

/**
 * Verify the request signature against the configured secret.
 *   - "no-secret": TBA_WEBHOOK_SECRET is unset. Callers must FAIL CLOSED for any
 *     DB write (we can't authenticate the request) but may still 200 the
 *     verification/ping handshake so initial setup completes.
 *   - "bad": a signature was presented (or required) and did not match -> reject.
 *   - "ok": signature matches.
 */
async function verifySignature(req: Request, rawBody: string): Promise<SigResult> {
  if (!WEBHOOK_SECRET) {
    console.warn("[tba-webhook] TBA_WEBHOOK_SECRET unset — refusing data writes (set the secret)");
    return "no-secret";
  }
  const hmacHeader = req.headers.get("X-TBA-HMAC");
  if (hmacHeader) {
    const expected = await hmacSha256Hex(WEBHOOK_SECRET, rawBody);
    const match = timingSafeEqual(hmacHeader.trim().toLowerCase(), expected);
    if (!match) {
      console.warn(
        `[tba-webhook] HMAC mismatch: got ${hmacHeader.slice(0, 10)}… expected ${expected.slice(0, 10)}… ` +
          `(check TBA_WEBHOOK_SECRET matches the secret entered in your TBA account)`,
      );
    }
    return match ? "ok" : "bad";
  }
  const checksum = req.headers.get("X-TBA-Checksum");
  if (checksum) {
    const expected = await sha1Hex(WEBHOOK_SECRET + rawBody);
    return timingSafeEqual(checksum.trim().toLowerCase(), expected) ? "ok" : "bad";
  }
  console.warn("[tba-webhook] no signature header present");
  return "bad";
}

function svcClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Upsert a TBA Match object (from a match_score notification) into `match`.
 * Shares its mapping with the sync-event-results reconcile (_shared/
 * tbaMatchRow.ts). A match counts as PLAYED only when both alliance scores are
 * present and >= 0 (TBA uses -1 for not-yet-played); only then are winner +
 * result_synced_at stamped, which is what flips the match out of the
 * "unplayed" set the next-match selector reads. An unplayed notification never
 * touches the stored result columns, and a missing roster/time is left as-is.
 */
async function upsertMatchScore(m: TbaMatch): Promise<void> {
  const mapped = tbaMatchToRow(m, typeof m?.event_key === "string" ? m.event_key : "", {
    timing: "present-only",
  });
  if (!mapped) {
    console.warn("[tba-webhook] match_score: unusable match", m?.key, m?.comp_level);
    return;
  }
  const row = withoutUnplayedResult(mapped);
  const { error } = await svcClient().from("match").upsert(row, { onConflict: "match_key" });
  if (error) {
    console.error("[tba-webhook] match upsert failed", row.match_key, error.message);
    throw error;
  }
  console.log(
    `[tba-webhook] match_score ${row.match_key} played=${mapped.played} ` +
      `${row.actual_red_score ?? "-"}-${row.actual_blue_score ?? "-"}`,
  );
}

/**
 * Ensure a match ROW exists for an upcoming_match notification (so playoff
 * matches that were never imported show up, and teams/time stay current).
 * Never touches result columns; see upcomingMatchToRow for the roster guard.
 */
async function upsertUpcoming(data: Record<string, unknown>): Promise<void> {
  const row = upcomingMatchToRow(data);
  if (!row) return;
  const { error } = await svcClient().from("match").upsert(row, { onConflict: "match_key" });
  if (error) console.error("[tba-webhook] upcoming upsert failed", row.match_key, error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return ok({ ok: true, note: "tba-webhook up" });

  const rawBody = await req.text();

  let payload: { message_type?: unknown; message_data?: unknown };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return ok({ ok: true, note: "non-JSON body ignored" });
  }
  // `null` / an array / a bare string is valid JSON too; dereferencing it would
  // throw into a 500 and TBA deletes endpoints that error.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ok({ ok: true, note: "non-object body ignored" });
  }

  const type = typeof payload.message_type === "string" ? payload.message_type : undefined;
  const data =
    payload.message_data && typeof payload.message_data === "object" &&
      !Array.isArray(payload.message_data)
      ? (payload.message_data as Record<string, unknown>)
      : {};

  // Handshake messages: answered WITHOUT a signature so initial setup completes
  // before the secret is configured, and must 200 fast or TBA prunes the webhook.
  // They never touch the DB.
  if (type === "ping") {
    console.log("[tba-webhook] ping");
    return ok({ ok: true, pong: true });
  }
  if (type === "verification") {
    console.log("[tba-webhook] verification_key:", data.verification_key);
    return ok({ ok: true, verification_key: data.verification_key });
  }

  // Everything below writes to the DB -> require a valid signature, FAIL CLOSED.
  const sig = await verifySignature(req, rawBody);
  if (sig === "bad") {
    console.warn("[tba-webhook] signature verification FAILED");
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (sig === "no-secret") {
    // 200 (so TBA doesn't delete the webhook) but DO NOT write unauthenticated data.
    return ok({ ok: true, note: "TBA_WEBHOOK_SECRET unset; data message ignored" });
  }

  // Data messages — swallow processing errors as 200 (reconcile self-heals).
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error("[tba-webhook] service env not configured");
      return ok({ ok: true, note: "not configured" });
    }
    switch (type) {
      case "match_score":
        await upsertMatchScore((data.match ?? {}) as TbaMatch);
        break;
      case "upcoming_match":
        await upsertUpcoming(data);
        break;
      case "schedule_updated":
      case "starting_comp_level":
      case "alliance_selection":
      case "awards_posted":
      case "match_video":
      case "broadcast":
        console.log(`[tba-webhook] ${type} (no-op)`);
        break;
      default:
        console.log("[tba-webhook] unknown message_type", type);
    }
  } catch (e) {
    console.error("[tba-webhook] processing error", (e as Error).message);
  }
  return ok();
});
