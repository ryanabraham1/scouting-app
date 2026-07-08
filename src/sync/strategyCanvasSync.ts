// src/sync/strategyCanvasSync.ts
//
// The strategy-whiteboard sibling of matchupNotesSync.ts. Drains the local
// whiteboard outbox through the merge-upsert `upsert_strategy_canvas` RPC
// (migration 0042). The RPC merges strokes by id + unions erase tombstones, so
// a re-send is idempotent and two devices editing the same match are additive —
// there is no stale-clobber failure mode to guard beyond the usual retry logic.
import { supabase } from '@/lib/supabase';
import {
  getStrategyCanvasSyncQueue,
  markStrategyCanvasPending,
  markStrategyCanvasSynced,
  markStrategyCanvasDirtyRetry,
  markStrategyCanvasSyncError,
} from '@/db/localStore';
import type { LocalStrategyCanvas } from '@/db/types';
import { classifySyncError, isNetworkFailure } from '@/sync/classifyError';
import { SYNC_MAX_ATTEMPTS } from '@/sync/constants';

export interface StrategyCanvasSyncSummary {
  attempted: number;
  synced: number;
  retried: number;
  deadLettered: number;
}

function errorMessage(err: unknown): string {
  if (err == null) return 'unknown sync error';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    if (typeof e.message === 'string') return e.message;
    if (typeof e.code === 'string') return e.code;
    if (typeof e.code === 'number') return String(e.code);
  }
  return 'unknown sync error';
}

/** Build the snake_case wire shape the `upsert_strategy_canvas` RPC expects. */
function canvasPayload(rec: LocalStrategyCanvas): Record<string, unknown> {
  const revision = Date.parse(rec.updatedAt) || Date.now();
  return {
    event_key: rec.eventKey,
    match_key: rec.matchKey,
    strokes: rec.strokes,
    deleted_ids: rec.deletedIds,
    row_revision: revision,
  };
}

export async function syncStrategyCanvasOnce(): Promise<StrategyCanvasSyncSummary> {
  const queue = await getStrategyCanvasSyncQueue();
  const summary: StrategyCanvasSyncSummary = {
    attempted: 0,
    synced: 0,
    retried: 0,
    deadLettered: 0,
  };

  for (const rec of queue) {
    summary.attempted += 1;
    await markStrategyCanvasPending(rec.key);

    let failure: unknown;
    let failed = false;
    try {
      const { error } = await supabase.rpc('upsert_strategy_canvas', {
        p: canvasPayload(rec),
      });
      if (error != null) {
        failed = true;
        failure = error;
      }
    } catch (thrown) {
      failed = true;
      failure = thrown;
    }

    if (!failed) {
      await markStrategyCanvasSynced(rec.key, rec.updatedAt);
      summary.synced += 1;
      continue;
    }

    const message = errorMessage(failure);

    // Pure network gap: requeue without burning an attempt, stop the drain
    // (the rest of the queue faces the same dead network). See outbox.ts.
    if (isNetworkFailure(failure)) {
      await markStrategyCanvasDirtyRetry(rec.key, message, { countAttempt: false });
      summary.retried += 1;
      break;
    }

    const kind = classifySyncError(failure);
    const attempts = rec.syncAttempts ?? 0;

    if (kind === 'transient' && attempts < SYNC_MAX_ATTEMPTS) {
      await markStrategyCanvasDirtyRetry(rec.key, message);
      summary.retried += 1;
    } else {
      await markStrategyCanvasSyncError(rec.key, message, rec.updatedAt);
      summary.deadLettered += 1;
    }
  }

  return summary;
}
