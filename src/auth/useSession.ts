// src/auth/useSession.ts
import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { ScoutRow } from './scoutRow';

export interface UseSessionResult {
  session: Session | null;
  scout: ScoutRow | null;
  loading: boolean;
}

async function loadScout(authUid: string): Promise<ScoutRow | null> {
  const { data } = await supabase
    .from('scout')
    .select('*')
    .eq('auth_uid', authUid)
    .maybeSingle();
  return (data as ScoutRow | null) ?? null;
}

/**
 * Resolve the (anonymous) session and this device's scout row, if any.
 *
 * The app has no visible auth and no roles. `loading` is true ONLY during the
 * first resolve. Subsequent `onAuthStateChange` events (TOKEN_REFRESHED on a
 * timer, tab focus, etc.) update `session`/`scout` WITHOUT flipping `loading`
 * back to true — flipping it was the root cause of guarded screens unmounting
 * and the lead's selected event "disappearing after a bit".
 */
export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session | null>(null);
  const [scout, setScout] = useState<ScoutRow | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const resolvedOnce = useRef(false);

  useEffect(() => {
    mounted.current = true;

    async function apply(next: Session | null): Promise<void> {
      if (!mounted.current) return;
      setSession(next);
      const s = next?.user ? await loadScout(next.user.id) : null;
      if (!mounted.current) return;
      setScout(s);
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
