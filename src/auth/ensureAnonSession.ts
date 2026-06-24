// src/auth/ensureAnonSession.ts
import { supabase } from '../lib/supabase';

/**
 * Ensure an anonymous Supabase session exists. The app has NO visible login;
 * every device silently gets one anonymous auth.uid() so RLS-backed reads/writes
 * (and per-device scout identity) keep working. Idempotent: reuses the persisted
 * session if present, so a device maps to exactly one auth.uid().
 */
export async function ensureAnonSession(): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.user) return;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error(error.message);
  if (!data?.user) throw new Error('Anonymous sign-in did not return a user.');
}
