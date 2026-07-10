// src/dash/picklistClient.ts
// Reads/writes the shared, staff-RLS'd picklist (phase4-contracts.md §6). One
// row per event in the `picklist` table (migration 0007). RLS (is_staff())
// scopes access on the server — this client carries no extra auth.
import { supabase } from '@/lib/supabase';

/** Which of the two ordered picklists an entry belongs to. */
export type PicklistId = 'first' | 'second';

/** One ordered entry in an event's picklist (contracts §6). */
export interface PicklistEntry {
  teamNumber: number;
  tier?: string | null;
  note?: string | null;
  /** Coaching flag: "do not pick" / avoid. Additive JSONB — no migration. */
  dnp?: boolean;
  /**
   * Which picklist the team is on: `'second'` → the 2nd-pick list, anything
   * else (`'first'`/legacy null) → the 1st-pick list. Additive JSONB — rows
   * written by older builds (a per-row tier TAG, same values) read as list
   * membership with no migration. Order within `entries` is the order within
   * each list (the lists are filtered views of the one stored array).
   */
  tierType?: PicklistId | null;
}

const PICKLIST_CACHE_PREFIX = 'picklist-cache:v1:';

function picklistCacheKey(eventKey: string): string {
  return `${PICKLIST_CACHE_PREFIX}${eventKey}`;
}

/** Last known-good event-scoped snapshot for read-only failed-load fallback. */
export function getCachedPicklist(eventKey: string): PicklistEntry[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(picklistCacheKey(eventKey)) ?? 'null');
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter(
        (entry): entry is PicklistEntry =>
          !!entry &&
          typeof entry === 'object' &&
          Number.isInteger((entry as PicklistEntry).teamNumber) &&
          (entry as PicklistEntry).teamNumber > 0,
      )
      .map((entry) => ({
        ...entry,
        dnp: entry.dnp ?? false,
        tierType: entry.tierType ?? null,
      }));
  } catch {
    return null;
  }
}

/** Cache only snapshots confirmed by a successful server read/write. */
export function cachePicklist(eventKey: string, entries: PicklistEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(picklistCacheKey(eventKey), JSON.stringify(entries));
  } catch {
    /* storage unavailable — remote persistence remains authoritative */
  }
}

/** Resolve an entry's list membership (legacy null/absent → the 1st-pick list). */
export function entryList(e: PicklistEntry): PicklistId {
  return e.tierType === 'second' ? 'second' : 'first';
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

  // Normalize on read so callers always see booleans/null — legacy rows written
  // by older builds lack `dnp`/`tierType` (defensive forward/backward compat).
  const entries = (data?.entries as PicklistEntry[] | undefined) ?? [];
  const normalized = entries.map((e) => ({
    ...e,
    dnp: e.dnp ?? false,
    tierType: e.tierType ?? null,
  }));
  cachePicklist(eventKey, normalized);
  return normalized;
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
  cachePicklist(eventKey, entries);
}
