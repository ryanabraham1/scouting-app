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
  CachedPitAssignment,
  CachedRosterScouter,
  CachedTeam,
  PreloadMeta,
} from './types';

export interface PreloadResult {
  ok: boolean;
  at: string; // ISO time of attempt
  counts: {
    matches: number;
    assignments: number;
    pitAssignments: number;
    roster: number;
    teams: number;
  };
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
  const counts = { matches: 0, assignments: 0, pitAssignments: 0, roster: 0, teams: 0 };
  const succeeded = {
    matches: false,
    assignments: false,
    pitAssignments: false,
    roster: false,
    teams: false,
  };
  let assignmentRows: CachedAssignment[] | null = null;
  let pitAssignmentRows: CachedPitAssignment[] | null = null;

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
      await db.transaction('rw', db.cachedMatches, async () => {
        await db.cachedMatches.where('event_key').equals(eventKey).delete();
        await db.cachedMatches.bulkPut(rows);
      });
    }
    counts.matches = rows.length;
    succeeded.matches = true;
  } catch (err) {
    errors.push(`matches: ${errMsg(err, 'failed to preload matches')}`);
  }

  // --- Roster (global, not event-scoped) -----------------------------------
  try {
    const roster = await listRoster();
    const rows: CachedRosterScouter[] = roster.map((r) => ({ id: r.id, name: r.name }));
    // listRoster() THROWS on failure (caught below), so a successful empty result
    // is AUTHORITATIVE — the roster genuinely has no visible names. Clear the cache
    // first so deleted/hidden scouters don't linger in the offline picker forever
    // (the previous `if (rows.length)` guard could never empty the cache). There's
    // no select_scouter re-point race on the scouter_roster table, unlike the
    // event-scoped/assignment queries below.
    await db.cachedRoster.clear();
    if (rows.length) {
      await db.cachedRoster.bulkPut(rows);
    }
    counts.roster = rows.length;
    succeeded.roster = true;
  } catch (err) {
    errors.push(`roster: ${errMsg(err, 'failed to preload roster')}`);
  }

  // --- Assignments (all event rows; counts remain this scout only) ---------
  if (scoutId) {
    try {
      const res = await supabase.from('assignment').select('*').eq('event_key', eventKey);
      if (res.error) throw new Error(res.error.message);
      const raw = (res.data as Array<{
        id?: string;
        scout_id: string;
        match_key: string;
        alliance_color: 'red' | 'blue';
        station: 1 | 2 | 3;
        target_team_number: number;
        event_key: string;
      }> | null) ?? [];
      const rows: CachedAssignment[] = raw.map((a) => ({
        id: a.id ?? `${a.event_key}:${a.match_key}:${a.alliance_color}:${a.station}`,
        scout_id: a.scout_id,
        match_key: a.match_key,
        alliance_color: a.alliance_color,
        station: a.station,
        target_team_number: a.target_team_number,
        event_key: a.event_key,
      }));
      // Fetching the complete event avoids the select_scouter old-id race and
      // makes a successful empty result authoritative. Replace only this event;
      // assignments cached for every other event remain untouched.
      assignmentRows = rows;
      counts.assignments = rows.filter((row) => row.scout_id === scoutId).length;
      succeeded.assignments = true;
    } catch (err) {
      errors.push(`assignments: ${errMsg(err, 'failed to preload assignments')}`);
    }

    try {
      const res = await supabase
        .from('pit_assignment')
        .select(
          'event_key,team_number,scout_id,source,scout:scout!pit_assignment_event_scout_fkey(display_name)',
        )
        .eq('event_key', eventKey);
      if (res.error) throw new Error(res.error.message);
      const raw = (res.data as unknown as Array<{
        event_key: string;
        team_number: number;
        scout_id: string;
        source: 'manual' | 'auto';
        scout: { display_name: string | null } | null;
      }> | null) ?? [];
      const rows: CachedPitAssignment[] = raw.map((assignment) => ({
        id: `${assignment.event_key}:${assignment.team_number}:${assignment.scout_id}`,
        event_key: assignment.event_key,
        team_number: assignment.team_number,
        scout_id: assignment.scout_id,
        scout_name: assignment.scout?.display_name ?? null,
        source: assignment.source,
      }));
      // A successful empty response is authoritative for this event: publishing
      // an empty crew intentionally removes all assignments. Defer the cache
      // replacement to the metadata transaction below so rows/count metadata
      // cannot disagree after a crash.
      pitAssignmentRows = rows;
      counts.pitAssignments = rows.filter((row) => row.scout_id === scoutId).length;
      succeeded.pitAssignments = true;
    } catch (err) {
      errors.push(`pit assignments: ${errMsg(err, 'failed to preload pit assignments')}`);
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
      await db.transaction('rw', db.cachedTeams, async () => {
        await db.cachedTeams.where('event_key').equals(eventKey).delete();
        await db.cachedTeams.bulkPut(rows);
      });
    }
    counts.teams = rows.length;
    succeeded.teams = true;
  } catch (err) {
    errors.push(`teams: ${errMsg(err, 'failed to preload teams')}`);
  }

  // Preserve the last fully-successful timestamp across partial failures. For
  // counts, update only sections that actually succeeded; a failed section must
  // retain its last-known-good metadata instead of being rewritten as zero.
  const previousMeta = await db.preloadMeta.get(eventKey).catch(() => undefined);
  const previousCounts = previousMeta?.counts ?? {};
  const countFor = (key: keyof typeof counts): number =>
    succeeded[key] ? counts[key] : previousCounts[key] ?? 0;
  const meta: PreloadMeta = {
    key: eventKey,
    lastPreloadAt: errors.length === 0 ? at : previousMeta?.lastPreloadAt ?? at,
    counts: {
      matches: countFor('matches'),
      assignments: countFor('assignments'),
      pitAssignments: countFor('pitAssignments'),
      roster: countFor('roster'),
      teams: countFor('teams'),
    },
  };
  try {
    await db.transaction(
      'rw',
      db.cachedAssignments,
      db.cachedPitAssignments,
      db.preloadMeta,
      async () => {
        if (assignmentRows != null) {
          await db.cachedAssignments.where('event_key').equals(eventKey).delete();
          if (assignmentRows.length) await db.cachedAssignments.bulkPut(assignmentRows);
        }
        if (pitAssignmentRows != null) {
          await db.cachedPitAssignments.where('event_key').equals(eventKey).delete();
          if (pitAssignmentRows.length) await db.cachedPitAssignments.bulkPut(pitAssignmentRows);
        }
        await db.preloadMeta.put(meta);
      },
    );
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

/** Cached match assignments for an event (offline dashboard fallback). */
export async function getCachedAssignmentsForEvent(
  eventKey: string,
): Promise<CachedAssignment[]> {
  const rows = await db.cachedAssignments.toArray();
  return rows.filter((row) => row.event_key === eventKey);
}

/**
 * Atomically replace one event's cached match assignments.
 *
 * Both the preload flow and the lead assignment editor receive complete
 * event-wide snapshots. Keeping this replacement event-scoped means a confirmed
 * empty publish can clear stale rows without touching another event's offline
 * data.
 */
export async function replaceCachedAssignmentsForEvent(
  eventKey: string,
  rows: CachedAssignment[],
): Promise<void> {
  await db.transaction('rw', db.cachedAssignments, async () => {
    await db.cachedAssignments.where('event_key').equals(eventKey).delete();
    if (rows.length) await db.cachedAssignments.bulkPut(rows);
  });
}

/** Cached pit assignments for a scout, ordered by team number. */
export async function getCachedPitAssignments(
  scoutId: string,
): Promise<CachedPitAssignment[]> {
  const rows = await db.cachedPitAssignments.where('scout_id').equals(scoutId).toArray();
  return rows.sort((a, b) => a.team_number - b.team_number);
}

/** All cached pit crews for an event, used to show a scout their crew partners. */
export async function getCachedPitAssignmentsForEvent(
  eventKey: string,
): Promise<CachedPitAssignment[]> {
  const rows = await db.cachedPitAssignments.where('event_key').equals(eventKey).toArray();
  return rows.sort(
    (a, b) => a.team_number - b.team_number || (a.scout_name ?? '').localeCompare(b.scout_name ?? ''),
  );
}

/** Atomically replace one event's cached pit-assignment snapshot. */
export async function replaceCachedPitAssignmentsForEvent(
  eventKey: string,
  rows: CachedPitAssignment[],
): Promise<void> {
  await db.transaction('rw', db.cachedPitAssignments, async () => {
    await db.cachedPitAssignments.where('event_key').equals(eventKey).delete();
    if (rows.length) await db.cachedPitAssignments.bulkPut(rows);
  });
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
