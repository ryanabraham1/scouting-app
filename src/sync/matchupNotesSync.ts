// src/sync/matchupNotesSync.ts
//
// The matchup-note sibling of pitOutbox.ts. Drains the local matchup-note outbox
// through the revision-guarded `upsert_matchup_note` RPC (migration 0033). The RPC
// writes only when strictly newer (row_revision = local updatedAt epoch-ms), so a
// stale resync can never clobber a newer note and a re-send is idempotent.
import { supabase } from '@/lib/supabase';
import {
  getDueMatchupSyncQueue,
  markMatchupPending,
  markMatchupSynced,
  markMatchupDirtyRetry,
  markMatchupSyncError,
} from '@/db/localStore';
import type { LocalMatchupNote } from '@/db/types';
import { classifySyncError, isNetworkFailure } from '@/sync/classifyError';
import { queryClient } from '@/lib/queryPersist';
import {
  isSyncCircuitOpen,
  openSyncCircuit,
  retryDelayMs,
} from '@/sync/retrySchedule';

export interface MatchupSyncSummary {
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

function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    if (typeof code === 'number') return String(code);
  }
  return 'MATCHUP_NOTE_SYNC_ERROR';
}

/** Build the snake_case wire shape the `upsert_matchup_note` RPC expects. */
function notePayload(rec: LocalMatchupNote): Record<string, unknown> {
  // Revision = this note's local updatedAt epoch-ms (monotonic with edit time,
  // comparable across authors) — same scheme as upsert_pit_report.
  const revision = Date.parse(rec.updatedAt) || Date.now();
  return {
    event_key: rec.eventKey,
    our_team: rec.ourTeam,
    opp_team: rec.oppTeam,
    note: rec.note,
    row_revision: revision,
    author_scout_id: rec.authorScoutId,
  };
}

export async function syncMatchupNotesOnce(): Promise<MatchupSyncSummary> {
  const summary: MatchupSyncSummary = { attempted: 0, synced: 0, retried: 0, deadLettered: 0 };
  if (isSyncCircuitOpen()) return summary;
  const queue = await getDueMatchupSyncQueue();

  for (const rec of queue) {
    summary.attempted += 1;
    await markMatchupPending(rec.key);

    let failure: unknown;
    let failed = false;
    let conflictRevision: number | null = null;
    try {
      const { data, error } = await supabase.rpc('upsert_matchup_note', { p: notePayload(rec) });
      if (error != null) {
        failed = true;
        failure = error;
      } else {
        const result = data as {
          status?: 'applied' | 'stale' | 'conflict';
          current_revision?: number | null;
        } | null;
        if (result?.status === 'stale' || result?.status === 'conflict') {
          failed = true;
          conflictRevision = result.current_revision ?? null;
          failure = Object.assign(
            new Error(
              `This matchup note changed on another device (server revision ${
                result.current_revision ?? 'unknown'
              }). Your local note was preserved for review.`,
            ),
            { code: 'MATCHUP_NOTE_CONFLICT' },
          );
        } else if (result?.status !== 'applied') {
          failed = true;
          failure = Object.assign(
            new Error('The matchup note server returned an invalid sync result.'),
            { code: 'MATCHUP_NOTE_INVALID_RESULT' },
          );
        }
      }
    } catch (thrown) {
      failed = true;
      failure = thrown;
    }

    if (!failed) {
      await markMatchupSynced(rec.key, rec.updatedAt);
      void queryClient.invalidateQueries({ queryKey: ['matchup-notes', rec.eventKey] });
      summary.synced += 1;
      continue;
    }

    const message = errorMessage(failure);

    // Pure network gap: requeue without burning an attempt, stop the drain
    // (the rest of the queue faces the same dead network). See outbox.ts.
    if (isNetworkFailure(failure)) {
      const nextSyncAt = Date.now() + retryDelayMs(failure, rec.syncAttempts ?? 0);
      await markMatchupDirtyRetry(rec.key, message, {
        countAttempt: false,
        uploadedUpdatedAt: rec.updatedAt,
        nextSyncAt,
      });
      openSyncCircuit(nextSyncAt);
      summary.retried += 1;
      break;
    }

    const kind = classifySyncError(failure);
    if (kind === 'transient') {
      const nextSyncAt = Date.now() + retryDelayMs(failure, rec.syncAttempts ?? 0);
      await markMatchupDirtyRetry(rec.key, message, {
        uploadedUpdatedAt: rec.updatedAt,
        nextSyncAt,
      });
      openSyncCircuit(nextSyncAt);
      summary.retried += 1;
      break;
    } else {
      await markMatchupSyncError(
        rec.key,
        message,
        rec.updatedAt,
        conflictRevision !== null || errorCode(failure) === 'MATCHUP_NOTE_CONFLICT'
          ? {
              kind: 'conflict',
              code: 'MATCHUP_NOTE_CONFLICT',
              detectedAt: new Date().toISOString(),
              serverRevision: conflictRevision,
            }
          : {
              kind: 'terminal',
              code: errorCode(failure),
              detectedAt: new Date().toISOString(),
            },
      );
      summary.deadLettered += 1;
    }
  }

  return summary;
}
