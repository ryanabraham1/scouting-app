// src/sync/pitOutbox.ts
//
// The pit-report sibling of outbox.ts. Drains the local pit outbox: for each
// queued report it uploads the pending photo (if any) to Supabase Storage, then
// upserts the row into `pit_scouting_report`. Re-running is safe — the upsert is
// keyed on (event_key, team_number), so a re-run is a no-op-equivalent overwrite.
import {
  getDuePitSyncQueue,
  markPitPending,
  markPitSynced,
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

async function uploadAndUpsert(rec: LocalPitReport): Promise<unknown> {
  let photos = [...rec.data.photos].sort((a, b) => a.order - b.order);
  const blobs = { ...(rec.photoBlobs ?? {}) };
  for (const photo of photos) {
    const blob = blobs[photo.id];
    if (!blob || photo.path) continue;
    const path = await uploadPitPhoto(rec.eventKey, rec.teamNumber, photo.id, blob);
    photos = photos.map((item) => item.id === photo.id ? { ...item, path } : item);
    delete blobs[photo.id];
    const recorded = await setPitUploadedPhoto(rec.draftKey, photo.id, path, rec.updatedAt);
    if (!recorded) {
      // The report changed or was removed while Storage was uploading. This
      // object was never attached to the current local row, so tombstone it
      // immediately; the cleanup worker still verifies local/server references
      // before deleting.
      await queuePitPhotoCleanup(path, rec.eventKey, rec.teamNumber);
      return Object.assign(
        new Error('Pit report changed while its photo was uploading; the orphan was queued for cleanup.'),
        { code: 'PIT_PHOTO_UPLOAD_RACE' },
      );
    }
  }
  const report = {
    ...rec.data,
    photos,
    photoPath: photos[0]?.path ?? null,
  };
  const revision = (rec.rowRevision ?? Date.parse(rec.updatedAt)) || Date.now();
  const { data, error } = await upsertPitRow(report, revision, rec.baseRevision ?? null);
  if (error) return error;
  if (data?.status === 'conflict' || data?.status === 'stale') {
    const currentRevision =
      data.current_revision == null ? '' : ` Server revision: ${data.current_revision}.`;
    return Object.assign(
      new Error(
        `This pit report changed on another device.${currentRevision} Local report preserved for recovery.`,
      ),
      { code: 'PIT_EDIT_CONFLICT' },
    );
  }
  if (data?.status !== 'applied' && data?.status !== 'idempotent') {
    return Object.assign(
      new Error('Pit report server returned an invalid sync status. Local report preserved.'),
      { code: 'PIT_SYNC_CONTRACT' },
    );
  }
  rec.data = report;
  rec.photoBlobs = blobs;
  return null;
}

export async function syncPitOnce(): Promise<PitSyncSummary> {
  const summary: PitSyncSummary = { attempted: 0, synced: 0, retried: 0, deadLettered: 0 };
  if (isSyncCircuitOpen()) return summary;
  const queue = await getDuePitSyncQueue();

  for (const rec of queue) {
    summary.attempted += 1;
    await markPitPending(rec.draftKey);

    let failure: unknown;
    let failed = false;
    try {
      const err = await uploadAndUpsert(rec);
      if (err != null) {
        failed = true;
        failure = err;
      }
    } catch (thrown) {
      failed = true;
      failure = thrown;
    }

    if (!failed) {
      await markPitSynced(rec.draftKey, rec.updatedAt);
      void queryClient.invalidateQueries({ queryKey: ['team-pit', rec.eventKey, rec.teamNumber] });
      void queryClient.invalidateQueries({ queryKey: ['event-pits', rec.eventKey] });
      void queryClient.invalidateQueries({ queryKey: ['team-photo', rec.eventKey, rec.teamNumber] });
      summary.synced += 1;
      continue;
    }

    const message = errorMessage(failure);

    // Pure network gap: requeue without burning an attempt, stop the drain
    // (the rest of the queue faces the same dead network). See outbox.ts.
    if (isNetworkFailure(failure)) {
      const nextSyncAt = Date.now() + retryDelayMs(failure, rec.syncAttempts ?? 0);
      await markPitDirtyRetry(rec.draftKey, message, {
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
      await markPitDirtyRetry(rec.draftKey, message, {
        uploadedUpdatedAt: rec.updatedAt,
        nextSyncAt,
      });
      openSyncCircuit(nextSyncAt);
      summary.retried += 1;
      break;
    } else {
      await markPitSyncError(rec.draftKey, message, rec.updatedAt);
      summary.deadLettered += 1;
    }
  }

  // Best-effort orphan cleanup. A failed remove remains a durable tombstone and
  // never changes the report sync result.
  await cleanupPitPhotoTombstones().catch(() => undefined);
  return summary;
}
