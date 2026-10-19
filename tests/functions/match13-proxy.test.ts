// tests/functions/match13-proxy.test.ts
import { describe, it, expect } from "vitest";
import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = `${process.env.VITE_SUPABASE_URL}/functions/v1/match13-proxy`;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const headers = { Authorization: `Bearer ${ANON}`, apikey: ANON };

describe("match13-proxy (deployed)", () => {
  it("serves a season table (or degrades gracefully if match13 is down)", async () => {
    const res = await fetch(`${BASE}?year=2026`, { headers });
    // The function MUST never return a 5xx to the client.
    expect(res.status).toBe(200);
    const body = await res.json();
    if (body.available === false) return;
    expect(body.year).toBe(2026);
    expect(body.columns[0]).toBe("team");
    expect(body.teams.length).toBeGreaterThan(1000);
  }, 30000);

  it("rejects a malformed year with a 400", async () => {
    const res = await fetch(`${BASE}?year=abc`, { headers });
    expect(res.status).toBe(400);
  }, 30000);
});
