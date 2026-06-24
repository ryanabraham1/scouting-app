// tests/functions/ingest-reports.test.ts
// LIVE integration test against the DEPLOYED ingest-reports edge function
// (JWT event-member auth — the HMAC model is GONE; contracts §5).
//
// Setup (mirrors tba-proxy.test.ts for dotenv/supabase-js/skip-when-missing):
//   - Service-role admin client seeds two events (one the member joins, one
//     foreign), each with an event_secret join_code, plus a team + match.
//   - A member scout is created by anon sign-in + join_event; its session
//     access_token is the JWT the function gates on. get_my_event_keys() for
//     that JWT returns ONLY the joined event.
//
// Cases (Task S Step 1):
//   - no Authorization header                          → 401
//   - member JWT + report in their event               → 200 { ingested: 1, failed: [] } + row exists
//   - re-POST the SAME report                          → 200 { ingested: 1, failed: [] } + NO duplicate
//   - member JWT but report.event_key is a foreign event → 403, nothing written
//
// This test FAILS until the controller redeploys the rewritten function.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL as string;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SECRET_KEY as string;
const BASE = `${SUPABASE_URL}/functions/v1/ingest-reports`;

// Gate the whole suite on env (mirrors tba-proxy: skip locally when unset).
const HAS_ENV = Boolean(SUPABASE_URL && ANON && SERVICE_ROLE_KEY);
const d = HAS_ENV ? describe : describe.skip;

// The member's own event.
const EVENT_KEY = "2099test_ingest_jwt";
const EVENT_CODE = "INGSTJWT";
const MATCH_KEY = "2099test_ingest_jwt_qm1";
const TEAM_NUMBER = 99992;
// A separate event the member never joins (the 403-foreign case).
const FOREIGN_EVENT_KEY = "2099test_ingest_foreign";
const FOREIGN_CODE = "INGFRGN1";
const FOREIGN_MATCH_KEY = "2099test_ingest_foreign_qm1";

const REPORT_ID = "00000000-d4d4-d4d4-d4d4-000000000099";
const FOREIGN_REPORT_ID = "00000000-d4d4-d4d4-d4d4-0000000000fe";

// Admin client for seeding / assertions / cleanup (service role).
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let memberJwt = "";
let memberScoutId = "";

async function seed() {
  // Member's own event + its join code, plus a team and a match.
  await admin.from("event").upsert({
    event_key: EVENT_KEY,
    name: "Ingest JWT Test Event",
    is_active: true,
  });
  await admin.from("event_secret").upsert({
    event_key: EVENT_KEY,
    join_code: EVENT_CODE,
  });
  await admin.from("team").upsert({
    team_number: TEAM_NUMBER,
    nickname: "Ingest JWT Team",
  });
  await admin.from("match").upsert({
    match_key: MATCH_KEY,
    event_key: EVENT_KEY,
    comp_level: "qm",
    match_number: 1,
  });

  // Foreign event (member never joins it) + a match so a forged event_key is
  // FK-valid and the 403 is proven to come from the membership gate, not an FK.
  await admin.from("event").upsert({
    event_key: FOREIGN_EVENT_KEY,
    name: "Ingest Foreign Event",
    is_active: false,
  });
  await admin.from("event_secret").upsert({
    event_key: FOREIGN_EVENT_KEY,
    join_code: FOREIGN_CODE,
  });
  await admin.from("match").upsert({
    match_key: FOREIGN_MATCH_KEY,
    event_key: FOREIGN_EVENT_KEY,
    comp_level: "qm",
    match_number: 1,
  });

  // Create the member: anon sign-in + join_event. Its access_token is the JWT
  // the function gates on; the returned scout id is a valid scout_id for it.
  const memberClient = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signin, error: sErr } = await memberClient.auth
    .signInAnonymously();
  if (sErr || !signin?.session) {
    throw new Error(`anon sign-in failed: ${sErr?.message ?? "no session"}`);
  }
  memberJwt = signin.session.access_token;

  const { data: scout, error: jErr } = await memberClient.rpc("join_event", {
    p_code: EVENT_CODE,
    p_display_name: "Ingest JWT Scout",
  });
  if (jErr || !scout) {
    throw new Error(`join_event failed: ${jErr?.message ?? "no scout"}`);
  }
  memberScoutId = scout.id as string;
}

async function cleanup() {
  // FK-safe order across BOTH events.
  await admin
    .from("match_scouting_report")
    .delete()
    .in("event_key", [EVENT_KEY, FOREIGN_EVENT_KEY]);
  await admin
    .from("scout")
    .delete()
    .in("event_key", [EVENT_KEY, FOREIGN_EVENT_KEY]);
  await admin
    .from("match")
    .delete()
    .in("event_key", [EVENT_KEY, FOREIGN_EVENT_KEY]);
  await admin
    .from("event_secret")
    .delete()
    .in("event_key", [EVENT_KEY, FOREIGN_EVENT_KEY]);
  await admin
    .from("event")
    .delete()
    .in("event_key", [EVENT_KEY, FOREIGN_EVENT_KEY]);
  await admin.from("team").delete().eq("team_number", TEAM_NUMBER);
}

// A valid report payload (snake_case per contracts §1a). row_revision:1.
function validReport(): Record<string, unknown> {
  return {
    id: REPORT_ID,
    schema_version: 1,
    app_version: "test-jwt-1.0.0",
    device_id: "test-device-jwt",
    event_key: EVENT_KEY,
    match_key: MATCH_KEY,
    scout_id: memberScoutId,
    target_team_number: TEAM_NUMBER,
    alliance_color: "red",
    station: 1,
    inactive_first: false,
    fuel_bursts: [{ startMs: 0, endMs: 10000, rate: 2.0, window: "auto" }],
    row_revision: 1,
  };
}

async function reportCount(eventKey: string): Promise<number> {
  const { count, error } = await admin
    .from("match_scouting_report")
    .select("id", { count: "exact", head: true })
    .eq("event_key", eventKey);
  if (error) throw new Error(`count failed: ${error.message}`);
  return count ?? 0;
}

d("ingest-reports (deployed, JWT event-member auth)", () => {
  beforeAll(async () => {
    await seed();
    expect(memberJwt).toBeTruthy();
    expect(memberScoutId).toBeTruthy();
  }, 30000);

  afterAll(async () => {
    await cleanup();
  }, 30000);

  it("rejects a request with no Authorization header → 401", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        apikey: ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reports: [validReport()] }),
    });
    expect(res.status).toBe(401);
  }, 30000);

  it("ingests a member report for their own event → 200 { ingested: 1 } + row exists", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberJwt}`,
        apikey: ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reports: [validReport()] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingested).toBe(1);
    expect(body.failed).toEqual([]);

    const { data, error } = await admin
      .from("match_scouting_report")
      .select("id, event_key, match_key, target_team_number")
      .eq("id", REPORT_ID)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(REPORT_ID);
    expect(data?.event_key).toBe(EVENT_KEY);
  }, 30000);

  it("re-POSTing the SAME report → 200 { ingested: 1 } and NO duplicate", async () => {
    const before = await reportCount(EVENT_KEY);

    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberJwt}`,
        apikey: ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reports: [validReport()] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingested).toBe(1);
    expect(body.failed).toEqual([]);

    // Revision guard ⇒ same id+revision is a no-op ⇒ count unchanged.
    const after = await reportCount(EVENT_KEY);
    expect(after).toBe(before);
  }, 30000);

  it("rejects a report whose event_key is outside the member's events → 403, nothing written", async () => {
    const before = await reportCount(FOREIGN_EVENT_KEY);

    const foreignReport = {
      ...validReport(),
      id: FOREIGN_REPORT_ID,
      event_key: FOREIGN_EVENT_KEY,
      match_key: FOREIGN_MATCH_KEY,
    };

    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberJwt}`,
        apikey: ANON,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reports: [foreignReport] }),
    });
    expect(res.status).toBe(403);

    // Nothing was written for the foreign event.
    const after = await reportCount(FOREIGN_EVENT_KEY);
    expect(after).toBe(before);
    const { data } = await admin
      .from("match_scouting_report")
      .select("id")
      .eq("id", FOREIGN_REPORT_ID)
      .maybeSingle();
    expect(data).toBeNull();
  }, 30000);
});
