// src/roster/selectScouter.ts
// Wraps the `select_scouter` RPC: maps a chosen roster name + the active event to a
// per-event `scout` row owned by this device's anonymous auth.uid(). On success we
// remember the chosen name locally so the device skips the picker on reload.
import { supabase } from '@/lib/supabase';
import type { ScoutRow } from '@/auth/scoutRow';

const REMEMBER_KEY = 'my_scouter_name';

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

/**
 * Bind this device to `name` for `eventKey` and return the resolved scout row.
 * Persists the chosen name locally on success.
 */
export async function selectScouter(eventKey: string, name: string): Promise<ScoutRow> {
  const { data, error } = await supabase.rpc('select_scouter', {
    p_event_key: eventKey,
    p_name: name,
  });
  if (error) {
    throw new Error(error.message);
  }
  // The RPC `returns scout`; supabase-js may surface it as a single row or a
  // one-element array depending on the function shape.
  const row = (Array.isArray(data) ? data[0] : data) as ScoutRow | null;
  if (!row) {
    throw new Error('select_scouter returned no row');
  }
  rememberScouterName(name);
  return row;
}
