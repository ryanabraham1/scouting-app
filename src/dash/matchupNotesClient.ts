// src/dash/matchupNotesClient.ts
// Client helpers for per-opponent matchup notes (matchup-intelligence).
//
// Notes are keyed event-scoped on the two alliance LEAD teams — the LOWEST team
// number on each alliance. That is a stable, order-independent alliance
// identifier that survives station shuffles, so a note resurfaces for ANY future
// match pitting the same two alliance leads at the same event. (Known v1
// limitation: min() is not lineup-revision-independent — a surrogate/backup that
// changes an alliance's min re-keys the note. The modal header surfaces the lead
// so a coach understands why a note may not resurface after a lineup change.)
//
// Reads come straight from PostgREST (RLS read is open — migration 0033). Writes
// go to Dexie 'dirty' immediately (offline-first) and drain through the sync
// controller via matchupNotesSync.ts — the server write is NOT done here, to keep
// the offline path single.

import { supabase } from '@/lib/supabase';
import { saveMatchupNoteLocal } from '@/db/localStore';
import type { MatchupNoteRow, LocalMatchupNote } from '@/db/types';

/** The two alliance leads (min of each list). Symmetric/order-independent on min. */
export function normalizeMatchup(
  ourTeams: number[],
  oppTeams: number[],
): { ourTeam: number; oppTeam: number } {
  return {
    ourTeam: ourTeams.length ? Math.min(...ourTeams) : 0,
    oppTeam: oppTeams.length ? Math.min(...oppTeams) : 0,
  };
}

/** Dexie/local key for a normalized pairing. */
export function keyFor(eventKey: string, ourTeam: number, oppTeam: number): string {
  return `${eventKey}:${ourTeam}:${oppTeam}`;
}

/** Server select of all matchup notes for an event (RLS-scoped, open read). */
export async function fetchMatchupNotesForEvent(eventKey: string): Promise<MatchupNoteRow[]> {
  const { data, error } = await supabase
    .from('matchup_note')
    .select('event_key,our_team,opp_team,note,row_revision,updated_at,author_scout_id,deleted')
    .eq('event_key', eventKey)
    .eq('deleted', false);
  if (error) throw error;
  return (data ?? []) as MatchupNoteRow[];
}

/**
 * Persist a matchup note locally (offline-first). Normalizes the alliance leads,
 * writes the Dexie row as 'dirty' with `updatedAt = now` (the monotonic revision),
 * and resolves immediately. The caller opportunistically kicks the sync controller
 * (e.g. via the `scout-sync-changed` event) — the actual server write happens in
 * matchupNotesSync.ts so the offline queue stays the single source.
 */
export async function saveMatchupNote(
  eventKey: string,
  ourTeams: number[],
  oppTeams: number[],
  note: string,
  authorScoutId: string | null = null,
): Promise<LocalMatchupNote> {
  const { ourTeam, oppTeam } = normalizeMatchup(ourTeams, oppTeams);
  const record: LocalMatchupNote = {
    key: keyFor(eventKey, ourTeam, oppTeam),
    eventKey,
    ourTeam,
    oppTeam,
    note,
    updatedAt: new Date().toISOString(),
    authorScoutId,
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
  };
  await saveMatchupNoteLocal(record);
  // Nudge the sync controller to drain now if online (it also refreshes counts).
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('scout-sync-changed'));
  }
  return record;
}
