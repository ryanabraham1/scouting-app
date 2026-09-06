// src/sync/pitOutbox.ts
//
// The pit-report sibling of outbox.ts. Drains the local pit outbox: for each
// queued report it uploads the pending photo (if any) to Supabase Storage, then
// upserts the row into `pit_scouting_report`. Re-running is safe — the upsert is
// keyed on (event_key, team_number), so a re-run is a no-op-equivalent overwrite.
import {
  getDuePitSyncQueue,
  getPitReport,
  markPitPending,
  completePitSync,
  rebasePitAfterPredecessorConflict,
  discardPitPredecessorAttempt,
  markPitDirtyRetry,
  markPitSyncError,
  setPitUploadedPhoto,
  queuePitPhotoCleanup,
  upsertPitRow,
  type LocalPitReport,
} from '@/pit/pitStore';
import { cleanupPitPhotoTombstones, uploadPitPhoto } from '@/pit/photoUpload';
import { classifySyncError, isNetworkFailure } from '@/sync/classifyError';
import { queryClient } from '@/lib/queryPersist';
import {
  isSyncCircuitOpen,
  openSyncCircuit,
  retryDelayMs,
} from '@/sync/retrySchedule';

export interface PitSyncSummary {
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

function numericHttpStatus(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
}

/** Whether a returned RPC error authoritatively proves the transaction did not commit. */
function postRpcDefinitivelyNotWritten(failure: unknown): boolean {
  if (isNetworkFailure(failure)) return false;
  if (classifySyncError(failure) === 'terminal') return true;
  if (!failure || typeof failure !== 'object') return false;

  const error = failure as { status?: unknown; code?: unknown };
  const status = numericHttpStatus(error.status) ?? numericHttpStatus(error.code);
  // HTTP timeout, rate-limit, server, and gateway responses can be generated
  // after the upstream RPC committed but before its response reached us.
  if (status === 408 || status === 429 || (status != null && status >= 500)) return false;

  // Remaining transient errors with a concrete DB/PostgREST code (for example
  // serialization failure or lock-not-available) are authoritative rollbacks.
  return typeof error.code === 'string' && error.code.length > 0;
}

async function uploadAndUpsert(
  rec: LocalPitReport,
  expectedRevision: number,
): Promise<
  | { ok: true; acknowledgedRevision: number }
  | {
      ok: false;
      failure: unknown;
      conflictRevision?: number;
      definitivelyNotWritten: boolean;
    }
> {
  let rpcStarted = false;
  try {
  let photos = [...rec.data.photos].sort((a, b) => a.order - b.order);
  const blobs = { ...(rec.photoBlobs ?? {}) };
  for (const photo of photos) {
    const blob = blobs[photo.id];
    if (!blob || photo.path) continue;
    const path = await uploadPitPhoto(rec.eventKey, rec.teamNumber, photo.id, blob);
    photos = photos.map((item) => item.id === photo.id ? { ...item, path } : item);
    delete blobs[photo.id];
    const recorded = await setPitUploadedPhoto(
      rec.draftKey,
      photo.id,
      path,
      expectedRevision,
    );
    if (!recorded) {
      // The report changed or was removed while Storage was uploading. This
      // object was never attached to the current local row, so tombstone it
      // immediately; the cleanup worker still verifies local/server references
      // before deleting.
      await queuePitPhotoCleanup(path, rec.eventKey, rec.teamNumber);
      return {
        ok: false,
        definitivelyNotWritten: true,
        failure: Object.assign(
          new Error('Pit report changed while its photo was uploading; the orphan was queued for cleanup.'),
          { code: 'PIT_PHOTO_UPLOAD_RACE' },
        ),
      };
    }
  }
  const report = {
    ...rec.data,
    photos,
    photoPath: photos[0]?.path ?? null,
  };
  const current = await getPitReport(rec.eventKey, rec.teamNumber);
  if (current?.rowRevision !== expectedRevision) {
    return {
      ok: false,
      definitivelyNotWritten: true,
      failure: Object.assign(
        new Error('Pit report was re-submitted before its previous upload could be sent.'),
        { code: 'PIT_UPLOAD_SUPERSEDED' },
      ),
    };
  }
  rpcStarted = true;
  const { data, error } = await upsertPitRow(
    report,
    expectedRevision,
    rec.baseRevision ?? null,
  );
  if (error) {
    return {
      ok: false,
      failure: error,
      // Retain evidence for ambiguous post-invocation transport/HTTP outcomes;
      // prune only authoritative validation/auth/rollback verdicts.
      definitivelyNotWritten: postRpcDefinitivelyNotWritten(error),
    };
  }
  if (data?.status === 'conflict' || data?.status === 'stale') {
    const parsedRevision = Number(data.current_revision);
    const currentRevision =
      data.current_revision == null ? '' : ` Server revision: ${data.current_revision}.`;
    return {
      ok: false,
      definitivelyNotWritten: true,
      failure: Object.assign(
        new Error(
          `This pit report changed on another device.${currentRevision} Local report preserved for recovery.`,
        ),
        { code: 'PIT_EDIT_CONFLICT' },
      ),
      conflictRevision:
        Number.isSafeInteger(parsedRevision) && parsedRevision > 0
          ? parsedRevision
          : undefined,
    };
  }
  if (data?.status !== 'applied' && data?.status !== 'idempotent') {
    return {
      ok: false,
      // An unrecognized success body cannot prove whether the RPC committed.
      // Preserve the attempt for conservative conflict recovery.
      definitivelyNotWritten: false,
      failure: Object.assign(
        new Error('Pit report server returned an invalid sync status. Local report preserved.'),
        { code: 'PIT_SYNC_CONTRACT' },
      ),
    };
  }
  rec.data = report;
  rec.photoBlobs = blobs;
  const serverRevision = Number(data.current_revision);
  return {
    ok: true,
    acknowledgedRevision:
      Number.isSafeInteger(serverRevision) && serverRevision > 0
        ? serverRevision
        : expectedRevision,
  };
  } catch (failure) {
    return {
      ok: false,
      failure,
      // Before invocation there is no possible server write. Once invoked, a
      // thrown transport/parser failure is ambiguous unless it carries an
      // authoritative validation/auth/rollback verdict.
      definitivelyNotWritten:
        !rpcStarted || postRpcDefinitivelyNotWritten(failure),
    };
  }
}

export async function syncPitOnce(): Promise<PitSyncSummary> {
  const summary: PitSyncSummary = { attempted: 0, synced: 0, retried: 0, deadLettered: 0 };
  if (isSyncCircuitOpen()) return summary;
  const queue = await getDuePitSyncQueue();

  for (const rec of queue) {
    const expectedRevision =
      rec.rowRevision ?? (Date.parse(rec.updatedAt) || 1);
    const claimed = await markPitPending(rec.draftKey, expectedRevision);
    if (!claimed) continue;
    summary.attempted += 1;

    let failure: unknown;
    let failed = false;
    let acknowledgedRevision = expectedRevision;
    let conflictRevision: number | undefined;
    let definitivelyNotWritten = false;
    try {
      const result = await uploadAndUpsert(rec, expectedRevision);
      if (!result.ok) {
        failed = true;
        failure = result.failure;
        conflictRevision = result.conflictRevision;
        definitivelyNotWritten = result.definitivelyNotWritten;
      } else {
        acknowledgedRevision = result.acknowledgedRevision;
      }
    } catch (thrown) {
      failed = true;
      failure = thrown;
    }

    if (!failed) {
      const completion = await completePitSync(
        rec.draftKey,
        expectedRevision,
        rec.baseRevision ?? null,
        acknowledgedRevision,
      );
      void queryClient.invalidateQueries({ queryKey: ['team-pit', rec.eventKey, rec.teamNumber] });
      void queryClient.invalidateQueries({ queryKey: ['event-pits', rec.eventKey] });
      void queryClient.invalidateQueries({ queryKey: ['team-photo', rec.eventKey, rec.teamNumber] });
      if (completion === 'synced') summary.synced += 1;
      continue;
    }

    const message = errorMessage(failure);

    if (
      conflictRevision != null &&
      await rebasePitAfterPredecessorConflict(
        rec.draftKey,
        expectedRevision,
        rec.baseRevision ?? null,
        conflictRevision,
      )
    ) {
      summary.retried += 1;
      continue;
    }

    if (definitivelyNotWritten) {
      // This exact attempt cannot be allowed to survive in a replacement row's
      // predecessor ledger. Otherwise a later, unrelated server row with the
      // same numeric revision could be mistaken for our failed predecessor.
      await discardPitPredecessorAttempt(
        rec.draftKey,
        expectedRevision,
        rec.baseRevision ?? null,
      );
    }

    // Pure network gap: requeue without burning an attempt, stop the drain
    // (the rest of the queue faces the same dead network). See outbox.ts.
    if (isNetworkFailure(failure)) {
      const nextSyncAt = Date.now() + retryDelayMs(failure, rec.syncAttempts ?? 0);
      const markedRetry = await markPitDirtyRetry(rec.draftKey, message, {
        countAttempt: false,
        expectedRevision,
        nextSyncAt,
      });
      openSyncCircuit(nextSyncAt);
      if (markedRetry) summary.retried += 1;
      break;
    }

    const kind = classifySyncError(failure);
    if (kind === 'transient') {
      const nextSyncAt = Date.now() + retryDelayMs(failure, rec.syncAttempts ?? 0);
      const markedRetry = await markPitDirtyRetry(rec.draftKey, message, {
        expectedRevision,
        nextSyncAt,
      });
      openSyncCircuit(nextSyncAt);
      if (markedRetry) summary.retried += 1;
      break;
    } else {
      const markedError = await markPitSyncError(
        rec.draftKey,
        message,
        expectedRevision,
      );
      if (markedError) summary.deadLettered += 1;
    }
  }

  // Best-effort orphan cleanup. A failed remove remains a durable tombstone and
  // never changes the report sync result.
  await cleanupPitPhotoTombstones().catch(() => undefined);
  return summary;
}
