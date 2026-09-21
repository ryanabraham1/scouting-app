// src/dash/seasonEpa.ts
//
// Season-wide (cross-event) support for the primary LOCAL (TBA-derived) EPA.
//
// The EPA model in localEpa.ts (computeLocalEpa) carries EPA forward naturally
// because it processes matches chronologically. So if we feed it the COMBINED
// set of every match a team has played this season (across every event they've
// attended), a team arriving at event #3 starts with the EPA it built up at
// events #1 and #2 — exactly the desired season carry-over.
//
// CRITICAL: we must feed computeLocalEpa COMPLETE event match sets, not only the
// matches involving the displayed team. A team-season slice contains all six
// roster slots in each row, but it omits the partners' and opponents' other
// matches. That leaves those teams under-trained and over-attributes alliance
// residuals to the displayed team. We therefore union the EVENTS the requested
// teams attended and replay every match at those events.
//
// Caching: team-event and event-match fetches use dedicated React Query entries,
// shared by EPA and trend consumers and persisted to IndexedDB. The separate
// team-season match cache remains the source for W-L-T records only.

import { tbaGet } from '@/dash/proxies';
import { tbaMatchesToRows } from '@/dash/localEpa';
import { queryClient } from '@/lib/queryPersist';
import type { MatchRow } from '@/dash/useEventData';

// EPA / cross-event data changes slowly (only when new matches finish), and the
// season fan-out multiplies TBA calls, so it gets a longer stale window than the
// 60s live/schedule queries. Used by useEventEpa, useTeamSeasonStats, and the
// TBA sub-queries below.
export const EPA_STALE_TIME = 5 * 60_000;

// Bump whenever the season fan-out/replay semantics change so persisted results
// produced by an older, slower traversal cannot mask the new path.
export const SEASON_EPA_CLOSURE_VERSION = 6;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function pick(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

const MATCH_KEYS = [
  'key',
  'event_key',
  'comp_level',
  'set_number',
  'match_number',
  'winning_alliance',
  'actual_time',
  'predicted_time',
  'time',
] as const;
const ALLIANCE_KEYS = ['score', 'team_keys'] as const;
// The EPA model reads the foul/adjust fields (no-foul score) plus the five
// 2026 fields `parseRebuiltBreakdown` (localEpa.ts) turns into auto / teleop /
// endgame components. Everything else in the ~60-field breakdown is dropped.
const BREAKDOWN_KEYS = [
  'foulPoints',
  'adjustPoints',
  'totalAutoPoints',
  'totalTeleopPoints',
  'totalTowerPoints',
  'autoTowerPoints',
  'endGameTowerPoints',
] as const;

/**
 * Project a raw TBA match down to the fields the EPA model, W-L-T record and
 * chronological sort actually read. A raw match is ~5-10 KB (full
 * `score_breakdown`, videos, surrogate/dq lists); the season fan-out caches one
 * list per event ANY roster team attended, so an event ran to 50+ raw payloads
 * (~7 MB) inside the single persisted React Query blob. Firefox-family
 * browsers took seconds to read/parse that on every boot (the "verifying
 * server authority" stall) and every persist re-serialized all of it.
 */
export function compactTbaMatch(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const out = pick(raw, MATCH_KEYS);
  if (isObj(raw.alliances)) {
    const alliances: Record<string, unknown> = {};
    for (const color of ['red', 'blue'] as const) {
      const a = raw.alliances[color];
      if (isObj(a)) alliances[color] = pick(a, ALLIANCE_KEYS);
    }
    out.alliances = alliances;
  }
  if (isObj(raw.score_breakdown)) {
    const sb: Record<string, unknown> = {};
    for (const color of ['red', 'blue'] as const) {
      const a = raw.score_breakdown[color];
      if (isObj(a)) sb[color] = pick(a, BREAKDOWN_KEYS);
    }
    out.score_breakdown = sb;
  }
  return out;
}

/**
 * A finished event's match list never changes again, so refetching it every
 * EPA_STALE_TIME was pure waste: the season fan-out re-pulled ~25 event lists
 * (~30 KB gzipped each) on every dashboard open. Treat a list whose newest
 * played match is older than this as settled and keep it for a week.
 */
export const COMPLETED_EVENT_GRACE_MS = 3 * 24 * 60 * 60_000;
export const COMPLETED_EVENT_STALE_TIME = 7 * 24 * 60 * 60_000;

/** True when every match in a compacted list has been played and the newest is well in the past. */
export function isCompletedEventMatches(matches: unknown, now: number = Date.now()): boolean {
  if (!Array.isArray(matches) || matches.length === 0) return false;
  let newest = 0;
  for (const m of matches) {
    if (!isObj(m)) return false;
    const played = typeof m.actual_time === 'number' ? m.actual_time : null;
    if (played === null) return false;
    if (played > newest) newest = played;
  }
  return now - newest * 1000 > COMPLETED_EVENT_GRACE_MS;
}

/** Full (compacted) TBA match list for one event, shared across every team replay. */
export async function fetchEventMatchesCached(eventKey: string): Promise<unknown[]> {
  const queryKey = ['tba', 'event-matches', eventKey] as const;
  try {
    const json = await queryClient.fetchQuery({
      queryKey,
      staleTime: (query) =>
        isCompletedEventMatches(query.state.data) ? COMPLETED_EVENT_STALE_TIME : EPA_STALE_TIME,
      retry: false,
      queryFn: async (): Promise<unknown[]> => {
        const data = await tbaGet<unknown>(`/event/${eventKey}/matches`);
        if (!Array.isArray(data)) throw new Error('TBA event matches unavailable');
        return data.map(compactTbaMatch);
      },
    });
    return Array.isArray(json) ? json : [];
  } catch {
    return queryClient.getQueryData<unknown[]>(queryKey) ?? [];
  }
}

/** Event keys attended by one team in a season, behind the shared cache. */
export async function fetchTeamEventKeysCached(
  team: number,
  year: string,
): Promise<string[]> {
  const queryKey = ['tba', 'team-events', team, year] as const;
  try {
    return await queryClient.fetchQuery({
      queryKey,
      staleTime: EPA_STALE_TIME,
      retry: false,
      queryFn: async (): Promise<string[]> => {
        const data = await tbaGet<unknown>(`/team/frc${team}/events/${year}`);
        if (!Array.isArray(data)) throw new Error('TBA team events unavailable');
        const keys: string[] = [];
        for (const event of data) {
          if (typeof event === 'string') keys.push(event);
          else if (event && typeof event === 'object') {
            const key = (event as { key?: unknown }).key;
            if (typeof key === 'string') keys.push(key);
          }
        }
        return keys;
      },
    });
  } catch {
    return queryClient.getQueryData<string[]>(queryKey) ?? [];
  }
}

/**
 * A team's full-season TBA matches for W-L-T record calculation. EPA must not
 * use this slice; see the complete-event closure contract above.
 */
export async function fetchTeamSeasonMatchesCached(
  team: number,
  year: string,
): Promise<unknown[]> {
  const queryKey = ['tba', 'team-season-matches', team, year] as const;
  try {
    const json = await queryClient.fetchQuery({
      queryKey,
      staleTime: EPA_STALE_TIME,
      retry: false,
      queryFn: async (): Promise<unknown[]> => {
        const data = await tbaGet<unknown>(`/team/frc${team}/matches/${year}`);
        if (!Array.isArray(data)) throw new Error('TBA season matches unavailable');
        return data.map(compactTbaMatch);
      },
    });
    return Array.isArray(json) ? json : [];
  } catch (error) {
    const retained = queryClient.getQueryData<unknown[]>(queryKey);
    if (retained !== undefined) return retained;
    throw error;
  }
}

/**
 * Fetch the complete match schedules for every event attended by the requested
 * teams, then dedupe and sort the combined season chronologically.
 */
export async function fetchSeasonMatchRows(
  teamNumbers: number[],
  eventKey: string,
  year: string,
): Promise<MatchRow[]> {
  const teams = [...new Set(teamNumbers)].filter(
    (team) => Number.isSafeInteger(team) && team > 0,
  );
  const eventKeys = new Set<string>([eventKey]);
  const teamEventLists = await Promise.all(
    teams.map((team) => fetchTeamEventKeysCached(team, year)),
  );
  for (const list of teamEventLists) {
    for (const key of list) eventKeys.add(key);
  }

  const payloads = await Promise.all(
    [...eventKeys].map((key) => fetchEventMatchesCached(key)),
  );

  // Concatenate each event's full match list, deduping by
  // match key so a match never double-counts if it appeared in two payloads.
  const seen = new Set<string>();
  const combined: unknown[] = [];
  for (const arr of payloads) {
    for (const m of arr) {
      const key =
        m && typeof m === 'object' && typeof (m as { key?: unknown }).key === 'string'
          ? ((m as { key: string }).key)
          : null;
      if (key != null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      combined.push(m);
    }
  }

  // tbaMatchesToRows sorts the combined set chronologically across events and
  // assigns a fresh monotonic match_number so the model plays them in true order.
  return tbaMatchesToRows(combined);
}
