// tests/functions/import-event.test.ts
// Integration test against the DEPLOYED import-event edge function.
// The import is OPEN (login-less), matching the rest of the app: an anonymous
// caller can import a public TBA event. POSTs { event_key: '2026casnv' } and
// asserts the import summary + that the persisted qm count matches it.
// NOTE: import-event itself imports ONLY qm (it filters comp_level==='qm'), but
// the live results reconcile (sync-event-results) legitimately backfills playoff
// rows for the same event now that the app tracks playoffs — so we no longer
// assert the table is globally qm-only; we assert import-event's qm summary.
// Leaves 2026casnv imported (it is the real Phase-1 test event).
import { describe, it, expect } from "vitest";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL as string;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY as string;
const BASE = `${SUPABASE_URL}/functions/v1/import-event`;
const EVENT_KEY = "2026casnv";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

describe("import-event (deployed)", () => {
  it("imports 2026casnv with no admin (open) → 200 with 37 teams; summary counts only qm", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON,
        Authorization: `Bearer ${ANON}`, // anon caller — no admin
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

    // import-event imports only the qm schedule: its reported match_count must
    // equal the persisted qm rows. (Playoff rows may also exist for this event,
    // written by the live results reconcile — not import-event's concern.)
    const { count: qmCount, error } = await admin
      .from("match")
      .select("match_key", { count: "exact", head: true })
      .eq("event_key", EVENT_KEY)
      .eq("comp_level", "qm");
    expect(error).toBeNull();
    expect(qmCount).toBe(body.match_count);
  }, 60000);

  it("still validates the body (missing event_key → 400)", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON,
        Authorization: `Bearer ${ANON}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  }, 30000);
});
