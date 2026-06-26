// supabase/functions/sync-event-results/index.ts
// Pull-based RECONCILE of TBA match results into our `match` table. The
// tba-webhook lands results in real time, but TBA webhooks can be dropped or
// delayed; the dashboard calls this periodically (and once on load to backfill)
// so a missed webhook self-heals and previously-played matches are never stuck
// "unplayed". Writes with the service role (clients can't UPDATE `match`).
//
// Idempotent: re-running upserts the same rows. Returns a small summary.
// Deployed with verify_jwt = false (it only pulls public TBA data and writes
// authentic results keyed by the globally-unique TBA match_key; event_key is
// format-validated). This also means a cold-load reconcile works before the
// anon session is established. Matches the app's open posture (import-event etc).
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";
const TBA_API_KEY = Deno.env.get("TBA_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED_LEVELS = new Set(["qm", "ef", "qf", "sf", "f"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function teamNum(teamKey: string | undefined | null): number | null {
  if (!teamKey) return null;
  const n = parseInt(String(teamKey).replace("frc", ""), 10);
  return Number.isFinite(n) ? n : null;
}

interface TbaAlliance { score?: number | null; team_keys?: string[] }
interface TbaMatch {
  key: string;
  event_key?: string;
  comp_level: string;
  match_number: number;
  time?: number | null;
  winning_alliance?: string | null;
  alliances?: { red?: TbaAlliance; blue?: TbaAlliance };
}

function winnerOf(m: TbaMatch, red: number | null, blue: number | null): string | null {
  const wa = (m.winning_alliance ?? "").toLowerCase();
  if (wa === "red" || wa === "blue") return wa;
  if (red == null || blue == null) return null;
  if (red > blue) return "red";
  if (blue > red) return "blue";
  return "tie";
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
    });
    if (!res.ok) return json({ available: false, status: res.status });
    matches = (await res.json()) as TbaMatch[];
  } catch {
    return json({ available: false, error: "tba unreachable" });
  }
  if (!Array.isArray(matches)) return json({ available: false });

  const rows = matches
    .filter((m) => m?.key && ALLOWED_LEVELS.has((m.comp_level ?? "").toLowerCase()))
    .map((m) => {
      const red = m.alliances?.red ?? {};
      const blue = m.alliances?.blue ?? {};
      const redScore = typeof red.score === "number" && red.score >= 0 ? red.score : null;
      const blueScore = typeof blue.score === "number" && blue.score >= 0 ? blue.score : null;
      const played = redScore != null && blueScore != null;
      const row: Record<string, unknown> = {
        match_key: m.key,
        event_key: eventKey,
        comp_level: m.comp_level.toLowerCase(),
        match_number: m.match_number ?? null,
        red1: teamNum(red.team_keys?.[0]),
        red2: teamNum(red.team_keys?.[1]),
        red3: teamNum(red.team_keys?.[2]),
        blue1: teamNum(blue.team_keys?.[0]),
        blue2: teamNum(blue.team_keys?.[1]),
        blue3: teamNum(blue.team_keys?.[2]),
        // Results: null when unplayed (keeps the row in the "unplayed" set).
        actual_red_score: redScore,
        actual_blue_score: blueScore,
        winner: played ? winnerOf(m, redScore, blueScore) : null,
        result_synced_at: played ? new Date().toISOString() : null,
      };
      if (m.time) row.scheduled_time = new Date(m.time * 1000).toISOString();
      return { row, played };
    });

  const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Only write rows that actually changed, so a 60s reconcile doesn't rewrite the
  // whole schedule every minute (which would bump result_synced_at and fire a
  // realtime event for every match). Write a row when: it's a new match_key
  // (adds a missing playoff schedule row) OR a played result differs from stored.
  const { data: existing } = await svc
    .from("match")
    .select("match_key, actual_red_score, actual_blue_score, winner")
    .eq("event_key", eventKey);
  const prev = new Map(
    (existing ?? []).map((r) => [
      r.match_key as string,
      {
        ars: r.actual_red_score as number | null,
        abs: r.actual_blue_score as number | null,
        winner: r.winner as string | null,
      },
    ]),
  );
  const toWrite = rows
    .filter(({ row, played }) => {
      const p = prev.get(row.match_key as string);
      if (!p) return true; // new match (e.g. a playoff match not yet imported)
      if (!played) return false; // existing + still unplayed -> nothing to sync
      // Rewrite on any result change — including a winner flip (DQ / tiebreaker)
      // where the two scores stay numerically equal.
      return (
        p.ars !== row.actual_red_score ||
        p.abs !== row.actual_blue_score ||
        p.winner !== row.winner
      );
    })
    .map((r) => r.row);

  if (toWrite.length > 0) {
    const { error } = await svc.from("match").upsert(toWrite, { onConflict: "match_key" });
    if (error) {
      // Degrade to a sentinel (200) instead of 500 — e.g. an FK error for an
      // un-imported event must not crash the dashboard's periodic reconcile.
      console.error("[sync-event-results] upsert failed", error.message);
      return json({ available: false, error: error.message });
    }
  }

  return json({
    event_key: eventKey,
    total: rows.length,
    played: rows.filter((r) => r.played).length,
    written: toWrite.length,
  });
});
