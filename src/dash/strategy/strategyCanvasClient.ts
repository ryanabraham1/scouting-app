// src/dash/strategy/strategyCanvasClient.ts
// Client helpers for the per-match strategy whiteboards (Strategy tab).
//
// Since 0043 a match carries FIVE boards — one per game phase (auto /
// transition / active / inactive / endgame) — and the auto board additionally
// persists draggable robot start squares. `match_key` may also be the literal
// '__manual__' for a schedule-less session (manually entered teams), which
// still cloud-syncs (the match FK was dropped in 0043).
//
// Reads come straight from PostgREST (`strategy_canvas` open read) merged with
// the Dexie-local doc so unsynced strokes show immediately. Writes go to Dexie
// 'dirty' (offline-first) and drain through the sync controller via
// strategyCanvasSync.ts (mirrors matchupNotesClient.ts).

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { saveStrategyCanvasLocal, getStrategyCanvasLocal } from '@/db/localStore';
import type { StrategyCanvasRow, LocalStrategyCanvas } from '@/db/types';
import {
  parseCanvasDoc,
  mergeCanvasDocs,
  EMPTY_DOC,
  type CanvasDoc,
  type WhiteboardPhase,
} from '@/dash/strategy/strokes';

/** The match_key used for schedule-less (manually entered teams) boards. */
export const MANUAL_MATCH_KEY = '__manual__';

/** Dexie/local key for one whiteboard doc. */
export function canvasKeyFor(eventKey: string, matchKey: string, phase: WhiteboardPhase): string {
  return `${eventKey}:${matchKey}:${phase}`;
}

/** Server select of one board (null when none exists yet). */
export async function fetchStrategyCanvas(
  eventKey: string,
  matchKey: string,
  phase: WhiteboardPhase,
): Promise<CanvasDoc | null> {
  const { data, error } = await supabase
    .from('strategy_canvas')
    .select('event_key,match_key,phase,strokes,deleted_ids,robots,row_revision,updated_at')
    .eq('event_key', eventKey)
    .eq('match_key', matchKey)
    .eq('phase', phase)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as StrategyCanvasRow;
  return parseCanvasDoc(row.strokes, row.deleted_ids, row.robots);
}

/**
 * The whiteboard doc for one (event, match, phase): server row merged with the
 * Dexie local doc (stroke-id union + tombstones + newer-robot-wins — the same
 * merge the RPC applies), so unsynced local ink always shows and a remote
 * device's changes fold in. Offline: Dexie-only fallback. queryKey
 * `['strategy-canvas', eventKey, matchKey, phase]` — useEventLiveSync's
 * realtime branch invalidates it when another device saves.
 */
export function useStrategyCanvas(
  eventKey: string | null,
  matchKey: string | null,
  phase: WhiteboardPhase,
): UseQueryResult<CanvasDoc> {
  return useQuery({
    queryKey: ['strategy-canvas', eventKey, matchKey, phase],
    enabled: !!eventKey && !!matchKey,
    staleTime: 15_000,
    queryFn: async (): Promise<CanvasDoc> => {
      const local = await getStrategyCanvasLocal(
        canvasKeyFor(eventKey as string, matchKey as string, phase),
      );
      const localDoc: CanvasDoc = local
        ? { strokes: local.strokes, deletedIds: local.deletedIds, robots: local.robots ?? [] }
        : EMPTY_DOC;
      try {
        const serverDoc = await fetchStrategyCanvas(
          eventKey as string,
          matchKey as string,
          phase,
        );
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
  phase: WhiteboardPhase,
  doc: CanvasDoc,
): Promise<void> {
  const record: LocalStrategyCanvas = {
    key: canvasKeyFor(eventKey, matchKey, phase),
    eventKey,
    matchKey,
    phase,
    strokes: doc.strokes,
    deletedIds: doc.deletedIds,
    robots: doc.robots ?? [],
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
