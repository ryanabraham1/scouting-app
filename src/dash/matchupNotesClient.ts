// src/dash/matchupNotesClient.ts
// Client helpers for event-scoped team strategy notes (matchup-intelligence).
//
// The existing matchup_note table has an event + two-int primary key. V1 used
// those ints for the two alliance leads. Team notes reuse that storage without a
// schema migration by reserving our_team = -1 and storing the actual target team
// in opp_team. FRC team numbers are positive and V1 normalization only emitted
// non-negative values, so this creates an unambiguous namespace while preserving
// every legacy alliance-pair row.
//
// Reads come straight from PostgREST (RLS read is open — migration 0033). Writes
// go to Dexie 'dirty' immediately (offline-first) and drain through the sync
// controller via matchupNotesSync.ts — the server write is NOT done here, to keep
// the offline path single.

import { supabase } from '@/lib/supabase';
import { getMatchupNote, saveMatchupNoteLocal } from '@/db/localStore';
import type { MatchupNoteRow, LocalMatchupNote } from '@/db/types';

/** Reserved pair-key namespace for event-scoped notes about one actual team. */
export const TEAM_STRATEGY_NOTE_NAMESPACE = -1;

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

/** Collision-free key for one actual team's event-scoped strategy note. */
export function teamNoteKeyFor(eventKey: string, targetTeam: number): string {
  return keyFor(eventKey, TEAM_STRATEGY_NOTE_NAMESPACE, targetTeam);
}

function validTargetTeam(targetTeam: number): void {
  if (!Number.isInteger(targetTeam) || targetTeam <= 0) {
    throw new Error(`Invalid strategy-note target team: ${targetTeam}`);
  }
}

/**
 * Generate a locally monotonic revision for sequential edits on this device.
 * The server still provides the cross-device strictly-newer guard.
 */
async function nextUpdatedAt(key: string): Promise<string> {
  const previous = await getMatchupNote(key);
  const previousMs = previous ? Date.parse(previous.updatedAt) : 0;
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
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
 * Persist one actual team's event-scoped strategy note through the existing
 * offline outbox. The reserved namespace avoids collisions with all V1
 * alliance-lead pair keys.
 */
export async function saveTeamStrategyNote(
  eventKey: string,
  targetTeam: number,
  note: string,
  authorScoutId: string | null = null,
): Promise<LocalMatchupNote> {
  validTargetTeam(targetTeam);
  const key = teamNoteKeyFor(eventKey, targetTeam);
  const record: LocalMatchupNote = {
    key,
    eventKey,
    ourTeam: TEAM_STRATEGY_NOTE_NAMESPACE,
    oppTeam: targetTeam,
    note,
    updatedAt: await nextUpdatedAt(key),
    authorScoutId,
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
  };
  await saveMatchupNoteLocal(record);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('scout-sync-changed'));
  }
  return record;
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
  const key = keyFor(eventKey, ourTeam, oppTeam);
  const record: LocalMatchupNote = {
    key,
    eventKey,
    ourTeam,
    oppTeam,
    note,
    updatedAt: await nextUpdatedAt(key),
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
