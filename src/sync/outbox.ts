// src/sync/outbox.ts
//
// The online outbox engine. Drains the local Dexie sync queue and uploads each
// report through the revision-guarded, idempotent `upsert_match_report` RPC.
// Re-uploading the same id+revision is a server no-op, so re-running syncOnce is
// safe (no duplicates). See phase3-contracts.md §1/§3/§4/§8/§9.
import { supabase } from '@/lib/supabase';
import {
  getSyncQueue,
  markPending,
  markSynced,
  markDirtyRetry,
  markSyncError,
} from '@/db/localStore';
import { toUpsertPayload } from '@/sync/mapReport';
import { classifySyncError, isNetworkFailure } from '@/sync/classifyError';
import { SYNC_MAX_ATTEMPTS } from '@/sync/constants';

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
) => Promise<{ error: unknown } | { error: null }>;

const defaultRpc: RpcFn = (fn, args) =>
  supabase.rpc(fn, args) as unknown as Promise<{ error: unknown } | { error: null }>;

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
 *   - transient AND syncAttempts < cap         → markDirtyRetry (back to queue)
 *   - terminal OR attempts >= cap              → markSyncError (dead-letter)
 */
export async function syncOnce(rpc: RpcFn = defaultRpc): Promise<SyncSummary> {
  const queue = await getSyncQueue();
  const summary: SyncSummary = { attempted: 0, synced: 0, retried: 0, deadLettered: 0 };

  for (const report of queue) {
    summary.attempted += 1;
    await markPending(report.id);

    let failure: unknown;
    let failed = false;
    try {
      const result = await rpc('upsert_match_report', { p: toUpsertPayload(report) });
      if (result && result.error != null) {
        failed = true;
        failure = result.error;
      }
    } catch (thrown) {
      failed = true;
      failure = thrown;
    }

    if (!failed) {
      await markSynced(report.id, report.rowRevision ?? 1);
      summary.synced += 1;
      continue;
    }

    const message = errorMessage(failure);

    // A pure network gap (no server verdict) is this app's normal operating
    // condition — it says nothing about the report. Requeue WITHOUT burning an
    // attempt toward the dead-letter cap, and stop the drain: every report
    // behind this one would hit the same dead network.
    if (isNetworkFailure(failure)) {
      await markDirtyRetry(report.id, message, { countAttempt: false });
      summary.retried += 1;
      break;
    }

    const kind = classifySyncError(failure);
    const attempts = report.syncAttempts ?? 0;

    if (kind === 'transient' && attempts < SYNC_MAX_ATTEMPTS) {
      await markDirtyRetry(report.id, message);
      summary.retried += 1;
    } else {
      // terminal, or a persistent transient that has hit the attempt cap.
      await markSyncError(report.id, message, report.rowRevision ?? 1);
      summary.deadLettered += 1;
    }
  }

  return summary;
}
