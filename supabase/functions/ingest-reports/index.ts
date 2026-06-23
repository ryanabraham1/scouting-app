// supabase/functions/ingest-reports/index.ts
// QR/cross-scout ingest path: any joined event member may submit reports.
// Authorship is advisory; an HMAC provides authenticity.
//
// HMAC canonicalization:
//   The client computes: HMAC-SHA256(QR_INGEST_HMAC_SECRET, JSON.stringify(reports))
//   This function re-stringifies the parsed `reports` array the same way:
//     hmacHex(HMAC_SECRET, JSON.stringify(parsedBody.reports))
//   Both sides must hash the exact same UTF-8 bytes — re-stringify after parse
//   ensures key ordering/whitespace is normalised identically on both sides.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Supabase auto-injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
// QR_INGEST_HMAC_SECRET is set as a function secret.
const HMAC_SECRET = Deno.env.get("QR_INGEST_HMAC_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

interface IngestPayload {
  reports: Record<string, unknown>[];
  hmac: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time string comparison (lengths must match first).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(sig));
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  if (!HMAC_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "server not configured" }, 500);
  }

  let payload: IngestPayload;
  try {
    payload = (await req.json()) as IngestPayload;
  } catch (_err) {
    return json({ error: "invalid JSON" }, 400);
  }

  if (
    !payload ||
    !Array.isArray(payload.reports) ||
    typeof payload.hmac !== "string"
  ) {
    return json({ error: "expected { reports: [], hmac: string }" }, 400);
  }

  // Verify HMAC — re-stringify the parsed array so both sides hash identical bytes.
  // See canonicalization comment at top of file.
  const expected = await hmacHex(HMAC_SECRET, JSON.stringify(payload.reports));
  if (!timingSafeEqual(expected, payload.hmac)) {
    return json({ error: "invalid hmac" }, 401);
  }

  // 401 path is above — no upserts performed on bad HMAC.
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let ingested = 0;
  for (const report of payload.reports) {
    const { error } = await supabase.rpc("upsert_match_report", { p: report });
    if (error) {
      return json({ error: error.message, ingested }, 400);
    }
    ingested++;
  }

  return json({ ingested }, 200);
});
