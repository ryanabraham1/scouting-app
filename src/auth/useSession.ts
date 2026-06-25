// src/auth/useSession.ts
import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { ScoutRow } from './scoutRow';
import { rememberScoutIdentity } from '@/roster/scoutIdentityCache';

export interface UseSessionResult {
  session: Session | null;
  scout: ScoutRow | null;
  loading: boolean;
}

// Persisted across reloads so an offline cold start can render the scout
// immediately, before any (failing) network call. Fixes the regression where a
// scout got "kicked back to the name selector" after finishing a report.
const CACHED_SCOUT_KEY = 'cached_scout_row';

function readCachedScout(): ScoutRow | null {
  try {
    const raw = localStorage.getItem(CACHED_SCOUT_KEY);
    return raw ? (JSON.parse(raw) as ScoutRow) : null;
  } catch {
    return null;
  }
}

function writeCachedScout(row: ScoutRow | null): void {
  try {
    if (row) localStorage.setItem(CACHED_SCOUT_KEY, JSON.stringify(row));
    else localStorage.removeItem(CACHED_SCOUT_KEY);
  } catch {
    // Storage may be unavailable (private mode / quota) — ignore.
  }
}

/**
 * Drop the persisted scout row. Called on log-out so a fresh mount doesn't seed
 * the old profile back from cache before the (durable) logout flag is honored.
 */
export function clearCachedScout(): void {
  writeCachedScout(null);
}

/**
 * Persist a server-confirmed scout row so a reload stays signed in (even
 * offline). Used by selectScouter after a pick — online OR via the offline
 * identity cache — so the device doesn't fall back to the name picker on reload.
 */
export function cacheScoutRow(row: ScoutRow): void {
  writeCachedScout(row);
}

/**
 * Resolve this device's scout row.
 *
 * Returns:
 *   - a ScoutRow  → definitively this uid's scout row
 *   - null        → definitively NO row for this uid (success, empty result)
 *   - undefined   → UNKNOWN: couldn't reach the server (offline / transport /
 *                   RLS error). The caller must NOT treat this as "no scout".
 *
 * Distinguishing "no row" from "couldn't determine" is what stops an offline
 * TOKEN_REFRESHED/focus event from nulling out a perfectly valid scout.
 */
async function loadScout(authUid: string): Promise<ScoutRow | null | undefined> {
  try {
    const { data, error } = await supabase
      .from('scout')
      .select('*')
      .eq('auth_uid', authUid)
      .maybeSingle();
    // An error object (RLS/transport) is NOT proof the scout doesn't exist —
    // treat it as "unknown" so we keep any already-known scout.
    if (error) return undefined;
    return (data as ScoutRow | null) ?? null;
  } catch {
    // Thrown transport error (offline): unknown, do not overwrite scout.
    return undefined;
  }
}

/**
 * Resolve the (anonymous) session and this device's scout row, if any.
 *
 * The app has no visible auth and no roles. `loading` is true ONLY during the
 * first resolve. Subsequent `onAuthStateChange` events (TOKEN_REFRESHED on a
 * timer, tab focus, etc.) update `session`/`scout` WITHOUT flipping `loading`
 * back to true — flipping it was the root cause of guarded screens unmounting
 * and the lead's selected event "disappearing after a bit".
 *
 * Offline resilience: a refresh/focus event that fires while offline makes the
 * scout fetch throw. We must NOT clear `scout` in that case, or the ScoutHome
 * gate falls back to the name selector ("kicked back to the name selector"
 * after finishing a report). We seed from a localStorage cache and only clear
 * the scout on a genuine sign-out or a definitive "no row" result.
 */
export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session | null>(null);
  // Seed from cache so a fresh offline mount shows the scout before any network
  // call resolves.
  const [scout, setScout] = useState<ScoutRow | null>(() => readCachedScout());
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const resolvedOnce = useRef(false);

  useEffect(() => {
    mounted.current = true;

    async function apply(next: Session | null): Promise<void> {
      if (!mounted.current) return;
      setSession(next);

      if (next?.user) {
        const s: ScoutRow | null | undefined = await loadScout(next.user.id);
        if (!mounted.current) return;
        if (s === undefined) {
          // Couldn't determine (offline / transport / RLS): keep whatever scout
          // we already have (cached or previously resolved). Never null it out.
        } else if (s) {
          setScout(s);
          writeCachedScout(s);
          // Durably remember this name→row so the scout can re-pick it offline
          // (survives log-out, unlike cached_scout_row above).
          rememberScoutIdentity(s);
        } else {
          // Definitively no row for this uid.
          setScout(null);
          writeCachedScout(null);
        }
      } else {
        // Genuine sign-out / no user.
        setScout(null);
        writeCachedScout(null);
      }

      // Only the FIRST resolve clears the initial loading state. Later auth
      // events never re-enter the loading state.
      if (!resolvedOnce.current) {
        resolvedOnce.current = true;
        setLoading(false);
      }
    }

    supabase.auth.getSession().then(({ data }) => {
      void apply(data.session ?? null);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      void apply(next ?? null);
    });

    return () => {
      mounted.current = false;
      subscription.unsubscribe();
    };
  }, []);

  return { session, scout, loading };
}
