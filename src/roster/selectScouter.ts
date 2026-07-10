// src/roster/selectScouter.ts
// Wraps the `select_scouter` RPC: maps a chosen roster name + the active event to a
// per-event `scout` row owned by this device's anonymous auth.uid(). On success we
// remember the chosen name locally so the device skips the picker on reload.
import { supabase } from '@/lib/supabase';
import type { ScoutRow } from '@/auth/scoutRow';
import { cacheScoutRow } from '@/auth/useSession';
import { getCachedScoutIdentity, rememberScoutIdentity } from '@/roster/scoutIdentityCache';

const REMEMBER_KEY = 'my_scouter_name';
// Durable "this device logged out" flag. The device's anonymous auth.uid stays
// bound to its old scout row server-side, so useSession would otherwise re-resolve
// the previous profile on every fresh mount/reload — leaving a logged-out scout
// "stuck in a certain profile". This flag persists the intent until a new name is
// picked, which is what makes log-out actually stick across reloads.
const LOGGED_OUT_KEY = 'scouter_logged_out';

/** The name this device last selected, or null. */
export function getRememberedScouterName(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}

function rememberScouterName(name: string): void {
  try {
    localStorage.setItem(REMEMBER_KEY, name);
  } catch {
    /* storage unavailable — non-fatal; the picker will just reappear next load */
  }
}

/** Forget the remembered name (e.g. "switch scouter"). */
export function forgetScouterName(): void {
  try {
    localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* non-fatal */
  }
}

/** True if this device logged out and hasn't picked a new scouter since. */
export function isScouterLoggedOut(): boolean {
  try {
    return localStorage.getItem(LOGGED_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Durably mark this device as logged out (survives reload until the next pick). */
export function markScouterLoggedOut(): void {
  try {
    localStorage.setItem(LOGGED_OUT_KEY, '1');
  } catch {
    /* non-fatal */
  }
}

function clearLoggedOutFlag(): void {
  try {
    localStorage.removeItem(LOGGED_OUT_KEY);
  } catch {
    /* non-fatal */
  }
}

// Network/transport failure (offline) vs. a real server-side rejection. We fall
// back to the offline identity cache ONLY for the former — a genuine RPC error
// (bad name, RLS, etc.) must still surface. supabase-js surfaces a dropped
// connection either by throwing a TypeError or by returning an error whose
// message reads "Failed to fetch"/"Load failed"/"NetworkError"; and the browser
// may already know it's offline via navigator.onLine.
function isOfflineLike(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (err instanceof TypeError) return true;
  // Match the network-failure phrasings across browsers (Chrome "Failed to
  // fetch", Firefox "NetworkError", Safari "Load failed", RN "Network request
  // failed"). Deliberately NOT a bare "fetch" so an online server error that
  // merely mentions fetch isn't misclassified as offline.
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return /failed to fetch|networkerror|network request failed|load failed/.test(msg);
}

// Persist a successful (or cache-restored) pick so the device stays signed in
// and can re-pick this name offline later.
function commitSelection(row: ScoutRow, name: string): void {
  rememberScouterName(name);
  // A successful pick supersedes any prior log-out on this device.
  clearLoggedOutFlag();
  // Durable name→row map for offline re-selection, and keep the device signed
  // in across reloads (cached_scout_row).
  rememberScoutIdentity(row);
  cacheScoutRow(row);
}

async function selectScouterFromServer(eventKey: string, name: string): Promise<ScoutRow> {
  const { data, error } = await supabase.rpc('select_scouter', {
    p_event_key: eventKey,
    p_name: name,
  });
  if (error) throw new Error(error.message);
  // The RPC `returns scout`; supabase-js may surface it as a single row or a
  // one-element array depending on the function shape.
  const row = (Array.isArray(data) ? data[0] : data) as ScoutRow | null;
  if (!row) throw new Error('select_scouter returned no row');
  return row;
}

/**
 * Re-resolve a selected name against the server without an offline fallback.
 *
 * Background assignment refreshes use this stricter variant because a cached
 * identity cannot prove that an empty assignment result is authoritative after
 * server-side identity consolidation.
 */
export async function reconcileScouterIdentity(
  eventKey: string,
  name: string,
): Promise<ScoutRow> {
  const row = await selectScouterFromServer(eventKey, name);
  commitSelection(row, name);
  return row;
}

/**
 * Bind this device to `name` for `eventKey` and return the resolved scout row.
 * Persists the chosen name locally on success.
 *
 * Offline-resilient: if the select_scouter RPC can't reach the server, fall
 * back to this device's cached identity for (eventKey, name) — the real scout
 * row from a prior online sign-in. This is what lets an accidentally-logged-out
 * scout get back into their assignments with no wifi. If the name was never
 * signed in on this device, we surface a friendly "connect once" message
 * instead of a raw "Failed to fetch".
 */
export async function selectScouter(eventKey: string, name: string): Promise<ScoutRow> {
  try {
    return await reconcileScouterIdentity(eventKey, name);
  } catch (err) {
    if (isOfflineLike(err)) {
      const cached = getCachedScoutIdentity(eventKey, name);
      if (cached) {
        commitSelection(cached, name);
        return cached;
      }
      throw new Error(
        `You're offline and this device hasn't signed in as "${name}" yet. ` +
          'Connect to the internet once to sign in, then it works offline.',
      );
    }
    throw err instanceof Error ? err : new Error('Failed to select scouter.');
  }
}
