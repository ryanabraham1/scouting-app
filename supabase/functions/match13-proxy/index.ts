// supabase/functions/match13-proxy/index.ts
//
// Read proxy for the match13 API (https://www.match13.com/docs/api). It holds
// the key (MATCH13_API_KEY secret, never shipped to the browser) and serves the
// app ONE compact table per season: every team's xP rating, world rank and
// auto/teleop/endgame split.
//
// match13's allowance is shared by every device using the app (60 req/min,
// 1000/hr), so the proxy never fans out per team: it pulls the whole season in
// a few bulk pages (/v1/years/{year}/teams, 1000 rows a page), caches it, and
// coalesces concurrent misses into one upstream pull.
//
// Degrades like the other proxies: any failure answers { available: false }
// (or the last good table) with a 200, never a 5xx.
import { corsHeaders } from "../_shared/cors.ts";
import { readJsonResponse } from "../_shared/readJsonBody.ts";

const M13_BASE = "https://actions.match13.com/v1";
const PAGE_LIMIT = 1000;
/** Safety cap on pages per season pull (a season is ~4 pages). */
const MAX_PAGES = 10;
/** match13 itself caches a live season for 60 s; a few minutes is plenty here. */
const CACHE_TTL_MS = 5 * 60_000;
/** A good table older than its TTL is still served while the upstream fails. */
const STALE_MAX_MS = 24 * 60 * 60_000;
const UPSTREAM_TIMEOUT_MS = 5_000;
/** After an upstream failure, answer from cache/sentinel for this long. */
const BREAKER_OPEN_MS = 60_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** Column order of each row in `teams`. */
const COLUMNS = ["team", "xp", "rank", "auto", "teleop", "endgame"] as const;
type Row = [number, number | null, number | null, number | null, number | null, number | null];

interface Season {
  expires: number;
  body: string;
}
const cache = new Map<number, Season>();
const inFlight = new Map<number, Promise<string>>();
let upstreamDownUntil = 0;

function json(body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

function unavailable(): Response {
  return json(JSON.stringify({ available: false }));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function fetchPage(key: string, year: number, page: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${M13_BASE}/years/${year}/teams?limit=${PAGE_LIMIT}&page=${page}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`match13 ${res.status}`);
  const body = await readJsonResponse(res, MAX_PAGE_BYTES);
  if (typeof body !== "object" || body === null) throw new Error("match13 bad body");
  return body as Record<string, unknown>;
}

function rowsOf(page: Record<string, unknown>): Row[] {
  const teams = Array.isArray(page.teams) ? page.teams : [];
  const rows: Row[] = [];
  for (const t of teams) {
    if (typeof t !== "object" || t === null) continue;
    const r = t as Record<string, unknown>;
    const team = num(r.teamNumber);
    if (team == null) continue;
    rows.push([team, num(r.xp), num(r.rank), num(r.xAuto), num(r.xTele), num(r.xEnd)]);
  }
  return rows;
}

/** Pull a whole season: page 1, then the remaining pages in parallel. */
async function pullSeason(key: string, year: number): Promise<string> {
  const first = await fetchPage(key, year, 1);
  const total = num(first.total) ?? 0;
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / PAGE_LIMIT)));
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => fetchPage(key, year, i + 2)),
  );
  const teams = [first, ...rest].flatMap(rowsOf);
  return JSON.stringify({ year, columns: COLUMNS, teams });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const raw = new URL(req.url).searchParams.get("year") ?? "";
  const year = /^\d{4}$/.test(raw) ? Number(raw) : NaN;
  if (!(year >= 1992 && year <= 2100)) {
    return new Response(JSON.stringify({ error: "missing or invalid 'year' query param" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const now = Date.now();
  const cached = cache.get(year);
  if (cached && cached.expires > now) return json(cached.body, { "X-Cache": "HIT" });
  const stale = cached && cached.expires + STALE_MAX_MS > now ? cached : null;
  const degrade = (): Response => stale ? json(stale.body, { "X-Cache": "STALE" }) : unavailable();
  if (now < upstreamDownUntil) return degrade();

  const key = Deno.env.get("MATCH13_API_KEY");
  if (!key) return degrade();

  let pull = inFlight.get(year);
  if (!pull) {
    pull = pullSeason(key, year).finally(() => inFlight.delete(year));
    inFlight.set(year, pull);
  }
  try {
    const body = await pull;
    upstreamDownUntil = 0;
    cache.set(year, { expires: Date.now() + CACHE_TTL_MS, body });
    return json(body, { "X-Cache": "MISS" });
  } catch {
    upstreamDownUntil = Date.now() + BREAKER_OPEN_MS;
    return degrade();
  }
});
