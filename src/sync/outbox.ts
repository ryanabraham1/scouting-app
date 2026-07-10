// src/sync/outbox.ts
//
// The online outbox engine. Drains the local Dexie sync queue and uploads each
// report through the revision-guarded, idempotent `upsert_match_report` RPC.
// Re-uploading the same id+revision is a server no-op, so re-running syncOnce is
// safe (no duplicates). See phase3-contracts.md §1/§3/§4/§8/§9.
import { supabase } from '@/lib/supabase';
import {
  getDueSyncQueue,
  markPending,
  markSynced,
  markDirtyRetry,
  markSyncError,
} from '@/db/localStore';
import { toUpsertPayload } from '@/sync/mapReport';
import { classifySyncError, isNetworkFailure } from '@/sync/classifyError';
import {
  isSyncCircuitOpen,
  openSyncCircuit,
  retryDelayMs,
} from '@/sync/retrySchedule';

export interface SyncSummary {
  attempted: number;
  synced: number;
  retried: number;
  deadLettered: number;
}

/**
 * supabase-js `.rpc()` resolves to `{ error }` for DB-level failures (a
 * PostgrestError or null) AND for transport/network failures (it catches fetch
 * rejections and resolves with `error: { message: "TypeError: Failed to
 * fetch", …, code: "" }`). The engine also tolerates a thrown rejection (custom
 * fetch / test fakes). Injectable so tests can supply a fake without a network.
 */
type RpcFn = (
  fn: string,
  args: { p: Record<string, unknown> },
) => Promise<{ data?: unknown; error: unknown }>;

const defaultRpc: RpcFn = (fn, args) =>
  supabase.rpc(fn, args) as unknown as Promise<{ data?: unknown; error: unknown }>;

interface MatchUpsertResult {
  status: 'applied' | 'idempotent' | 'stale' | 'conflict';
  current_revision: number;
}

function matchUpsertResult(value: unknown): MatchUpsertResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Partial<MatchUpsertResult>;
  if (
    !['applied', 'idempotent', 'stale', 'conflict'].includes(result.status ?? '') ||
    !Number.isSafeInteger(result.current_revision) ||
    (result.current_revision ?? 0) < 1
  ) {
    return null;
  }
  return result as MatchUpsertResult;
}

function conflictMessage(result: MatchUpsertResult): string {
  const label = result.status === 'stale' ? 'stale' : 'conflicted';
  return `Match report upload ${label} with server revision ${result.current_revision}. Local report preserved for recovery.`;
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

/**
 * Drain the sync queue once. For each report:
 *   - markPending (upload in flight)
 *   - call upsert_match_report; supabase returns `{ error }` for DB errors and
 *     throws for network failures — both routed through `classifySyncError`.
 *   - success                                  → markSynced
 *   - transient                                → markDirtyRetry and stop this drain
 *   - terminal                                 → markSyncError (dead-letter)
 */
export async function syncOnce(rpc: RpcFn = defaultRpc): Promise<SyncSummary> {
  const summary: SyncSummary = { attempted: 0, synced: 0, retried: 0, deadLettered: 0 };
  if (isSyncCircuitOpen()) return summary;
  const queue = await getDueSyncQueue();

  for (const report of queue) {
    summary.attempted += 1;
    await markPending(report.id);

    let failure: unknown;
    let failed = false;
    let verdict: MatchUpsertResult | null = null;
    try {
      const result = await rpc('upsert_match_report', { p: toUpsertPayload(report) });
      if (result && result.error != null) {
        failed = true;
        failure = result.error;
      } else {
        verdict = matchUpsertResult(result?.data);
        if (!verdict) {
          failed = true;
          failure = Object.assign(
            new Error('Match report server returned an invalid sync status. Local report preserved.'),
            { code: 'MATCH_SYNC_CONTRACT' },
          );
        }
      }
    } catch (thrown) {
      failed = true;
      failure = thrown;
    }

    if (!failed && verdict && ['applied', 'idempotent'].includes(verdict.status)) {
      await markSynced(report.id, report.rowRevision ?? 1);
      summary.synced += 1;
      continue;
    }
    if (!failed && verdict && ['stale', 'conflict'].includes(verdict.status)) {
      await markSyncError(
        report.id,
        conflictMessage(verdict),
        report.rowRevision ?? 1,
      );
      summary.deadLettered += 1;
      continue;
    }

    const message = errorMessage(failure);

    // A pure network gap (no server verdict) is this app's normal operating
    // condition — it says nothing about the report. Requeue WITHOUT burning an
    // attempt toward the dead-letter cap, and stop the drain: every report
    // behind this one would hit the same dead network.
    if (isNetworkFailure(failure)) {
      const nextSyncAt = Date.now() + retryDelayMs(failure, report.syncAttempts ?? 0);
      await markDirtyRetry(report.id, message, {
        countAttempt: false,
        uploadedRevision: report.rowRevision ?? 1,
        nextSyncAt,
      });
      openSyncCircuit(nextSyncAt);
      summary.retried += 1;
      break;
    }

    const kind = classifySyncError(failure);
    if (kind === 'transient') {
      const nextSyncAt = Date.now() + retryDelayMs(failure, report.syncAttempts ?? 0);
      await markDirtyRetry(report.id, message, {
        uploadedRevision: report.rowRevision ?? 1,
        nextSyncAt,
      });
      openSyncCircuit(nextSyncAt);
      summary.retried += 1;
      // A shared 429/5xx outage applies to the queue, not this payload. Stop
      // after one probe so a server incident cannot burn every row.
      break;
    } else {
      await markSyncError(report.id, message, report.rowRevision ?? 1);
      summary.deadLettered += 1;
    }
  }

  return summary;
}
