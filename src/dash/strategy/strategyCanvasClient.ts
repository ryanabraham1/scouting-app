// src/dash/strategy/strategyCanvasClient.ts
// Client helpers for the per-match strategy whiteboard (Strategy tab).
//
// Reads come straight from PostgREST (`strategy_canvas` open read — migration
// 0042) merged with the Dexie-local doc so unsynced strokes show immediately.
// Writes go to Dexie 'dirty' (offline-first) and drain through the sync
// controller via strategyCanvasSync.ts — the server write is NOT done here, to
// keep the offline path single (mirrors matchupNotesClient.ts).

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { saveStrategyCanvasLocal, getStrategyCanvasLocal } from '@/db/localStore';
import type { StrategyCanvasRow, LocalStrategyCanvas } from '@/db/types';
import {
  parseCanvasDoc,
  mergeCanvasDocs,
  EMPTY_DOC,
  type CanvasDoc,
} from '@/dash/strategy/strokes';

/** Dexie/local key for one whiteboard doc. */
export function canvasKeyFor(eventKey: string, matchKey: string): string {
  return `${eventKey}:${matchKey}`;
}

/** Server select of one match's whiteboard row (null when none exists yet). */
export async function fetchStrategyCanvas(
  eventKey: string,
  matchKey: string,
): Promise<CanvasDoc | null> {
  const { data, error } = await supabase
    .from('strategy_canvas')
    .select('event_key,match_key,strokes,deleted_ids,row_revision,updated_at')
    .eq('event_key', eventKey)
    .eq('match_key', matchKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as StrategyCanvasRow;
  return parseCanvasDoc(row.strokes, row.deleted_ids);
}

/**
 * The whiteboard doc for one (event, match): server row merged with the Dexie
 * local doc (stroke-id union + tombstones — the same merge the RPC applies), so
 * unsynced local strokes always show and a remote device's strokes fold in.
 * Offline: Dexie-only fallback. queryKey `['strategy-canvas', eventKey, matchKey]`
 * so useEventLiveSync's realtime branch can push fresh rows straight in.
 */
export function useStrategyCanvas(
  eventKey: string | null,
  matchKey: string | null,
): UseQueryResult<CanvasDoc> {
  return useQuery({
    queryKey: ['strategy-canvas', eventKey, matchKey],
    enabled: !!eventKey && !!matchKey,
    staleTime: 15_000,
    queryFn: async (): Promise<CanvasDoc> => {
      const local = await getStrategyCanvasLocal(
        canvasKeyFor(eventKey as string, matchKey as string),
      );
      const localDoc: CanvasDoc = local
        ? { strokes: local.strokes, deletedIds: local.deletedIds }
        : EMPTY_DOC;
      try {
        const serverDoc = await fetchStrategyCanvas(eventKey as string, matchKey as string);
        return serverDoc ? mergeCanvasDocs(serverDoc, localDoc) : localDoc;
      } catch (err) {
        // Offline: serve the local doc. Online server error: rethrow so the
        // persisted snapshot is preserved (mirrors useMatchupNotes).
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          return localDoc;
        }
        throw err;
      }
    },
  });
}

/**
 * Persist the current doc locally (offline-first) and nudge the sync controller.
 * Resolves immediately; the server merge happens in strategyCanvasSync.ts.
 */
export async function saveStrategyCanvas(
  eventKey: string,
  matchKey: string,
  doc: CanvasDoc,
): Promise<void> {
  const record: LocalStrategyCanvas = {
    key: canvasKeyFor(eventKey, matchKey),
    eventKey,
    matchKey,
    strokes: doc.strokes,
    deletedIds: doc.deletedIds,
    updatedAt: new Date().toISOString(),
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
  };
  await saveStrategyCanvasLocal(record);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('scout-sync-changed'));
  }
}
