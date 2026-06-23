// tests/functions/import-event.test.ts
// Integration test against the DEPLOYED import-event edge function.
// Signs in the seeded test admin (email/password) to obtain a JWT, POSTs
// { event_key: '2026casnv' }, and asserts the import summary + that the DB
// contains 37 teams and ZERO non-qm matches. Also asserts an anon caller → 403.
// Leaves 2026casnv imported (it is the real Phase-1 test event).
import { describe, it, expect, beforeAll } from "vitest";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL as string;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY as string;
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL as string;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD as string;
const BASE = `${SUPABASE_URL}/functions/v1/import-event`;
const EVENT_KEY = "2026casnv";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let adminJwt = "";

beforeAll(async () => {
  const authed = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authed.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(`admin sign-in failed: ${error?.message ?? "no session"}`);
  }
  adminJwt = data.session.access_token;
});

describe("import-event (deployed)", () => {
  it("imports 2026casnv as admin → 200 with 37 teams and only qm matches", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON,
        Authorization: `Bearer ${adminJwt}`,
      },
      body: JSON.stringify({ event_key: EVENT_KEY }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event_key).toBe(EVENT_KEY);
    expect(body.team_count).toBe(37);
    expect(body.match_count).toBeGreaterThan(0);
    expect(typeof body.join_code).toBe("string");
    expect(body.join_code.length).toBe(8);

    // No non-qm matches were persisted for this event.
    const { count, error } = await admin
      .from("match")
      .select("match_key", { count: "exact", head: true })
      .eq("event_key", EVENT_KEY)
      .neq("comp_level", "qm");
    expect(error).toBeNull();
    expect(count).toBe(0);

    // The persisted qm count matches the reported summary.
    const { count: qmCount } = await admin
      .from("match")
      .select("match_key", { count: "exact", head: true })
      .eq("event_key", EVENT_KEY)
      .eq("comp_level", "qm");
    expect(qmCount).toBe(body.match_count);
  }, 60000);

  it("rejects an anonymous caller with 403", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON,
        Authorization: `Bearer ${ANON}`,
      },
      body: JSON.stringify({ event_key: EVENT_KEY }),
    });
    expect(res.status).toBe(403);
  }, 30000);
});
