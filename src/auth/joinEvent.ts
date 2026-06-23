// src/auth/joinEvent.ts
import { supabase } from '../lib/supabase';

/** Mirrors the frozen `scout` table row returned by join_event / recover_identity. */
export interface ScoutRow {
  id: string;
  event_key: string;
  display_name: string;
  auth_uid: string;
  created_at: string;
}

function normalize(code: string, name: string): { code: string; name: string } {
  const c = (code ?? '').trim();
  const n = (name ?? '').trim();
  if (!c) throw new Error('A join code is required.');
  if (!n) throw new Error('A display name is required.');
  return { code: c, name: n };
}

async function ensureAnonSession(): Promise<void> {
  // Reuse the persisted anon session if one already exists. One device must
  // map to exactly one auth.uid() (= one scout); signing in again would mint a
  // brand-new anon user and break per-device idempotency (duplicate scouts).
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.user) return;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error(error.message);
  if (!data?.user) throw new Error('Anonymous sign-in did not return a user.');
}

/**
 * Sign in anonymously, then call the SECURITY DEFINER `join_event` RPC.
 * Idempotent per auth.uid()+event on the server. Returns the scout row.
 */
export async function joinEvent(code: string, name: string): Promise<ScoutRow> {
  const { code: p_code, name: p_display_name } = normalize(code, name);
  await ensureAnonSession();
  const { data, error } = await supabase.rpc('join_event', { p_code, p_display_name });
  if (error) throw new Error(error.message);
  return data as ScoutRow;
}

/**
 * Rebind the current anonymous auth.uid() to an existing scout matched by
 * code+name via the `recover_identity` RPC.
 */
export async function recoverIdentity(code: string, name: string): Promise<ScoutRow> {
  const { code: p_code, name: p_display_name } = normalize(code, name);
  await ensureAnonSession();
  const { data, error } = await supabase.rpc('recover_identity', { p_code, p_display_name });
  if (error) throw new Error(error.message);
  return data as ScoutRow;
}
