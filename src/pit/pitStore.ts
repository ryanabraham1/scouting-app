import Dexie, { type Table } from 'dexie';
import { supabase } from '@/lib/supabase';
import { isAuthClassError } from '@/sync/classifyError';

export interface PitReport {
  eventKey: string;
  teamNumber: number;
  drivetrain: string;
  // Selected mechanism keys plus any free-text "other" entries, all in one list.
  mechanisms: string[];
  capabilities: string[];
  intakeSources: string[];
  // Vision system, free-text (e.g. "Limelight 3", "PhotonVision", "none").
  visionSystem: string;
  // Battery / charger inventory. Counts are null until entered.
  batteryCount: number | null;
  chargerCount: number | null;
  batteryBrand: string;
  batteryConnector: string;
  // Preferred auto routine — same {x,y} normalized shape as match reports, so the
  // dashboard can draw it on the FieldDiagram.
  preferredAutoStartPosition: { x: number; y: number } | null;
  preferredAutoPath: { x: number; y: number }[] | null;
  // Preferred match strategy keys (score / feed / defend / …).
  matchStrategy: string[];
  // Robot dimensions in inches (null until entered) + trench-pass capability.
  robotLengthIn: number | null;
  robotWidthIn: number | null;
  robotHeightIn: number | null;
  trenchCapable: boolean;
  photoPath: string | null;
  notes: string;
  scoutId: string;
}

export interface PitDraft {
  draftKey: string;
  eventKey: string;
  teamNumber: number;
  updatedAt: string;
  data: PitReport;
  // A photo chosen offline is held as raw bytes in the draft until it can be
  // uploaded at sync time (Supabase Storage needs the network). `photoPath`
  // stays null on the report until the blob is uploaded.
  photoBlob?: Blob | null;
}

// A pit report that has been SUBMITTED and is queued for upload. Mirrors the
// match-report sync-state machine (dirty/pending/synced/error) so pit reports
// survive a dead venue network exactly like match reports do. Keyed by the same
// `eventKey:teamNumber` draftKey — one report per team per event.
export type PitSyncState = 'dirty' | 'pending' | 'synced' | 'error';

export interface LocalPitReport {
  draftKey: string;
  eventKey: string;
  teamNumber: number;
  data: PitReport;
  // Pending photo bytes to upload before the row upsert. Cleared once uploaded.
  photoBlob?: Blob | null;
  syncState: PitSyncState;
  syncAttempts: number;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

class PitDb extends Dexie {
  pitDrafts!: Table<PitDraft, string>;
  pitReports!: Table<LocalPitReport, string>;

  constructor() {
    super('pit-scouting-db');
    this.version(1).stores({
      pitDrafts: 'draftKey',
    });
    // v2: add the submitted-report outbox so pit reports queue locally and sync
    // through the same online/offline edge as match reports.
    this.version(2).stores({
      pitDrafts: 'draftKey',
      pitReports: 'draftKey, syncState',
    });
  }
}

export const pitDb = new PitDb();

function pitDraftKey(eventKey: string, teamNumber: number): string {
  return eventKey + ':' + teamNumber;
}

export async function savePitDraft(
  eventKey: string,
  teamNumber: number,
  data: PitReport,
  photoBlob?: Blob | null
): Promise<void> {
  const draft: PitDraft = {
    draftKey: pitDraftKey(eventKey, teamNumber),
    eventKey,
    teamNumber,
    updatedAt: new Date().toISOString(),
    data,
    photoBlob: photoBlob ?? null,
  };
  await pitDb.pitDrafts.put(draft);
}

export async function getPitDraft(
  eventKey: string,
  teamNumber: number
): Promise<PitDraft | undefined> {
  return pitDb.pitDrafts.get(pitDraftKey(eventKey, teamNumber));
}

export async function deletePitDraft(eventKey: string, teamNumber: number): Promise<void> {
  await pitDb.pitDrafts.delete(pitDraftKey(eventKey, teamNumber));
}

// The snake_case wire shape for `upsert_pit_report`. `pit_scouting_report` has
// no `intake_sources` column — `capabilities` is a jsonb column, so the capability
// list and intake sources are folded into one object:
// { items: string[], intakeSources: string[] }.
//
// `rowRevision` is the report's local updatedAt epoch-ms: a monotonic-with-edit-time
// value that is comparable ACROSS authors (unlike a per-author counter). The server
// (migration 0031) writes only when it's STRICTLY NEWER than the stored revision, so
// a stale offline resync can no longer clobber a newer report.
export function pitUpsertPayload(
  report: PitReport,
  rowRevision: number,
): Record<string, unknown> {
  return {
    event_key: report.eventKey,
    team_number: report.teamNumber,
    drivetrain: report.drivetrain,
    mechanisms: report.mechanisms,
    capabilities: {
      items: report.capabilities,
      intakeSources: report.intakeSources,
    },
    vision_system: report.visionSystem,
    batteries: {
      count: report.batteryCount,
      chargers: report.chargerCount,
      brand: report.batteryBrand,
      connector: report.batteryConnector,
    },
    preferred_auto_start_position: report.preferredAutoStartPosition,
    preferred_auto_path: report.preferredAutoPath,
    match_strategy: report.matchStrategy,
    robot_dimensions: {
      lengthIn: report.robotLengthIn,
      widthIn: report.robotWidthIn,
      heightIn: report.robotHeightIn,
      trenchCapable: report.trenchCapable,
    },
    photo_path: report.photoPath,
    notes: report.notes,
    author_scout_id: report.scoutId,
    row_revision: rowRevision,
  };
}

// Upsert the row through the revision-guarded `upsert_pit_report` RPC, returning the
// raw Supabase error (or null) WITHOUT throwing so the outbox can classify it
// (transient vs terminal). `submitPit` wraps this and throws for its callers/tests.
// `rowRevision` defaults to "now" for direct submits; the outbox passes the queued
// report's updatedAt epoch so a stale resync stays older than a newer write.
export async function upsertPitRow(
  report: PitReport,
  rowRevision: number = Date.now(),
): Promise<{ error: unknown }> {
  const { error } = await supabase.rpc('upsert_pit_report', {
    p: pitUpsertPayload(report, rowRevision),
  });
  return { error };
}

export async function submitPit(report: PitReport): Promise<void> {
  const { error } = await upsertPitRow(report);
  if (error) {
    throw new Error((error as { message?: string }).message ?? 'pit upsert failed');
  }
}

// --- Offline outbox: submitted pit reports queued for upload ----------------

// Enqueue a submitted report to the local outbox as 'dirty'. The matching draft
// is removed — the queued report now owns the data. Idempotent per team/event:
// re-submitting overwrites the same draftKey row (one pit report per team).
export async function enqueuePitReport(
  report: PitReport,
  photoBlob?: Blob | null
): Promise<void> {
  const draftKey = pitDraftKey(report.eventKey, report.teamNumber);
  const now = new Date().toISOString();
  const existing = await pitDb.pitReports.get(draftKey);
  const record: LocalPitReport = {
    draftKey,
    eventKey: report.eventKey,
    teamNumber: report.teamNumber,
    data: report,
    photoBlob: photoBlob ?? null,
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await pitDb.pitReports.put(record);
  await deletePitDraft(report.eventKey, report.teamNumber);
}

function withPitDefaults(r: LocalPitReport): LocalPitReport {
  return {
    ...r,
    syncAttempts: r.syncAttempts ?? 0,
    lastSyncError: r.lastSyncError ?? null,
  };
}

// Auto-retry worklist: dirty + pending, oldest first; EXCLUDES 'error'/'synced'.
export async function getPitSyncQueue(): Promise<LocalPitReport[]> {
  const all = await pitDb.pitReports.toArray();
  return all
    .filter((r) => r.syncState === 'dirty' || r.syncState === 'pending')
    .map(withPitDefaults)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listPitDeadLetters(): Promise<LocalPitReport[]> {
  const all = await pitDb.pitReports.toArray();
  return all.filter((r) => r.syncState === 'error').map(withPitDefaults);
}

export async function markPitPending(draftKey: string): Promise<void> {
  await pitDb.pitReports.update(draftKey, { syncState: 'pending' });
}

// Record a freshly-uploaded photo path and drop the pending blob. Called right
// after the Storage upload succeeds so a later transient upsert retry does not
// re-upload the photo (which would orphan the first object). When
// `uploadedUpdatedAt` is given the write applies ONLY if the report wasn't
// re-submitted mid-upload — a re-submit may carry a NEW photo blob, which this
// must not destroy.
export async function setPitUploadedPhoto(
  draftKey: string,
  photoPath: string,
  uploadedUpdatedAt?: string,
): Promise<void> {
  const existing = await pitDb.pitReports.get(draftKey);
  if (!existing) return;
  if (uploadedUpdatedAt != null && existing.updatedAt !== uploadedUpdatedAt) return;
  await pitDb.pitReports.update(draftKey, {
    photoBlob: null,
    data: { ...existing.data, photoPath },
  });
}

// Success: record the (now-uploaded) photo path and drop the pending blob. The
// `uploadedUpdatedAt` guard mirrors markSynced for match reports: if the report
// was re-submitted while this upload was in flight (updatedAt rewritten,
// re-dirtied, possibly a new photo blob), the stale upload's success must not
// mark it synced or clobber the new submission's data/blob.
export async function markPitSynced(
  draftKey: string,
  photoPath: string | null,
  uploadedUpdatedAt?: string,
): Promise<void> {
  const existing = await pitDb.pitReports.get(draftKey);
  if (!existing) return;
  if (uploadedUpdatedAt != null && existing.updatedAt !== uploadedUpdatedAt) return;
  await pitDb.pitReports.update(draftKey, {
    syncState: 'synced',
    syncAttempts: 0,
    photoBlob: null,
    lastSyncError: null,
    data: { ...existing.data, photoPath },
  });
}

export async function markPitDirtyRetry(
  draftKey: string,
  message: string,
  opts?: { countAttempt?: boolean },
): Promise<void> {
  const existing = await pitDb.pitReports.get(draftKey);
  const bump = opts?.countAttempt === false ? 0 : 1;
  const attempts = (existing?.syncAttempts ?? 0) + bump;
  await pitDb.pitReports.update(draftKey, {
    syncState: 'dirty',
    syncAttempts: attempts,
    lastSyncError: message,
  });
}

export async function markPitSyncError(
  draftKey: string,
  message: string,
  uploadedUpdatedAt?: string,
): Promise<void> {
  const existing = await pitDb.pitReports.get(draftKey);
  if (!existing) return;
  // A stale upload's terminal verdict must not dead-letter a newer re-submit.
  if (uploadedUpdatedAt != null && existing.updatedAt !== uploadedUpdatedAt) return;
  await pitDb.pitReports.update(draftKey, { syncState: 'error', lastSyncError: message });
}

// Reset a pit dead-letter to 'dirty' for a manual retry.
export async function requeuePitReport(draftKey: string): Promise<void> {
  await pitDb.pitReports.update(draftKey, {
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
  });
}

// Permanently drop a pit report from the local outbox — the recovery path for a
// dead-letter that can never sync (e.g. one bound to a since-deleted event).
export async function deletePitReport(draftKey: string): Promise<void> {
  await pitDb.pitReports.delete(draftKey);
}

/**
 * Requeue ONLY auth/RLS-class pit dead-letters back to 'dirty' — the pit-write
 * RLS fix (migration 0021) makes the wrongly-terminal 42501-class failures
 * succeed now. Mirrors requeueAuthClassDeadLetters for match reports (the pit
 * path had no equivalent, so pit reports that dead-lettered before 0021 stayed
 * stuck forever). Validation-class dead-letters are left alone. Returns the count.
 */
export async function requeueAuthClassPitDeadLetters(): Promise<number> {
  const dead = await listPitDeadLetters();
  const targets = dead.filter((r) => isAuthClassError(r.lastSyncError));
  for (const r of targets) {
    await requeuePitReport(r.draftKey);
  }
  return targets.length;
}
