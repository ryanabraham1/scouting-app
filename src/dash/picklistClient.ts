// src/dash/picklistClient.ts
// Reads/writes the shared, staff-RLS'd picklist (phase4-contracts.md §6). One
// row per event in the `picklist` table (migration 0007). RLS (is_staff())
// scopes access on the server — this client carries no extra auth.
import { supabase } from '@/lib/supabase';

/** One ordered entry in an event's picklist (contracts §6). */
export interface PicklistEntry {
  teamNumber: number;
  tier?: string | null;
  note?: string | null;
}

/**
 * The ordered picklist entries for an event. Returns `[]` when no row exists
 * yet (a fresh event has no picklist) — never throws on an empty picklist.
 */
export async function getPicklist(eventKey: string): Promise<PicklistEntry[]> {
  const { data, error } = await supabase
    .from('picklist')
    .select('entries')
    .eq('event_key', eventKey)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data?.entries as PicklistEntry[] | undefined) ?? [];
}

/**
 * Upsert the whole ordered picklist for an event (conflict on `event_key`).
 * Stamps `updated_at` client-side; `updated_by` is left to the DB default/null.
 */
export async function savePicklist(eventKey: string, entries: PicklistEntry[]): Promise<void> {
  const { error } = await supabase.from('picklist').upsert(
    { event_key: eventKey, entries, updated_at: new Date().toISOString() },
    { onConflict: 'event_key' },
  );

  if (error) {
    throw error;
  }
}
