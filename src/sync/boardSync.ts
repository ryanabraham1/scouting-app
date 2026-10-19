// src/sync/boardSync.ts
//
// Ryan's Board outbox: drains dirty `boardRecords` rows through the
// `upsert_board_records` RPC (20261019120000). Sibling of strategyCanvasSync.ts
// (same error classification, circuit breaker and backoff) but BATCHED: one
// RPC per board carries up to BATCH_MAX records, since a single drag can touch
// dozens of shapes. The RPC is a per-record last-writer-wins merge by
// (rev, client_id), so re-sending is always safe and idempotent.
// Plan: docs/plans/ryans-board/README.md §8.2.
import { uploadBoardImage } from '@/dash/board/assets';
import { supabase } from '@/lib/supabase';
import {
  getDueBoardSyncQueue,
  markBoardRecordsError,
  markBoardRecordsPending,
  markBoardRecordsRetry,
  markBoardRecordsSynced,
} from '@/db/localStore';
import type { LocalBoardRecord } from '@/db/types';
import { classifySyncError, isNetworkFailure, isSharedOutage } from '@/sync/classifyError';
import { isSyncCircuitOpen, openSyncCircuit, retryDelayMs } from '@/sync/retrySchedule';

export interface BoardSyncSummary {
  attempted: number;
  synced: number;
  retried: number;
  deadLettered: number;
}

const BATCH_MAX = 200;
const BATCH_BYTES = 900_000;

function errorMessage(err: unknown): string {
  if (err == null) return 'unknown sync error';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    if (typeof e.message === 'string') return e.message;
    if (typeof e.code === 'string') return e.code;
  }
  return 'unknown sync error';
}

interface Verdict {
  ok: boolean;
  reason?: string;
  rejected: string[];
}

function parseVerdict(data: unknown): Verdict | null {
  if (!data || typeof data !== 'object') return null;
  const v = data as { ok?: unknown; reason?: unknown; rejected?: unknown };
  if (typeof v.ok !== 'boolean') return null;
  return {
    ok: v.ok,
    reason: typeof v.reason === 'string' ? v.reason : undefined,
    rejected: Array.isArray(v.rejected) ? v.rejected.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** Split one board's rows into RPC-sized batches. */
export function batchRows(rows: readonly LocalBoardRecord[]): LocalBoardRecord[][] {
  const out: LocalBoardRecord[][] = [];
  let cur: LocalBoardRecord[] = [];
  let bytes = 0;
  for (const r of rows) {
    const size = JSON.stringify(r.data ?? null).length;
    if (cur.length && (cur.length >= BATCH_MAX || bytes + size > BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function syncBoardOnce(): Promise<BoardSyncSummary> {
  const summary: BoardSyncSummary = { attempted: 0, synced: 0, retried: 0, deadLettered: 0 };
  if (isSyncCircuitOpen()) return summary;
  const queue = await getDueBoardSyncQueue();
  if (!queue.length) return summary;

  const byBoard = new Map<string, LocalBoardRecord[]>();
  for (const r of queue) {
    if (r.data == null) continue;
    const list = byBoard.get(r.boardKey) ?? [];
    list.push(r);
    byBoard.set(r.boardKey, list);
  }

  for (const [boardKey, rows] of byBoard) {
    for (const batch of batchRows(rows)) {
      summary.attempted += batch.length;
      const keys = batch.map((r) => r.key);
      await markBoardRecordsPending(keys);
      let failure: unknown = null;
      let verdict: Verdict | null = null;
      try {
        const records: unknown[] = [];
        for (const row of batch) records.push(await uploadBoardImage(boardKey, row.data));
        const { data, error } = await supabase.rpc('upsert_board_records', {
          p_board_key: boardKey,
          p_records: records,
        });
        if (error) failure = error;
        else {
          verdict = parseVerdict(data);
          if (!verdict) {
            failure = Object.assign(new Error('The board server returned an invalid sync result.'), {
              code: 'BOARD_SYNC_CONTRACT',
            });
          }
        }
      } catch (thrown) {
        failure = thrown ?? new Error('board sync failed');
      }

      if (!failure && verdict) {
        if (!verdict.ok) {
          // The whole board was refused (e.g. the event was deleted): keep the
          // rows locally as errors so nothing is silently lost.
          await markBoardRecordsError(keys, `The server did not save this board (${verdict.reason ?? 'rejected'}).`);
          summary.deadLettered += batch.length;
          continue;
        }
        const rejected = new Set(verdict.rejected);
        const bad = batch.filter((r) => rejected.has(r.recordId));
        const good = batch.filter((r) => !rejected.has(r.recordId));
        await markBoardRecordsSynced(good.map((r) => ({ key: r.key, updatedAt: r.updatedAt })));
        await markBoardRecordsError(
          bad.map((r) => r.key),
          'The server rejected this board item (too large or malformed).',
        );
        summary.synced += good.length;
        summary.deadLettered += bad.length;
        continue;
      }

      const message = errorMessage(failure);
      const attempts = Math.max(0, ...batch.map((r) => r.syncAttempts ?? 0));
      if (isNetworkFailure(failure)) {
        // A dead venue network is normal: don't count it, stop draining.
        const nextSyncAt = Date.now() + retryDelayMs(failure, attempts);
        await markBoardRecordsRetry(keys, message, nextSyncAt, false);
        openSyncCircuit(nextSyncAt);
        summary.retried += batch.length;
        return summary;
      }
      if (classifySyncError(failure) === 'transient') {
        const nextSyncAt = Date.now() + retryDelayMs(failure, attempts);
        await markBoardRecordsRetry(keys, message, nextSyncAt, true);
        summary.retried += batch.length;
        if (isSharedOutage(failure)) {
          openSyncCircuit(nextSyncAt);
          return summary;
        }
        continue;
      }
      await markBoardRecordsError(keys, message);
      summary.deadLettered += batch.length;
    }
  }
  return summary;
}
