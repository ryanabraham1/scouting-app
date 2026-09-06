// tests/db/seedHelpers.ts
//
// Shared fixture helpers for the remote DB integration suite.
//
// The `explicit_browser_data_api_grants` migration reduced `service_role` to a
// narrow allowlist (SELECT on event/event_secret, SELECT+INSERT+UPDATE on match,
// and EXECUTE on every function). It can no longer do the classic
// `admin.from('scout'/'team'/'match_scouting_report').insert()` fixture seeding.
//
// These helpers seed ONLY through the currently-granted, legitimate paths that
// real runtime code uses:
//   - `promote_event_import` (SECURITY DEFINER RPC, service_role-executable) to
//     create a throwaway event + teams + qm matches + join code in one txn, with
//     p_activate=false so the global active-event singleton is never touched.
//   - anon `select_scouter` (SECURITY DEFINER RPC) to provision an event-member
//     scout row bound to an anonymous auth.uid(), which also unlocks RLS reads.
//   - `delete_event` (SECURITY DEFINER RPC) for full, cascade-safe cleanup.
//
// All event keys are unique + random so a crashed run can never collide with
// real event data or with another test file.
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const URL = process.env.VITE_SUPABASE_URL!;
export const SECRET = process.env.SUPABASE_SECRET_KEY!;
export const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;

/** service_role client — used for the granted reads and the definer seed RPCs. */
export function adminClient(): SupabaseClient {
  return createClient(URL, SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Fresh anon-key client (role `anon` until it signs in). */
export function anonClient(): SupabaseClient {
  return createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Sign a client in anonymously, tolerating the shared test project's
 * anonymous-sign-in rate limit with a short bounded backoff. Several suites each
 * need a real auth.uid(), so a burst of sign-ins can transiently exceed GoTrue's
 * per-window quota; retrying briefly keeps the harness usable on the shared
 * remote without masking real failures (any non-rate-limit error throws at once).
 */
export async function signInAnon(client: SupabaseClient): Promise<string> {
  const delaysMs = [1500, 4000, 9000];
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await client.auth.signInAnonymously();
    if (!error) return data!.user!.id;
    const isRateLimited = /rate limit/i.test(error.message);
    if (!isRateLimited || attempt >= delaysMs.length) {
      throw new Error(`anon sign-in failed: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, delaysMs[attempt]));
  }
}

/**
 * A synthetic, throwaway event key. `promote_event_import` requires the shape
 * `^[0-9]{4}[a-z0-9]+$`, and its match keys must be `^<event_key>_qm[0-9]+$`.
 */
export function uniqueEventKey(tag: string): string {
  const rid = Math.random().toString(36).slice(2, 8); // 6 lowercase alnum chars
  return `2026${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}${rid}`;
}

export interface SeedTeam {
  team_number: number;
  nickname?: string;
}

export interface SeedMatch {
  match_key: string;
  match_number: number;
  red1?: number | null;
  red2?: number | null;
  red3?: number | null;
  blue1?: number | null;
  blue2?: number | null;
  blue3?: number | null;
}

/**
 * Seed a throwaway event with its team roster + qm schedule via the
 * `promote_event_import` definer RPC. Never activates the event.
 */
export async function seedEvent(
  admin: SupabaseClient,
  opts: { eventKey: string; name?: string; teams: SeedTeam[]; matches: SeedMatch[] },
): Promise<void> {
  const { error } = await admin.rpc('promote_event_import', {
    p_event: { event_key: opts.eventKey, name: opts.name ?? opts.eventKey },
    p_teams: opts.teams.map((t) => ({
      team_number: t.team_number,
      nickname: t.nickname ?? `Team ${t.team_number}`,
    })),
    p_matches: opts.matches.map((m) => ({
      match_key: m.match_key,
      match_number: m.match_number,
      red1: m.red1 ?? null,
      red2: m.red2 ?? null,
      red3: m.red3 ?? null,
      blue1: m.blue1 ?? null,
      blue2: m.blue2 ?? null,
      blue3: m.blue3 ?? null,
    })),
    p_activate: false,
  });
  if (error) {
    throw new Error(`seedEvent(${opts.eventKey}) failed: ${error.message}`);
  }
}

/** Cascade-safe teardown of a synthetic event (reports, scouts, matches, secret). */
export async function dropEvent(admin: SupabaseClient, eventKey: string): Promise<void> {
  await admin.rpc('delete_event', { p_event_key: eventKey });
}

export interface AnonMember {
  client: SupabaseClient;
  scoutId: string;
  uid: string;
}

/**
 * Sign in anonymously and provision an event-member scout row via the real
 * `select_scouter` RPC. The returned client is a member, so RLS-scoped reads of
 * the event's match/scout/report rows succeed.
 */
export async function joinAsScout(
  eventKey: string,
  name: string,
): Promise<AnonMember> {
  const client = anonClient();
  const uid = await signInAnon(client);
  const { data: scout, error } = await client.rpc('select_scouter', {
    p_event_key: eventKey,
    p_name: name,
  });
  if (error) throw new Error(`select_scouter(${name}) failed: ${error.message}`);
  return { client, scoutId: (scout as { id: string }).id, uid };
}

/**
 * Provision several named event-member scout rows through a single already
 * signed-in client, returning a { name -> scout id } map.
 *
 * `select_scouter` binds the picked name to the caller uid and re-points any
 * OTHER same-uid row in that event to a fresh random uid (identity migration),
 * so calling it repeatedly on one client leaves one real scout row per name —
 * all event members, differing only in which one still carries the live uid.
 * This is the only granted path to mint scout rows now that direct
 * `service_role` `scout` inserts are revoked, and it spends just one anonymous
 * sign-in for the whole batch (kind to the shared project's sign-in quota).
 */
export async function selectScoutsWith(
  client: SupabaseClient,
  eventKey: string,
  names: string[],
): Promise<Record<string, string>> {
  const scouts: Record<string, string> = {};
  for (const name of names) {
    const { data, error } = await client.rpc('select_scouter', {
      p_event_key: eventKey,
      p_name: name,
    });
    if (error) throw new Error(`select_scouter(${name}) failed: ${error.message}`);
    scouts[name] = (data as { id: string }).id;
  }
  return scouts;
}

export interface ProvisionedScouts {
  client: SupabaseClient;
  uid: string;
  scouts: Record<string, string>;
}

/**
 * Sign in anonymously ONCE and provision the given named scout rows for an
 * event. The returned client is an event member (bound to the last name).
 */
export async function provisionScouts(
  eventKey: string,
  names: string[],
): Promise<ProvisionedScouts> {
  const client = anonClient();
  const uid = await signInAnon(client);
  const scouts = await selectScoutsWith(client, eventKey, names);
  return { client, uid, scouts };
}
