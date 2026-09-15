// supabase/functions/discord-post/index.ts
// Relays a Strategy-tab "Post to Discord" to the team's Discord channel webhook.
// The webhook URL is a server-only secret (DISCORD_WEBHOOK_URL) — anyone holding
// it can post as the bot, so it must never ship in VITE_* env. The client
// builds the message (embed + rendered whiteboard PNG) because every number in
// it comes from the dashboard's own prediction/aggregate math; this function
// only bounds and forwards it.
//
// Request: multipart/form-data with `payload_json` (Discord webhook JSON) and
// up to MAX_FILES `files[N]` PNG attachments — the same shape Discord accepts,
// so the relay is a pass-through. Gateway verify_jwt stays ON (default): the
// app's silent anonymous session satisfies it, matching sync-event-results.
//
// Like the read proxies, an unconfigured secret degrades to
// `{ available: false }` (200) rather than throwing so the UI can explain.
import { corsHeaders } from "../_shared/cors.ts";

const WEBHOOK_URL = Deno.env.get("DISCORD_WEBHOOK_URL") ?? "";
const MAX_FILES = 5;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // Discord's per-attachment cap (free tier)
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = MAX_FILES * MAX_FILE_BYTES + MAX_PAYLOAD_BYTES;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isDiscordWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (u.hostname === "discord.com" || u.hostname === "discordapp.com") &&
      u.pathname.startsWith("/api/webhooks/")
    );
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  if (!WEBHOOK_URL || !isDiscordWebhookUrl(WEBHOOK_URL)) {
    console.warn("[discord-post] DISCORD_WEBHOOK_URL unset or malformed");
    return json({ ok: false, available: false, error: "Discord webhook not configured" }, 200);
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return json({ error: "request too large" }, 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "expected multipart/form-data" }, 400);
  }

  const payloadRaw = form.get("payload_json");
  if (typeof payloadRaw !== "string" || payloadRaw.length === 0) {
    return json({ error: "missing payload_json" }, 400);
  }
  if (payloadRaw.length > MAX_PAYLOAD_BYTES) {
    return json({ error: "payload_json too large" }, 413);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    return json({ error: "payload_json is not JSON" }, 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ error: "payload_json must be an object" }, 400);
  }

  // Re-pack only what Discord needs: the JSON part plus PNG attachments under
  // the `files[N]` names it expects. Anything else in the form is dropped.
  const out = new FormData();
  out.append("payload_json", JSON.stringify(payload));
  let fileCount = 0;
  for (const [name, value] of form.entries()) {
    if (!/^files\[\d+\]$/.test(name) || !(value instanceof File)) continue;
    if (fileCount >= MAX_FILES) return json({ error: `more than ${MAX_FILES} files` }, 400);
    if (value.type !== "image/png") return json({ error: "attachments must be PNG" }, 400);
    if (value.size > MAX_FILE_BYTES) return json({ error: "attachment too large" }, 413);
    out.append(`files[${fileCount}]`, value, value.name || `board-${fileCount}.png`);
    fileCount += 1;
  }

  try {
    const res = await fetch(`${WEBHOOK_URL}?wait=true`, { method: "POST", body: out });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[discord-post] discord ${res.status}: ${text.slice(0, 300)}`);
      // 429 from Discord is a rate limit; pass the status through so the UI can
      // say "try again in a moment" rather than a generic failure.
      return json({ ok: false, error: `Discord rejected the post (${res.status})` }, res.status === 429 ? 429 : 502);
    }
    console.log(`[discord-post] posted (${fileCount} file${fileCount === 1 ? "" : "s"})`);
    return json({ ok: true, available: true }, 200);
  } catch (e) {
    console.error("[discord-post] fetch failed", (e as Error).message);
    return json({ ok: false, error: "could not reach Discord" }, 502);
  }
});
