// src/sync/pitOutbox.ts
//
// The pit-report sibling of outbox.ts. Drains the local pit outbox: for each
// queued report it uploads the pending photo (if any) to Supabase Storage, then
// upserts the row into `pit_scouting_report`. Re-running is safe — the upsert is
// keyed on (event_key, team_number), so a re-run is a no-op-equivalent overwrite.
import {
  getPitSyncQueue,
  markPitPending,
  markPitSynced,
  markPitDirtyRetry,
  markPitSyncError,
  setPitUploadedPhoto,
  upsertPitRow,
  type LocalPitReport,
} from '@/pit/pitStore';
import { uploadPitPhoto } from '@/pit/photoUpload';
import { classifySyncError } from '@/sync/classifyError';
import { SYNC_MAX_ATTEMPTS } from '@/sync/constants';

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
  // Upload a deferred photo first; on success carry the new storage path onto
  // the report so the row references it. A throw here (network) is classified
  // like any other transient/terminal failure by the caller.
  let report = rec.data;
  if (rec.photoBlob) {
    const path = await uploadPitPhoto(rec.eventKey, rec.teamNumber, rec.photoBlob);
    report = { ...report, photoPath: path };
    rec.photoBlob = null;
    // Persist the uploaded path immediately so a transient upsert retry reuses
    // it instead of re-uploading (which would orphan this object in Storage).
    await setPitUploadedPhoto(rec.draftKey, path);
  }
  // Revision = this report's local updatedAt epoch-ms, so a STALE queued report
  // (older edit) can never overwrite a newer one already on the server (0031).
  const revision = Date.parse(rec.updatedAt) || Date.now();
  const { error } = await upsertPitRow(report, revision);
  if (error) return error;
  // Stash the resolved path back so markPitSynced records it.
  rec.data = report;
  return null;
}

export async function syncPitOnce(): Promise<PitSyncSummary> {
  const queue = await getPitSyncQueue();
  const summary: PitSyncSummary = { attempted: 0, synced: 0, retried: 0, deadLettered: 0 };

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
      await markPitSynced(rec.draftKey, rec.data.photoPath);
      summary.synced += 1;
      continue;
    }

    const kind = classifySyncError(failure);
    const attempts = rec.syncAttempts ?? 0;
    const message = errorMessage(failure);

    if (kind === 'transient' && attempts < SYNC_MAX_ATTEMPTS) {
      await markPitDirtyRetry(rec.draftKey, message);
      summary.retried += 1;
    } else {
      await markPitSyncError(rec.draftKey, message);
      summary.deadLettered += 1;
    }
  }

  return summary;
}
