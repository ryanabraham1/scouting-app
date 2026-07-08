// supabase/functions/import-event/index.ts
// Open (login-less) TBA import, matching the rest of the app's open posture: any
// caller may import a public TBA event. Fetches TBA event/teams/matches, filters
// to comp_level==='qm', and upserts event/team/event_team/match using a
// service-role client. Ensures the event has an 8-char join_code. Idempotent
// (all writes are upserts). It only ingests public TBA data into our own DB.
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";
const TBA_API_KEY = Deno.env.get("TBA_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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

function randomJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
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
      });
    } catch (e) {
      lastErr = `network: ${(e as Error).message}`;
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    lastErr = `${res.status} ${await res.text()}`;
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
  let body: { event_key?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const eventKey = body.event_key;
  if (!eventKey || typeof eventKey !== "string") {
    return json({ error: "missing event_key" }, 400);
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

  // (3) Filter matches to qualification only.
  const qmMatches = matches.filter((m) => m.comp_level === "qm");

  // (4) Service-role writes.
  const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: evErr } = await svc.from("event").upsert({
    event_key: eventKey,
    name: ev.name,
    start_date: ev.start_date,
    end_date: ev.end_date,
    timezone: ev.timezone,
    city: ev.city,
    state_prov: ev.state_prov,
    is_active: true,
    imported_at: new Date().toISOString(),
  });
  if (evErr) return json({ error: `event upsert: ${evErr.message}` }, 500);

  // Single-team app: exactly one active event. Deactivate any other event so
  // the admin dashboard never silently switches between multiple active events.
  const { error: deactErr } = await svc
    .from("event")
    .update({ is_active: false })
    .neq("event_key", eventKey);
  if (deactErr) return json({ error: `deactivate others: ${deactErr.message}` }, 500);

  if (teams.length > 0) {
    const { error: teamErr } = await svc.from("team").upsert(
      teams.map((t) => ({
        team_number: t.team_number,
        nickname: t.nickname,
        city: t.city,
        state_prov: t.state_prov,
        rookie_year: t.rookie_year,
      })),
    );
    if (teamErr) return json({ error: `team upsert: ${teamErr.message}` }, 500);

    const { error: etErr } = await svc.from("event_team").upsert(
      teams.map((t) => ({ event_key: eventKey, team_number: t.team_number })),
    );
    if (etErr) return json({ error: `event_team upsert: ${etErr.message}` }, 500);
  }

  if (qmMatches.length > 0) {
    const { error: mErr } = await svc.from("match").upsert(
      qmMatches.map((m) => ({
        match_key: m.key,
        event_key: eventKey,
        comp_level: "qm",
        match_number: m.match_number,
        scheduled_time: m.time ? new Date(m.time * 1000).toISOString() : null,
        red1: teamNum(m.alliances.red.team_keys[0]),
        red2: teamNum(m.alliances.red.team_keys[1]),
        red3: teamNum(m.alliances.red.team_keys[2]),
        blue1: teamNum(m.alliances.blue.team_keys[0]),
        blue2: teamNum(m.alliances.blue.team_keys[1]),
        blue3: teamNum(m.alliances.blue.team_keys[2]),
      })),
    );
    if (mErr) return json({ error: `match upsert: ${mErr.message}` }, 500);
  }

  // (5) Ensure event_secret has a join_code.
  const { data: secret } = await svc
    .from("event_secret")
    .select("join_code")
    .eq("event_key", eventKey)
    .maybeSingle();
  let joinCode = secret?.join_code ?? "";
  if (!joinCode) {
    joinCode = randomJoinCode();
    const { error: secErr } = await svc
      .from("event_secret")
      .upsert({ event_key: eventKey, join_code: joinCode });
    if (secErr) return json({ error: `event_secret upsert: ${secErr.message}` }, 500);
  }

  // (6) Summary.
  return json(
    {
      event_key: eventKey,
      name: ev.name,
      team_count: teams.length,
      match_count: qmMatches.length,
      join_code: joinCode,
    },
    200,
  );
}
