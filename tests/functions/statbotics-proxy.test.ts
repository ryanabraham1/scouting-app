// tests/functions/statbotics-proxy.test.ts
import { describe, it, expect } from "vitest";
import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = `${process.env.VITE_SUPABASE_URL}/functions/v1/statbotics-proxy`;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

describe("statbotics-proxy (deployed)", () => {
  it("proxies a real team request (or degrades gracefully if upstream is down)", async () => {
    const res = await fetch(`${BASE}?path=/team/254`, {
      headers: { Authorization: `Bearer ${ANON}`, apikey: ANON },
    });
    // The function MUST never return a 5xx to the client.
    expect(res.status).toBe(200);
    const body = await res.json();
    // Either upstream is up (real data) or it is down (graceful degrade).
    if (body.available === false) {
      // Upstream is currently returning 5xx — degrade contract holds.
      expect(body.available).toBe(false);
    } else {
      // Upstream is up — real data passthrough.
      expect(body.team).toBe(254);
    }
  }, 30000);

  it("degrades gracefully to {available:false} on upstream 5xx", async () => {
    // _forceUpstreamStatus is a test-only hook that makes the function
    // treat the upstream response as the given status.
    const res = await fetch(`${BASE}?path=/team/254&_forceUpstreamStatus=503`, {
      headers: { Authorization: `Bearer ${ANON}`, apikey: ANON },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
  }, 30000);
});
