// supabase/functions/youtube-proxy/index.ts
// When did a YouTube livestream actually start? Feeds the dashboard's
// livestream match-jump (webcast_sync): a match sits at
// `match.actual_time - stream start` seconds in the stream/VOD, so knowing the
// start makes every match on that day seekable with no manual calibration.
//
// GET ?video=<id>  ->  { available: true, videoId, actualStartTime, actualEndTime }
//                      (times are ISO strings or null — null start = not live yet)
//                  ->  { available: false } on any upstream problem (never throws)
//
// Source order:
//   1. YouTube Data API v3 videos.list(liveStreamingDetails) when YOUTUBE_API_KEY
//      is set (1 quota unit per call; free tier is 10k/day).
//   2. Fallback: the watch page's embedded player JSON carries the same
//      `startTimestamp`. Brittle (markup/consent walls) but needs no key.
// Results are cached in-instance; a stream that hasn't started yet is cached
// briefly so a dashboard polling before the day begins doesn't burn quota.

import { corsHeaders } from "../_shared/cors.ts";
import { readTextResponse } from "../_shared/readJsonBody.ts";

const API_KEY = Deno.env.get("YOUTUBE_API_KEY") ?? "";
const DATA_API = "https://www.googleapis.com/youtube/v3/videos";
const CACHE_TTL_MS = 6 * 60 * 60_000; // a started stream's start never changes
const PENDING_TTL_MS = 60_000; // not started yet: re-check soon
const MAX_CACHE_ENTRIES = 256;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // watch pages are big
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

interface StreamStart {
  available: true;
  videoId: string;
  actualStartTime: string | null;
  actualEndTime: string | null;
  source: "data-api" | "watch-page";
}

interface CacheEntry {
  expires: number;
  body: StreamStart;
}
const cache = new Map<string, CacheEntry>();

function remember(videoId: string, body: StreamStart): void {
  cache.delete(videoId);
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  const ttl = body.actualStartTime ? CACHE_TTL_MS : PENDING_TTL_MS;
  cache.set(videoId, { expires: Date.now() + ttl, body });
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function fromDataApi(videoId: string): Promise<StreamStart | null> {
  if (!API_KEY) return null;
  const url = `${DATA_API}?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${
    encodeURIComponent(API_KEY)
  }`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.warn("[youtube-proxy] data api", res.status);
    return null;
  }
  const data = JSON.parse(await readTextResponse(res, MAX_RESPONSE_BYTES)) as {
    items?: Array<{ liveStreamingDetails?: Record<string, unknown> }>;
  };
  const item = data.items?.[0];
  if (!item) return null; // unknown / private video
  const d = item.liveStreamingDetails ?? {};
  return {
    available: true,
    videoId,
    actualStartTime: isoOrNull(d.actualStartTime),
    actualEndTime: isoOrNull(d.actualEndTime),
    source: "data-api",
  };
}

async function fromWatchPage(videoId: string): Promise<StreamStart | null> {
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
    headers: {
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      // Consent-wall bypass used by most scrapers; harmless if ignored.
      Cookie: "CONSENT=YES+1; SOCS=CAI",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const html = await readTextResponse(res, MAX_RESPONSE_BYTES);
  // liveBroadcastDetails: { isLiveNow, startTimestamp, endTimestamp? }
  const start = html.match(/"startTimestamp":"([^"]+)"/)?.[1];
  const end = html.match(/"endTimestamp":"([^"]+)"/)?.[1];
  if (!start && !/"liveBroadcastDetails"/.test(html)) return null; // not a stream / blocked
  return {
    available: true,
    videoId,
    actualStartTime: isoOrNull(start),
    actualEndTime: isoOrNull(end),
    source: "watch-page",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const videoId = new URL(req.url).searchParams.get("video") ?? "";
  if (!VIDEO_ID_RE.test(videoId)) {
    return json({ error: "missing or invalid 'video' query param" }, 400);
  }

  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return json(cached.body, 200, { "X-Cache": "HIT" });

  let result: StreamStart | null = null;
  try {
    result = await fromDataApi(videoId);
  } catch (err) {
    console.warn("[youtube-proxy] data api failed", (err as Error)?.message);
  }
  if (!result) {
    try {
      result = await fromWatchPage(videoId);
    } catch (err) {
      console.warn("[youtube-proxy] watch page failed", (err as Error)?.message);
    }
  }
  if (!result) return json({ available: false });

  remember(videoId, result);
  return json(result, 200, { "X-Cache": "MISS" });
});
