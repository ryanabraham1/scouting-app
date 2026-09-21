import { supabase } from '@/lib/supabase';
import {
  completePitPhotoCleanup,
  isPitPhotoReferencedLocally,
  listPitPhotoCleanup,
  markPitPhotoCleanupFailure,
} from './pitStore';

const BUCKET = 'pit-photos';

export async function uploadPitPhoto(
  eventKey: string,
  teamNumber: number,
  photoIdOrFile: string | Blob,
  maybeFile?: Blob,
): Promise<string> {
  // Immutable, client-generated identity: retries reuse the same object while
  // edits/replacements get a fresh path, so browser/CDN caches never show an old
  // image after a correction.
  const legacy = photoIdOrFile instanceof Blob;
  const file = legacy ? photoIdOrFile : maybeFile as Blob;
  const safeId = legacy ? '' : photoIdOrFile.replace(/[^a-zA-Z0-9_-]/g, '');
  const path = legacy
    ? `${eventKey}/${teamNumber}.jpg`
    : `${eventKey}/${teamNumber}/${safeId}.jpg`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type || 'image/jpeg' });
  if (error) {
    const raw = error as { status?: unknown; statusCode?: string | number };
    const status = Number(raw.status ?? raw.statusCode);
    // A prior partial attempt may already have uploaded this immutable object.
    if (status === 409 || /already exists|duplicate/i.test(error.message)) return path;
    // Keep the HTTP status ON the thrown error. The outbox classifies failures
    // by `.status` / `.code`; a bare `new Error(message)` used to erase it, so a
    // definitive 4xx from Storage (RLS denial, oversized object, bad bucket)
    // looked like an unknown transient and was retried forever — the report sat
    // at "queued to send" with no way to surface or self-heal. With the status
    // preserved a 403 dead-letters as auth-class (auto-requeued once a session
    // exists), a 413 dead-letters with a readable reason, and a 5xx / network
    // gap still retries.
    throw Object.assign(
      new Error(
        Number.isFinite(status) && status > 0
          ? `Photo upload failed (${status}): ${error.message}`
          : `Photo upload failed: ${error.message}`,
      ),
      Number.isFinite(status) && status > 0 ? { status } : {},
    );
  }
  return path;
}

export async function signedPitPhotoUrl(path: string): Promise<string | null> {
  // 7-day expiry: a URL signed while online Friday must still be fetchable on
  // Sunday — dashboards persist the query result across the whole competition
  // weekend and can't re-sign while offline.
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 60 * 60 * 24 * 7);
  if (error || !data) {
    return null;
  }
  return data.signedUrl;
}

function serverRowsReferencePath(rows: unknown, path: string): boolean {
  if (!Array.isArray(rows)) return false;
  return rows.some((value) => {
    if (!value || typeof value !== 'object') return false;
    const row = value as { photos?: unknown; photo_path?: unknown };
    if (row.photo_path === path) return true;
    return (
      Array.isArray(row.photos) &&
      row.photos.some(
        (photo) =>
          photo &&
          typeof photo === 'object' &&
          (photo as { path?: unknown }).path === path,
      )
    );
  });
}

/**
 * Delete only tombstoned Storage objects that no local draft/outbox row and no
 * current server pit report references. Failures remain durable tombstones and
 * are retried by later sync passes.
 */
export async function cleanupPitPhotoTombstones(): Promise<number> {
  const tombstones = await listPitPhotoCleanup();
  let removed = 0;
  for (const tombstone of tombstones) {
    try {
      if (await isPitPhotoReferencedLocally(tombstone.path)) continue;
      const { data, error } = await supabase
        .from('pit_scouting_report')
        .select('photos,photo_path')
        .eq('event_key', tombstone.eventKey)
        .eq('team_number', tombstone.teamNumber)
        .eq('deleted', false);
      if (error) throw error;
      if (serverRowsReferencePath(data, tombstone.path)) continue;
      const { error: removeError } = await supabase.storage
        .from(BUCKET)
        .remove([tombstone.path]);
      if (removeError) throw removeError;
      await completePitPhotoCleanup(tombstone.path);
      removed += 1;
    } catch (error) {
      await markPitPhotoCleanupFailure(
        tombstone.path,
        error instanceof Error
          ? error.message
          : String((error as { message?: unknown })?.message ?? 'photo cleanup failed'),
      );
    }
  }
  return removed;
}
