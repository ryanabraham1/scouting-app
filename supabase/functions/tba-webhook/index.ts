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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TBA_WEBHOOK_SECRET") ?? "";

const ALLOWED_LEVELS = new Set(["qm", "ef", "qf", "sf", "f"]);

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

// frcNNNN -> NNNN.
function teamNum(teamKey: string | undefined | null): number | null {
  if (!teamKey) return null;
  const n = parseInt(String(teamKey).replace("frc", ""), 10);
  return Number.isFinite(n) ? n : null;
}

interface TbaAlliance {
  score?: number | null;
  teams?: string[];
  team_keys?: string[];
}
interface TbaMatch {
  key?: string;
  event_key?: string;
  comp_level?: string;
  match_number?: number;
  set_number?: number;
  time?: number | null;
  winning_alliance?: string | null;
  alliances?: { red?: TbaAlliance; blue?: TbaAlliance };
}

function svcClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Winner from TBA's field if present, else derived from the two scores. */
function winnerOf(m: TbaMatch, red: number | null, blue: number | null): string | null {
  const wa = (m.winning_alliance ?? "").toLowerCase();
  if (wa === "red" || wa === "blue") return wa;
  if (red == null || blue == null) return null;
  if (red > blue) return "red";
  if (blue > red) return "blue";
  return "tie";
}

/**
 * Upsert a TBA Match object (from a match_score notification) into `match`,
 * writing schedule + result fields. A match counts as PLAYED only when both
 * alliance scores are present and >= 0 (TBA uses -1 for not-yet-played); only
 * then do we stamp winner + result_synced_at, which is what flips the match out
 * of the "unplayed" set the next-match selector reads.
 */
async function upsertMatchScore(m: TbaMatch): Promise<void> {
  const matchKey = m.key;
  const compLevel = (m.comp_level ?? "").toLowerCase();
  if (!matchKey || !m.event_key || !ALLOWED_LEVELS.has(compLevel)) {
    console.warn("[tba-webhook] match_score: unusable match", matchKey, compLevel);
    return;
  }
  const red = m.alliances?.red ?? {};
  const blue = m.alliances?.blue ?? {};
  const redKeys = red.team_keys ?? red.teams ?? [];
  const blueKeys = blue.team_keys ?? blue.teams ?? [];
  const redScore = typeof red.score === "number" && red.score >= 0 ? red.score : null;
  const blueScore = typeof blue.score === "number" && blue.score >= 0 ? blue.score : null;
  const played = redScore != null && blueScore != null;

  const row: Record<string, unknown> = {
    match_key: matchKey,
    event_key: m.event_key,
    comp_level: compLevel,
    match_number: m.match_number ?? null,
  };
  // Only write team columns when the payload actually carries rosters — a
  // result-only / malformed notification must not NULL out the teams the
  // importer/reconcile already populated (upsert leaves omitted columns as-is).
  if (redKeys.length > 0) {
    row.red1 = teamNum(redKeys[0]);
    row.red2 = teamNum(redKeys[1]);
    row.red3 = teamNum(redKeys[2]);
  }
  if (blueKeys.length > 0) {
    row.blue1 = teamNum(blueKeys[0]);
    row.blue2 = teamNum(blueKeys[1]);
    row.blue3 = teamNum(blueKeys[2]);
  }
  if (m.time) row.scheduled_time = new Date(m.time * 1000).toISOString();
  if (played) {
    row.actual_red_score = redScore;
    row.actual_blue_score = blueScore;
    row.winner = winnerOf(m, redScore, blueScore);
    row.result_synced_at = new Date().toISOString();
  }

  const { error } = await svcClient().from("match").upsert(row, { onConflict: "match_key" });
  if (error) {
    console.error("[tba-webhook] match upsert failed", matchKey, error.message);
    throw error;
  }
  console.log(`[tba-webhook] match_score ${matchKey} played=${played} ${redScore}-${blueScore}`);
}

/**
 * Ensure a match ROW exists for an upcoming_match notification (so playoff
 * matches that were never imported show up, and teams/time stay current).
 * team_keys are red[0..2] then blue[3..5]. Never touches result columns.
 */
async function upsertUpcoming(data: Record<string, unknown>): Promise<void> {
  const matchKey = data.match_key as string | undefined;
  const eventKey = data.event_key as string | undefined;
  if (!matchKey || !eventKey) return;
  // Parse the key tail "<level><set>m<game>" (…_qm12 / …_sf3m1 / …_f1m2). For
  // playoffs TBA's match_number is the GAME-within-set (the m<N> suffix), so use
  // that when present — matching what the match_score path writes — otherwise the
  // plain number (quals). Avoids the same key getting match_number=set from here
  // and match_number=game from match_score.
  const tail = matchKey.includes("_") ? matchKey.slice(matchKey.lastIndexOf("_") + 1) : matchKey;
  const parsed = tail.match(/^([a-zA-Z]+)(\d+)(?:m(\d+))?/);
  const lvl = (parsed?.[1] ?? "").toLowerCase();
  const num = Number(parsed?.[3] ?? parsed?.[2] ?? NaN);
  if (!ALLOWED_LEVELS.has(lvl)) return;
  const teamKeys = Array.isArray(data.team_keys) ? (data.team_keys as string[]) : [];
  const row: Record<string, unknown> = {
    match_key: matchKey,
    event_key: eventKey,
    comp_level: lvl,
    match_number: Number.isFinite(num) ? num : null,
    red1: teamNum(teamKeys[0]),
    red2: teamNum(teamKeys[1]),
    red3: teamNum(teamKeys[2]),
    blue1: teamNum(teamKeys[3]),
    blue2: teamNum(teamKeys[4]),
    blue3: teamNum(teamKeys[5]),
  };
  const scheduled = (data.predicted_time ?? data.scheduled_time) as number | undefined;
  if (scheduled) row.scheduled_time = new Date(scheduled * 1000).toISOString();
  const { error } = await svcClient().from("match").upsert(row, { onConflict: "match_key" });
  if (error) console.error("[tba-webhook] upcoming upsert failed", matchKey, error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return ok({ ok: true, note: "tba-webhook up" });

  const rawBody = await req.text();

  let payload: { message_type?: string; message_data?: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return ok({ ok: true, note: "non-JSON body ignored" });
  }

  const type = payload.message_type;
  const data = payload.message_data ?? {};

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
