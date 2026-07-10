// supabase/functions/import-event/index.ts
// Open (login-less) TBA import, matching the rest of the app's open posture: any
// caller may import a public TBA event. Fetches TBA event/teams/matches, filters
// to comp_level==='qm', and upserts event/team/event_team/match using a
// service-role client. Ensures the event has an 8-char join_code. Idempotent
// (all writes are upserts). It only ingests public TBA data into our own DB.
import { corsHeaders } from "../_shared/cors.ts";
import {
  BodyTooLargeError,
  readJsonBody,
  readTextResponse,
} from "../_shared/readJsonBody.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";
const TBA_API_KEY = Deno.env.get("TBA_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAX_REQUEST_BYTES = 4096;
const MAX_TBA_RESPONSE_BYTES = 4 * 1024 * 1024;

interface TbaEvent {
  name: string;
  start_date: string | null;
  end_date: string | null;
  timezone: string | null;
  city: string | null;
  state_prov: string | null;
}
interface TbaTeam {
  team_number: number;
  nickname: string | null;
  city: string | null;
  state_prov: string | null;
  rookie_year: number | null;
}
interface TbaMatch {
  key: string;
  comp_level: string;
  match_number: number;
  time: number | null;
  alliances: {
    red: { team_keys: string[] };
    blue: { team_keys: string[] };
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Parse 'frcNNNN' → NNNN (int). Missing/short alliances tolerated as null.
function teamNum(teamKey: string | undefined): number | null {
  if (!teamKey) return null;
  const n = parseInt(teamKey.replace("frc", ""), 10);
  return Number.isFinite(n) ? n : null;
}

// GET with retry: TBA throws transient 429/5xx blips (observed live: two 502s a
// few minutes apart on an otherwise-fine event) — one blip must not fail the
// whole import. 4xx other than 429 is a real answer (bad key/unknown event):
// surface it immediately, don't retry.
async function tba<T>(path: string): Promise<T> {
  const attempts = 3;
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 300 * 2 ** (i - 1)));
    let res: Response;
    try {
      res = await fetch(`${TBA_BASE}${path}`, {
        headers: { "X-TBA-Auth-Key": TBA_API_KEY, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      lastErr = `network: ${(e as Error).message}`;
      continue;
    }
    const text = await readTextResponse(res, MAX_TBA_RESPONSE_BYTES);
    if (res.ok) return JSON.parse(text) as T;
    lastErr = `${res.status} ${text.slice(0, 2048)}`;
    if (res.status < 500 && res.status !== 429) break;
  }
  throw new Error(`TBA ${path} failed: ${lastErr}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  if (!TBA_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "function not configured" }, 500);
  }

  // Open posture: no admin gate. Anyone may import a public TBA event into our DB.
  let body: { event_key?: string } | null;
  try {
    body = await readJsonBody(req, MAX_REQUEST_BYTES) as {
      event_key?: string;
    };
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json({ error: error.message }, 413);
    }
    return json({ error: "invalid JSON body" }, 400);
  }
  const eventKey = body?.event_key;
  if (
    !eventKey ||
    typeof eventKey !== "string" ||
    eventKey.length > 64 ||
    !/^[0-9]{4}[a-z0-9]+$/.test(eventKey)
  ) {
    return json({ error: "invalid event_key" }, 400);
  }

  return await runImport(eventKey);
});

async function runImport(eventKey: string): Promise<Response> {
  // (2) Fetch TBA event/teams/matches.
  let ev: TbaEvent;
  let teams: TbaTeam[];
  let matches: TbaMatch[];
  try {
    [ev, teams, matches] = await Promise.all([
      tba<TbaEvent>(`/event/${eventKey}`),
      tba<TbaTeam[]>(`/event/${eventKey}/teams`),
      tba<TbaMatch[]>(`/event/${eventKey}/matches`),
    ]);
  } catch (e) {
    return json({ error: `TBA fetch failed: ${(e as Error).message}` }, 502);
  }

  if (!Array.isArray(teams) || !Array.isArray(matches)) {
    return json({ error: "TBA returned malformed teams or matches" }, 502);
  }
  if (teams.length === 0 || teams.length > 1000 || matches.length > 1000) {
    return json({ error: "TBA event exceeds supported size" }, 422);
  }

  // (3) Filter matches to qualification only.
  const qmMatches = matches.filter((m) => m.comp_level === "qm");
  if (qmMatches.length > 500) {
    return json({ error: "qualification schedule exceeds supported size" }, 422);
  }

  // (4) Service-role writes.
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Promote the complete roster/schedule and activate it in one database
  // transaction. The intentionally open HTTP endpoint remains open, but callers
  // can no longer expose a partially imported active event.
  const { data, error } = await svc.rpc("promote_event_import", {
    p_event: {
      event_key: eventKey,
      name: ev.name,
      start_date: ev.start_date,
      end_date: ev.end_date,
      timezone: ev.timezone,
      city: ev.city,
      state_prov: ev.state_prov,
    },
    p_teams: teams.map((t) => ({
      team_number: t.team_number,
      nickname: t.nickname,
      city: t.city,
      state_prov: t.state_prov,
      rookie_year: t.rookie_year,
    })),
    p_matches: qmMatches.map((m) => ({
      match_key: m.key,
      match_number: m.match_number,
      scheduled_time: m.time ? new Date(m.time * 1000).toISOString() : null,
      red1: teamNum(m.alliances.red.team_keys[0]),
      red2: teamNum(m.alliances.red.team_keys[1]),
      red3: teamNum(m.alliances.red.team_keys[2]),
      blue1: teamNum(m.alliances.blue.team_keys[0]),
      blue2: teamNum(m.alliances.blue.team_keys[1]),
      blue3: teamNum(m.alliances.blue.team_keys[2]),
    })),
    p_activate: true,
  });
  if (error) {
    return json({ error: `event promotion: ${error.message}` }, 500);
  }
  // The current setup UI has no separate join-code retrieval path, so omitting
  // this would break the selected login-less join workflow.
  const secret = await svc
    .from("event_secret")
    .select("join_code")
    .eq("event_key", eventKey)
    .single();
  if (secret.error) {
    return json({ error: `join code lookup: ${secret.error.message}` }, 500);
  }
  return json(
    {
      ...(data as Record<string, unknown>),
      name: ev.name,
      join_code: secret.data.join_code,
    },
    200,
  );
}
