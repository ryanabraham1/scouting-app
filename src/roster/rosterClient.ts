// src/roster/rosterClient.ts
// CRUD against the team-scoped `scouter_roster` table. The roster persists across
// events (no event_key) — it's the source of names a scouter picks from on their
// device and the list the lead manages in the dashboard Roster tab.
import { supabase } from '@/lib/supabase';

export interface RosterScouter {
  id: string;
  name: string;
}

interface RosterRow {
  id: string;
  name: string;
}

// Postgres unique-violation; raised when two devices add the same (lower-cased)
// name concurrently. We treat it as a no-op success.
const UNIQUE_VIOLATION = '23505';

/** All roster names, alphabetical (case-insensitive). */
export async function listRoster(): Promise<RosterScouter[]> {
  const { data, error } = await supabase
    .from('scouter_roster')
    .select('id,name')
    .order('name', { ascending: true });
  if (error) {
    throw new Error(error.message);
  }
  return ((data ?? []) as RosterRow[]).map((r) => ({ id: r.id, name: r.name }));
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

/** Remove a scouter by id. */
export async function removeScouter(id: string): Promise<void> {
  const { error } = await supabase.from('scouter_roster').delete().eq('id', id);
  if (error) {
    throw new Error(error.message);
  }
}
