import Dexie, { type Table } from 'dexie';
import { supabase } from '@/lib/supabase';
import { isAuthClassError } from '@/sync/classifyError';

export interface PitPhoto {
  id: string;
  path: string | null;
  order: number;
  mimeType: string | null;
  width: number | null;
  height: number | null;
}

export type PitPhotoBlobs = Record<string, Blob>;

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
  photos: PitPhoto[];
  /** First photo path retained for compatibility with pre-multi-photo consumers. */
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
  photoBlobs?: PitPhotoBlobs;
  baseRevision?: number | null;
  // Legacy v2 field, migrated to photoBlobs on read.
  photoBlob?: Blob | null;
}

export interface PitQuarantinedRecord {
  id: string;
  source: 'draft' | 'report';
  originalKey: string;
  eventKey: string | null;
  teamNumber: number | null;
  reason: string;
  quarantinedAt: string;
  raw: unknown;
}

export interface PitPhotoCleanup {
  path: string;
  eventKey: string;
  teamNumber: number;
  attempts: number;
  lastError: string | null;
  createdAt: string;
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
  photoBlobs?: PitPhotoBlobs;
  baseRevision?: number | null;
  rowRevision?: number;
  // Legacy v2 field, migrated to photoBlobs on read.
  photoBlob?: Blob | null;
  syncState: PitSyncState;
  syncAttempts: number;
  lastSyncError: string | null;
  nextSyncAt?: number | null;
  createdAt: string;
  updatedAt: string;
}

class PitDb extends Dexie {
  pitDrafts!: Table<PitDraft, string>;
  pitReports!: Table<LocalPitReport, string>;
  pitQuarantine!: Table<PitQuarantinedRecord, string>;
  pitPhotoCleanup!: Table<PitPhotoCleanup, string>;

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
    this.version(3).stores({
      pitDrafts: 'draftKey',
      pitReports: 'draftKey, syncState',
      pitQuarantine: 'id, source, eventKey, quarantinedAt',
      pitPhotoCleanup: 'path, eventKey, teamNumber, createdAt',
    });
  }
}

export const pitDb = new PitDb();

function pitDraftKey(eventKey: string, teamNumber: number): string {
  return eventKey + ':' + teamNumber;
}

export const PIT_NUMERIC_LIMITS = {
  batteryCount: 99,
  chargerCount: 99,
  dimensionIn: 120,
  teamNumber: 99_999,
} as const;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function persistedReportProblem(value: unknown): string | null {
  const data = recordValue(value);
  if (!data) return 'Stored pit report data is not an object.';
  if (typeof data.eventKey !== 'string' || !data.eventKey) return 'Stored event key is missing.';
  if (
    typeof data.teamNumber !== 'number' ||
    !Number.isSafeInteger(data.teamNumber) ||
    data.teamNumber <= 0 ||
    data.teamNumber > PIT_NUMERIC_LIMITS.teamNumber
  ) return 'Stored team number is invalid.';
  if (typeof data.scoutId !== 'string') return 'Stored scout identity is invalid.';
  for (const [field, max] of [
    ['batteryCount', PIT_NUMERIC_LIMITS.batteryCount],
    ['chargerCount', PIT_NUMERIC_LIMITS.chargerCount],
    ['robotLengthIn', PIT_NUMERIC_LIMITS.dimensionIn],
    ['robotWidthIn', PIT_NUMERIC_LIMITS.dimensionIn],
    ['robotHeightIn', PIT_NUMERIC_LIMITS.dimensionIn],
  ] as const) {
    const number = data[field];
    if (
      number != null &&
      (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > max)
    ) return `Stored ${field} is outside its safe range.`;
  }
  const pointIsFinite = (point: unknown): boolean => {
    const p = recordValue(point);
    return Boolean(
      p &&
      typeof p.x === 'number' &&
      Number.isFinite(p.x) &&
      typeof p.y === 'number' &&
      Number.isFinite(p.y),
    );
  };
  if (data.preferredAutoStartPosition != null && !pointIsFinite(data.preferredAutoStartPosition)) {
    return 'Stored preferred-auto start is malformed.';
  }
  if (
    data.preferredAutoPath != null &&
    (!Array.isArray(data.preferredAutoPath) || !data.preferredAutoPath.every(pointIsFinite))
  ) return 'Stored preferred-auto path is malformed.';
  return null;
}

async function quarantinePitRecord(
  source: 'draft' | 'report',
  originalKey: string,
  raw: unknown,
  reason: string,
): Promise<void> {
  const value = recordValue(raw);
  const data = recordValue(value?.data);
  const eventKey =
    typeof value?.eventKey === 'string'
      ? value.eventKey
      : typeof data?.eventKey === 'string'
        ? data.eventKey
        : null;
  const teamNumber =
    typeof value?.teamNumber === 'number' && Number.isFinite(value.teamNumber)
      ? value.teamNumber
      : typeof data?.teamNumber === 'number' && Number.isFinite(data.teamNumber)
        ? data.teamNumber
        : null;
  const quarantinedAt = new Date().toISOString();
  const id = `${source}:${quarantinedAt}:${originalKey}`;
  await pitDb.transaction(
    'rw',
    pitDb.pitDrafts,
    pitDb.pitReports,
    pitDb.pitQuarantine,
    async () => {
      await pitDb.pitQuarantine.put({
        id,
        source,
        originalKey,
        eventKey,
        teamNumber,
        reason,
        quarantinedAt,
        raw,
      });
      if (source === 'draft') await pitDb.pitDrafts.delete(originalKey);
      else await pitDb.pitReports.delete(originalKey);
    },
  );
}

function referencedPaths(data: PitReport): string[] {
  return normalizePhotos(data).photos
    .map((photo) => photo.path)
    .filter((path): path is string => Boolean(path));
}

async function queueRemovedPaths(
  previous: PitReport | undefined,
  next: PitReport | undefined,
): Promise<void> {
  if (!previous) return;
  const keep = new Set(next ? referencedPaths(next) : []);
  const now = new Date().toISOString();
  for (const path of referencedPaths(previous)) {
    if (keep.has(path)) continue;
    await pitDb.pitPhotoCleanup.put({
      path,
      eventKey: previous.eventKey,
      teamNumber: previous.teamNumber,
      attempts: 0,
      lastError: null,
      createdAt: now,
    });
  }
}

function normalizePhotos(data: PitReport, legacyBlob?: Blob | null): PitReport {
  const photos =
    Array.isArray(data.photos) && data.photos.length > 0
      ? data.photos
          .map((photo, index) => ({
            id: photo.id || `legacy-${index}`,
            path: photo.path ?? null,
            order: Number.isFinite(photo.order) ? photo.order : index,
            mimeType: photo.mimeType ?? null,
            width: photo.width ?? null,
            height: photo.height ?? null,
          }))
          .sort((a, b) => a.order - b.order)
      : data.photoPath || legacyBlob
        ? [{
            id: 'legacy',
            path: data.photoPath ?? null,
            order: 0,
            mimeType: legacyBlob?.type || null,
            width: null,
            height: null,
          }]
        : [];
  return { ...data, photos, photoPath: photos[0]?.path ?? null };
}

function normalizeBlobInput(
  value?: PitPhotoBlobs | Blob | null,
  legacyBlob?: Blob | null,
): PitPhotoBlobs {
  if (value instanceof Blob) return { legacy: value };
  if (value && typeof value === 'object') return value as PitPhotoBlobs;
  return legacyBlob ? { legacy: legacyBlob } : {};
}

export async function savePitDraft(
  eventKey: string,
  teamNumber: number,
  data: PitReport,
  photoBlobs?: PitPhotoBlobs | Blob | null,
  baseRevision?: number | null,
): Promise<void> {
  const problem = persistedReportProblem(data);
  if (problem) throw new Error(problem);
  const normalized = normalizePhotos(data, photoBlobs instanceof Blob ? photoBlobs : null);
  const draft: PitDraft = {
    draftKey: pitDraftKey(eventKey, teamNumber),
    eventKey,
    teamNumber,
    updatedAt: new Date().toISOString(),
    data: normalized,
    photoBlobs: normalizeBlobInput(photoBlobs),
    baseRevision: baseRevision ?? null,
  };
  await pitDb.transaction('rw', pitDb.pitDrafts, pitDb.pitPhotoCleanup, async () => {
    const previous = await pitDb.pitDrafts.get(draft.draftKey);
    if (previous && !persistedReportProblem(previous.data)) {
      await queueRemovedPaths(previous.data, normalized);
    }
    await pitDb.pitDrafts.put(draft);
  });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pit-local-changed'));
}

export async function getPitDraft(
  eventKey: string,
  teamNumber: number
): Promise<PitDraft | undefined> {
  const draft = await pitDb.pitDrafts.get(pitDraftKey(eventKey, teamNumber));
  if (!draft) return undefined;
  const problem = persistedReportProblem(draft.data);
  if (problem) {
    await quarantinePitRecord('draft', draft.draftKey, draft, problem);
    return undefined;
  }
  return {
    ...draft,
    data: normalizePhotos(draft.data, draft.photoBlob),
    photoBlobs: normalizeBlobInput(draft.photoBlobs, draft.photoBlob),
    baseRevision: draft.baseRevision ?? null,
  };
}

export async function deletePitDraft(eventKey: string, teamNumber: number): Promise<void> {
  const key = pitDraftKey(eventKey, teamNumber);
  await pitDb.transaction('rw', pitDb.pitDrafts, pitDb.pitPhotoCleanup, async () => {
    const previous = await pitDb.pitDrafts.get(key);
    if (previous && !persistedReportProblem(previous.data)) {
      await queueRemovedPaths(previous.data, undefined);
    }
    await pitDb.pitDrafts.delete(key);
  });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pit-local-changed'));
}

export async function listPitDraftsForEvent(eventKey: string): Promise<PitDraft[]> {
  const drafts = await pitDb.pitDrafts.toArray();
  const valid: PitDraft[] = [];
  for (const draft of drafts) {
    const problem = persistedReportProblem(draft.data);
    if (problem) {
      await quarantinePitRecord('draft', draft.draftKey, draft, problem);
      continue;
    }
    if (draft.eventKey !== eventKey) continue;
    valid.push({
      ...draft,
      data: normalizePhotos(draft.data, draft.photoBlob),
      photoBlobs: normalizeBlobInput(draft.photoBlobs, draft.photoBlob),
      baseRevision: draft.baseRevision ?? null,
    });
  }
  return valid;
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
  baseRevision?: number | null,
): Record<string, unknown> {
  const photos = normalizePhotos(report).photos.map((photo, index) => ({
    id: photo.id,
    path: photo.path,
    order: index,
    mimeType: photo.mimeType,
    width: photo.width,
    height: photo.height,
  }));
  const payload: Record<string, unknown> = {
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
    photos,
    photo_path: photos[0]?.path ?? null,
    notes: report.notes,
    author_scout_id: report.scoutId,
    row_revision: rowRevision,
  };
  if (baseRevision !== undefined) payload.base_revision = baseRevision;
  return payload;
}

export interface PitUpsertResult {
  status: 'applied' | 'idempotent' | 'conflict' | 'stale';
  revision?: number;
  current_revision?: number | null;
  idempotent?: boolean;
}

// Upsert the row through the revision-guarded `upsert_pit_report` RPC, returning the
// raw Supabase error (or null) WITHOUT throwing so the outbox can classify it
// (transient vs terminal). `submitPit` wraps this and throws for its callers/tests.
// `rowRevision` defaults to "now" for direct submits; the outbox passes the queued
// report's updatedAt epoch so a stale resync stays older than a newer write.
export async function upsertPitRow(
  report: PitReport,
  rowRevision: number = Date.now(),
  baseRevision?: number | null,
): Promise<{ data: PitUpsertResult | null; error: unknown }> {
  const { data, error } = await supabase.rpc('upsert_pit_report', {
    p: pitUpsertPayload(report, rowRevision, baseRevision),
  });
  return { data: (data as PitUpsertResult | null) ?? null, error };
}

export async function submitPit(report: PitReport): Promise<void> {
  const { data, error } = await upsertPitRow(report);
  if (error) {
    throw new Error((error as { message?: string }).message ?? 'pit upsert failed');
  }
  if (data?.status === 'conflict' || data?.status === 'stale') {
    throw new Error('pit report edit conflict');
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function pitReportFromRow(
  row: Record<string, unknown>,
  scoutId: string,
): { report: PitReport; revision: number } {
  const capabilities = objectValue(row.capabilities);
  const batteries = objectValue(row.batteries);
  const dimensions = objectValue(row.robot_dimensions);
  const rawPhotos = Array.isArray(row.photos) ? row.photos : [];
  const photos: PitPhoto[] = rawPhotos
    .map((value, index) => {
      const photo = objectValue(value);
      return {
        id: typeof photo.id === 'string' && photo.id ? photo.id : `legacy-${index}`,
        path: typeof photo.path === 'string' && photo.path ? photo.path : null,
        order: finiteOrNull(photo.order) ?? index,
        mimeType: typeof photo.mimeType === 'string' ? photo.mimeType : null,
        width: finiteOrNull(photo.width),
        height: finiteOrNull(photo.height),
      };
    })
    .sort((a, b) => a.order - b.order);
  if (photos.length === 0 && typeof row.photo_path === 'string' && row.photo_path) {
    photos.push({
      id: 'legacy',
      path: row.photo_path,
      order: 0,
      mimeType: null,
      width: null,
      height: null,
    });
  }
  return {
    report: {
      eventKey: String(row.event_key ?? ''),
      teamNumber: Number(row.team_number),
      drivetrain: typeof row.drivetrain === 'string' ? row.drivetrain : '',
      mechanisms: Array.isArray(row.mechanisms) ? row.mechanisms as string[] : [],
      capabilities: Array.isArray(capabilities.items)
        ? capabilities.items as string[]
        : Array.isArray(row.capabilities)
          ? row.capabilities as string[]
          : [],
      intakeSources: Array.isArray(capabilities.intakeSources)
        ? capabilities.intakeSources as string[]
        : [],
      visionSystem: typeof row.vision_system === 'string' ? row.vision_system : '',
      batteryCount: finiteOrNull(batteries.count),
      chargerCount: finiteOrNull(batteries.chargers),
      batteryBrand: typeof batteries.brand === 'string' ? batteries.brand : '',
      batteryConnector: typeof batteries.connector === 'string' ? batteries.connector : '',
      preferredAutoStartPosition:
        row.preferred_auto_start_position &&
        typeof row.preferred_auto_start_position === 'object'
          ? row.preferred_auto_start_position as { x: number; y: number }
          : null,
      preferredAutoPath: Array.isArray(row.preferred_auto_path)
        ? row.preferred_auto_path as Array<{ x: number; y: number }>
        : null,
      matchStrategy: Array.isArray(row.match_strategy) ? row.match_strategy as string[] : [],
      robotLengthIn: finiteOrNull(dimensions.lengthIn),
      robotWidthIn: finiteOrNull(dimensions.widthIn),
      robotHeightIn: finiteOrNull(dimensions.heightIn),
      trenchCapable: dimensions.trenchCapable === true,
      photos,
      photoPath: photos[0]?.path ?? null,
      notes: typeof row.notes === 'string' ? row.notes : '',
      scoutId,
    },
    revision: Number(row.row_revision) || 1,
  };
}

export async function fetchPitReportForEdit(
  eventKey: string,
  teamNumber: number,
  scoutId: string,
): Promise<{ report: PitReport; revision: number } | null> {
  const { data, error } = await supabase
    .from('pit_scouting_report')
    .select('*')
    .eq('event_key', eventKey)
    .eq('team_number', teamNumber)
    .eq('deleted', false)
    .maybeSingle();
  if (error) throw error;
  return data ? pitReportFromRow(data as Record<string, unknown>, scoutId) : null;
}

// --- Offline outbox: submitted pit reports queued for upload ----------------

// Enqueue a submitted report to the local outbox as 'dirty'. The matching draft
// is removed — the queued report now owns the data. Idempotent per team/event:
// re-submitting overwrites the same draftKey row (one pit report per team).
export async function enqueuePitReport(
  report: PitReport,
  photoBlobs?: PitPhotoBlobs | Blob | null,
  baseRevision?: number | null,
): Promise<void> {
  const problem = persistedReportProblem(report);
  if (problem) throw new Error(problem);
  const draftKey = pitDraftKey(report.eventKey, report.teamNumber);
  const now = new Date().toISOString();
  const existing = await pitDb.pitReports.get(draftKey);
  const effectiveBase =
    baseRevision !== undefined
      ? baseRevision
      : existing?.syncState === 'synced'
        ? existing.rowRevision ?? null
        : existing?.baseRevision ?? null;
  const rowRevision = Math.max(Date.now(), (effectiveBase ?? 0) + 1);
  const record: LocalPitReport = {
    draftKey,
    eventKey: report.eventKey,
    teamNumber: report.teamNumber,
    data: normalizePhotos(report, photoBlobs instanceof Blob ? photoBlobs : null),
    photoBlobs: normalizeBlobInput(photoBlobs),
    baseRevision: effectiveBase,
    rowRevision,
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await pitDb.transaction(
    'rw',
    pitDb.pitReports,
    pitDb.pitDrafts,
    pitDb.pitPhotoCleanup,
    async () => {
    const draft = await pitDb.pitDrafts.get(draftKey);
    const priorData =
      existing && !persistedReportProblem(existing.data)
        ? existing.data
        : draft && !persistedReportProblem(draft.data)
          ? draft.data
          : undefined;
    await queueRemovedPaths(priorData, record.data);
    await pitDb.pitReports.put(record);
    await pitDb.pitDrafts.delete(draftKey);
    },
  );
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pit-local-changed'));
}

function withPitDefaults(r: LocalPitReport): LocalPitReport {
  return {
    ...r,
    data: normalizePhotos(r.data, r.photoBlob),
    photoBlobs: normalizeBlobInput(r.photoBlobs, r.photoBlob),
    baseRevision: r.baseRevision ?? null,
    rowRevision: (r.rowRevision ?? Date.parse(r.updatedAt)) || 1,
    syncAttempts: r.syncAttempts ?? 0,
    lastSyncError: r.lastSyncError ?? null,
    nextSyncAt: r.nextSyncAt ?? null,
  };
}

export async function getPitReport(
  eventKey: string,
  teamNumber: number,
): Promise<LocalPitReport | undefined> {
  const report = await pitDb.pitReports.get(pitDraftKey(eventKey, teamNumber));
  if (report) {
    const problem = persistedReportProblem(report.data);
    if (problem) {
      await quarantinePitRecord('report', report.draftKey, report, problem);
      return undefined;
    }
  }
  return report ? withPitDefaults(report) : undefined;
}

export async function listPitReportsForEvent(eventKey: string): Promise<LocalPitReport[]> {
  const reports = await pitDb.pitReports.toArray();
  const valid: LocalPitReport[] = [];
  for (const report of reports) {
    const problem = persistedReportProblem(report.data);
    if (problem) {
      await quarantinePitRecord('report', report.draftKey, report, problem);
      continue;
    }
    if (report.eventKey === eventKey) valid.push(withPitDefaults(report));
  }
  return valid;
}

// Auto-retry worklist: dirty + pending, oldest first; EXCLUDES 'error'/'synced'.
export async function getPitSyncQueue(): Promise<LocalPitReport[]> {
  const all = await pitDb.pitReports.toArray();
  const valid: LocalPitReport[] = [];
  for (const report of all) {
    const problem = persistedReportProblem(report.data);
    if (problem) {
      await quarantinePitRecord('report', report.draftKey, report, problem);
      continue;
    }
    valid.push(report);
  }
  return valid
    .filter((r) => r.syncState === 'dirty' || r.syncState === 'pending')
    .map(withPitDefaults)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getDuePitSyncQueue(now = Date.now()): Promise<LocalPitReport[]> {
  return (await getPitSyncQueue()).filter((r) => (r.nextSyncAt ?? 0) <= now);
}

export async function listPitDeadLetters(): Promise<LocalPitReport[]> {
  const all = await pitDb.pitReports.toArray();
  return all.filter((r) => r.syncState === 'error').map(withPitDefaults);
}

export async function markPitPending(draftKey: string): Promise<void> {
  await pitDb.pitReports.update(draftKey, { syncState: 'pending', nextSyncAt: null });
}

// Record a freshly-uploaded photo path and drop the pending blob. Called right
// after the Storage upload succeeds so a later transient upsert retry does not
// re-upload the photo (which would orphan the first object). When
// `uploadedUpdatedAt` is given the write applies ONLY if the report wasn't
// re-submitted mid-upload — a re-submit may carry a NEW photo blob, which this
// must not destroy.
export async function setPitUploadedPhoto(
  draftKey: string,
  photoId: string,
  photoPath: string,
  uploadedUpdatedAt?: string,
): Promise<boolean> {
  const existing = await pitDb.pitReports.get(draftKey);
  if (!existing) return false;
  if (uploadedUpdatedAt != null && existing.updatedAt !== uploadedUpdatedAt) return false;
  const report = withPitDefaults(existing);
  const photos = report.data.photos.map((photo) =>
    photo.id === photoId ? { ...photo, path: photoPath } : photo,
  );
  const photoBlobs = { ...(report.photoBlobs ?? {}) };
  delete photoBlobs[photoId];
  await pitDb.pitReports.update(draftKey, {
    photoBlob: null,
    photoBlobs,
    data: {
      ...report.data,
      photos,
      photoPath: photos.sort((a, b) => a.order - b.order)[0]?.path ?? null,
    },
  });
  return true;
}

// Success: record the (now-uploaded) photo path and drop the pending blob. The
// `uploadedUpdatedAt` guard mirrors markSynced for match reports: if the report
// was re-submitted while this upload was in flight (updatedAt rewritten,
// re-dirtied, possibly a new photo blob), the stale upload's success must not
// mark it synced or clobber the new submission's data/blob.
export async function markPitSynced(
  draftKey: string,
  uploadedUpdatedAt?: string,
): Promise<void> {
  await pitDb.pitReports
    .where('draftKey')
    .equals(draftKey)
    .and(
      (record) =>
        uploadedUpdatedAt == null || record.updatedAt === uploadedUpdatedAt,
    )
    .modify((record) => {
      record.syncState = 'synced';
      record.syncAttempts = 0;
      record.photoBlob = null;
      record.photoBlobs = {};
      record.baseRevision =
        (record.rowRevision ?? Date.parse(record.updatedAt)) || 1;
      record.lastSyncError = null;
      record.nextSyncAt = null;
    });
}

export async function markPitDirtyRetry(
  draftKey: string,
  message: string,
  opts?: { countAttempt?: boolean; uploadedUpdatedAt?: string; nextSyncAt?: number },
): Promise<void> {
  const bump = opts?.countAttempt === false ? 0 : 1;
  await pitDb.pitReports
    .where('draftKey')
    .equals(draftKey)
    .and(
      (record) =>
        opts?.uploadedUpdatedAt == null ||
        record.updatedAt === opts.uploadedUpdatedAt,
    )
    .modify((record) => {
      record.syncState = 'dirty';
      record.syncAttempts = (record.syncAttempts ?? 0) + bump;
      record.lastSyncError = message;
      record.nextSyncAt = opts?.nextSyncAt ?? null;
    });
}

export async function markPitSyncError(
  draftKey: string,
  message: string,
  uploadedUpdatedAt?: string,
): Promise<void> {
  // A stale upload's terminal verdict must not dead-letter a newer re-submit.
  await pitDb.pitReports
    .where('draftKey')
    .equals(draftKey)
    .and(
      (record) =>
        uploadedUpdatedAt == null || record.updatedAt === uploadedUpdatedAt,
    )
    .modify({
      syncState: 'error',
      lastSyncError: message,
      nextSyncAt: null,
    });
}

// Reset a pit dead-letter to 'dirty' for a manual retry.
export async function requeuePitReport(draftKey: string): Promise<void> {
  await pitDb.pitReports.update(draftKey, {
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
    nextSyncAt: null,
  });
}

// Permanently drop a pit report from the local outbox — the recovery path for a
// dead-letter that can never sync (e.g. one bound to a since-deleted event).
export async function deletePitReport(draftKey: string): Promise<void> {
  await pitDb.transaction('rw', pitDb.pitReports, pitDb.pitPhotoCleanup, async () => {
    const previous = await pitDb.pitReports.get(draftKey);
    if (previous && !persistedReportProblem(previous.data)) {
      await queueRemovedPaths(previous.data, undefined);
    }
    await pitDb.pitReports.delete(draftKey);
  });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pit-local-changed'));
}

export async function listPitQuarantine(eventKey?: string): Promise<PitQuarantinedRecord[]> {
  const rows = await pitDb.pitQuarantine.toArray();
  return rows
    .filter((row) => !eventKey || row.eventKey === eventKey || row.eventKey == null)
    .sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt));
}

export async function deletePitQuarantine(id: string): Promise<void> {
  await pitDb.pitQuarantine.delete(id);
}

export async function listPitPhotoCleanup(): Promise<PitPhotoCleanup[]> {
  return pitDb.pitPhotoCleanup.orderBy('createdAt').toArray();
}

export async function markPitPhotoCleanupFailure(path: string, message: string): Promise<void> {
  await pitDb.pitPhotoCleanup
    .where('path')
    .equals(path)
    .modify((row) => {
      row.attempts = (row.attempts ?? 0) + 1;
      row.lastError = message;
    });
}

export async function completePitPhotoCleanup(path: string): Promise<void> {
  await pitDb.pitPhotoCleanup.delete(path);
}

export async function queuePitPhotoCleanup(
  path: string,
  eventKey: string,
  teamNumber: number,
): Promise<void> {
  await pitDb.pitPhotoCleanup.put({
    path,
    eventKey,
    teamNumber,
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
  });
}

export async function isPitPhotoReferencedLocally(path: string): Promise<boolean> {
  const [drafts, reports] = await Promise.all([
    pitDb.pitDrafts.toArray(),
    pitDb.pitReports.toArray(),
  ]);
  return [...drafts, ...reports].some((row) => {
    const data = recordValue((row as { data?: unknown }).data);
    if (!data) return false;
    const photos = Array.isArray(data.photos) ? data.photos : [];
    return (
      data.photoPath === path ||
      photos.some((photo) => recordValue(photo)?.path === path)
    );
  });
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
