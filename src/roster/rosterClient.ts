// src/roster/rosterClient.ts
// CRUD against the team-scoped `scouter_roster` table. The roster persists across
// events (no event_key) — it's the source of names a scouter picks from on their
// device and the list the lead manages in the dashboard Scouters panel.
//
// A roster entry can be HIDDEN (migration 0020): hidden scouters keep all of
// their reports but disappear from the "Who are you?" picker and from new
// assignment seeding. `listRoster` excludes them by default so the picker / the
// offline preload never show a hidden name; the admin panel passes
// `{ includeHidden: true }` to manage them.
import { supabase } from '@/lib/supabase';

export interface RosterScouter {
  id: string;
  name: string;
  hidden: boolean;
}

interface RosterRow {
  id: string;
  name: string;
  hidden: boolean | null;
}

// Postgres unique-violation; raised when two devices add the same (lower-cased)
// name concurrently. We treat it as a no-op success.
const UNIQUE_VIOLATION = '23505';

/**
 * Roster names, alphabetical (case-insensitive). Hidden scouters are excluded
 * unless `includeHidden` is set (the dashboard Scouters panel manages them).
 */
export async function listRoster(opts?: { includeHidden?: boolean }): Promise<RosterScouter[]> {
  let query = supabase.from('scouter_roster').select('id,name,hidden');
  if (!opts?.includeHidden) {
    query = query.eq('hidden', false);
  }
  const { data, error } = await query.order('name', { ascending: true });
  if (error) {
    throw new Error(error.message);
  }
  return ((data ?? []) as RosterRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    hidden: r.hidden ?? false,
  }));
}

/** Add a scouter. Trims the name; ignores blanks and unique-violations gracefully. */
export async function addScouter(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const { error } = await supabase.from('scouter_roster').insert({ name: trimmed });
  if (error) {
    // A duplicate name is not an error to surface — the name is already on the roster.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) return;
    throw new Error(error.message);
  }
}

/** Remove a roster entry by id (leaves any `scout` rows/reports — use
 *  deleteRosterScouter for a full team-wide delete). */
export async function removeScouter(id: string): Promise<void> {
  const { error } = await supabase.from('scouter_roster').delete().eq('id', id);
  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Hide or unhide a scouter by name. Hidden scouters keep all their reports but
 * are removed from the picker and from assignment seeding. Upserts a roster row
 * so a name that only exists as a `scout` row can still be hidden.
 */
export async function setScouterHidden(name: string, hidden: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_roster_hidden', {
    p_name: name,
    p_hidden: hidden,
  });
  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Permanently delete a scouter team-wide by name: the roster entry AND every
 * `scout` row with that name across all events, plus their reports/assignments.
 */
export async function deleteRosterScouter(name: string): Promise<void> {
  const { error } = await supabase.rpc('delete_roster_scouter', { p_name: name });
  if (error) {
    throw new Error(error.message);
  }
}
