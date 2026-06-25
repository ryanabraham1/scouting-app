// src/db/preloadClient.ts
//
// Offline preload: fetch everything a scout needs for a full event (match
// schedule, their assignments, the scouter roster, the team list) from Supabase
// and write it into IndexedDB so the scout screens work with zero wifi.
//
// Design rule: each section is best-effort and INDEPENDENT. A failure in one
// (e.g. assignments) must not abort the others, and the whole thing NEVER
// throws — callers get a structured PreloadResult with a per-section errors[].
import { supabase } from '@/lib/supabase';
import { listRoster } from '@/roster/rosterClient';
import { db } from './localStore';
import type {
  CachedMatch,
  CachedAssignment,
  CachedRosterScouter,
  CachedTeam,
  PreloadMeta,
} from './types';

export interface PreloadResult {
  ok: boolean;
  at: string; // ISO time of attempt
  counts: { matches: number; assignments: number; roster: number; teams: number };
  errors: string[]; // human-readable per-section errors; empty on full success
}

// Same column list UpcomingMatches.tsx selects from `match` — keep in sync so
// the cache is a drop-in for the live query.
const MATCH_COLUMNS =
  'match_key,event_key,comp_level,match_number,scheduled_time,red1,red2,red3,blue1,blue2,blue3,actual_red_score,actual_blue_score,winner,result_synced_at';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Fetch all offline-needed data for an event and write it into Dexie.
 * Assignments are only fetched when a scoutId is given. Returns a structured
 * result; never throws.
 */
export async function preloadEventData(opts: {
  eventKey: string;
  scoutId?: string;
}): Promise<PreloadResult> {
  const { eventKey, scoutId } = opts;
  const at = new Date().toISOString();
  const errors: string[] = [];
  const counts = { matches: 0, assignments: 0, roster: 0, teams: 0 };

  // --- Matches (event schedule + any synced results) -----------------------
  try {
    const res = await supabase
      .from('match')
      .select(MATCH_COLUMNS)
      .eq('event_key', eventKey);
    if (res.error) throw new Error(res.error.message);
    const rows = (res.data as CachedMatch[] | null) ?? [];
    // Clean refresh: drop this event's stale rows before writing fresh ones —
    // but ONLY when the query returned data. A successful-but-empty response
    // (transient race / inconsistency) must NOT wipe a good offline cache.
    if (rows.length) {
      await db.cachedMatches.where('event_key').equals(eventKey).delete();
      await db.cachedMatches.bulkPut(rows);
    }
    counts.matches = rows.length;
  } catch (err) {
    errors.push(`matches: ${errMsg(err, 'failed to preload matches')}`);
  }

  // --- Roster (global, not event-scoped) -----------------------------------
  try {
    const roster = await listRoster();
    const rows: CachedRosterScouter[] = roster.map((r) => ({ id: r.id, name: r.name }));
    // Only replace the cached roster when we actually fetched names; never wipe
    // it to empty on a successful-but-empty response.
    if (rows.length) {
      await db.cachedRoster.clear();
      await db.cachedRoster.bulkPut(rows);
    }
    counts.roster = rows.length;
  } catch (err) {
    errors.push(`roster: ${errMsg(err, 'failed to preload roster')}`);
  }

  // --- Assignments (this scout only; needs a scoutId) ----------------------
  if (scoutId) {
    try {
      const res = await supabase.from('assignment').select('*').eq('scout_id', scoutId);
      if (res.error) throw new Error(res.error.message);
      const raw = (res.data as Array<{
        scout_id: string;
        match_key: string;
        alliance_color: 'red' | 'blue';
        station: 1 | 2 | 3;
        target_team_number: number;
        event_key: string;
      }> | null) ?? [];
      const rows: CachedAssignment[] = raw.map((a) => ({
        id: `${a.scout_id}:${a.match_key}`,
        scout_id: a.scout_id,
        match_key: a.match_key,
        alliance_color: a.alliance_color,
        station: a.station,
        target_team_number: a.target_team_number,
        event_key: a.event_key,
      }));
      // Clean refresh, but only when the server actually returned assignments.
      // This is the critical case: select_scouter re-points a scout's rows to a
      // different scout_id, so for a brief window the queried id legitimately
      // returns zero rows. Wiping here would permanently clear a scout's cached
      // assignments mid-event (the "assignments disappear after a while" bug).
      if (rows.length) {
        await db.cachedAssignments.where('scout_id').equals(scoutId).delete();
        await db.cachedAssignments.bulkPut(rows);
      }
      counts.assignments = rows.length;
    } catch (err) {
      errors.push(`assignments: ${errMsg(err, 'failed to preload assignments')}`);
    }
  }

  // --- Teams (event_team → team, flattened) --------------------------------
  try {
    // Mirrors useEventTeams: nested team via the event_team join.
    const res = await supabase
      .from('event_team')
      .select('team:team(team_number,nickname)')
      .eq('event_key', eventKey);
    if (res.error) throw new Error(res.error.message);
    const nested = (res.data as unknown as Array<{
      team: { team_number: number; nickname: string | null } | null;
    }> | null) ?? [];
    const rows: CachedTeam[] = nested
      .map((r) => r.team)
      .filter((t): t is { team_number: number; nickname: string | null } => t != null)
      .map((t) => ({
        id: `${eventKey}:${t.team_number}`,
        event_key: eventKey,
        team_number: t.team_number,
        nickname: t.nickname ?? null,
      }));
    // Only refresh when teams came back; don't wipe to empty on a transient
    // empty response.
    if (rows.length) {
      await db.cachedTeams.where('event_key').equals(eventKey).delete();
      await db.cachedTeams.bulkPut(rows);
    }
    counts.teams = rows.length;
  } catch (err) {
    errors.push(`teams: ${errMsg(err, 'failed to preload teams')}`);
  }

  // Record the attempt regardless of partial failures so the UI can show a
  // "last synced" time and the counts that did make it in.
  const meta: PreloadMeta = {
    key: eventKey,
    lastPreloadAt: at,
    counts: {
      matches: counts.matches,
      assignments: counts.assignments,
      roster: counts.roster,
      teams: counts.teams,
    },
  };
  try {
    await db.preloadMeta.put(meta);
  } catch (err) {
    errors.push(`meta: ${errMsg(err, 'failed to record preload meta')}`);
  }

  return { ok: errors.length === 0, at, counts, errors };
}

// --- Local-first reads (cache / offline fallback for the scout screens) -----

/** Cached matches for an event, ordered by match number. */
export async function getCachedMatches(eventKey: string): Promise<CachedMatch[]> {
  const rows = await db.cachedMatches.where('event_key').equals(eventKey).toArray();
  return rows.sort((a, b) => a.match_number - b.match_number);
}

/** Cached assignments for a scout. */
export async function getCachedAssignments(scoutId: string): Promise<CachedAssignment[]> {
  return db.cachedAssignments.where('scout_id').equals(scoutId).toArray();
}

/** Cached roster, alphabetical (case-insensitive). */
export async function getCachedRoster(): Promise<CachedRosterScouter[]> {
  const rows = await db.cachedRoster.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Cached teams for an event, ascending by team number. */
export async function getCachedTeams(eventKey: string): Promise<CachedTeam[]> {
  const rows = await db.cachedTeams.where('event_key').equals(eventKey).toArray();
  return rows.sort((a, b) => a.team_number - b.team_number);
}

/** Last-preload bookkeeping for an event (undefined if never preloaded). */
export async function getPreloadMeta(eventKey: string): Promise<PreloadMeta | undefined> {
  return db.preloadMeta.get(eventKey);
}
