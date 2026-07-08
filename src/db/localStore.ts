import Dexie, { type Table } from 'dexie';
import type {
  LocalMatchReport,
  CaptureDraft,
  CachedMatch,
  CachedAssignment,
  CachedRosterScouter,
  CachedTeam,
  PreloadMeta,
  LocalMatchupNote,
  LocalStrategyCanvas,
} from './types';
import {
  isAuthClassError,
  isSupersedeRecoverable,
  isOrphanedScoutRecoverable,
} from '@/sync/classifyError';

export class ScoutingDb extends Dexie {
  reports!: Table<LocalMatchReport, string>;
  drafts!: Table<CaptureDraft, string>;
  // Offline preload cache — pre-downloaded event data so the scout screens work
  // with zero wifi. See preloadClient.ts for the read/write helpers.
  cachedMatches!: Table<CachedMatch, string>;
  cachedAssignments!: Table<CachedAssignment, string>;
  cachedRoster!: Table<CachedRosterScouter, string>;
  cachedTeams!: Table<CachedTeam, string>;
  preloadMeta!: Table<PreloadMeta, string>;
  // Per-opponent matchup notes (matchup-intelligence). Queues + drains through
  // the sync controller exactly like `reports` (dirty → pending → synced/error).
  matchupNotes!: Table<LocalMatchupNote, string>;
  // Per-match strategy whiteboard docs (Strategy tab). Same sync-state machine.
  strategyCanvas!: Table<LocalStrategyCanvas, string>;

  constructor() {
    super('scouting-db');
    this.version(1).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
    });
    // v2: add the offline preload cache. Existing stores are redeclared
    // unchanged so Dexie keeps the upgrade chain intact.
    this.version(2).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
      cachedMatches: 'match_key, event_key',
      cachedAssignments: 'id, scout_id, event_key, match_key',
      cachedRoster: 'id, name',
      cachedTeams: 'id, event_key, team_number',
      preloadMeta: 'key',
    });
    // v3: add the matchup-notes outbox. ALL prior v2 stores are redeclared
    // unchanged so Dexie keeps the upgrade chain intact and existing reports/
    // drafts/preload rows survive the upgrade. (Version number is a hard
    // merge-gate — see the migration-safety test. If a sibling feature also
    // claims v3 with a different stores(), the loser MUST bump to v4+ and
    // redeclare all prior stores, or db.open() throws app-wide.)
    this.version(3).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
      cachedMatches: 'match_key, event_key',
      cachedAssignments: 'id, scout_id, event_key, match_key',
      cachedRoster: 'id, name',
      cachedTeams: 'id, event_key, team_number',
      preloadMeta: 'key',
      matchupNotes: 'key, eventKey, syncState, ourTeam, oppTeam',
    });
    // v4: add the strategy-whiteboard outbox. ALL prior v3 stores are redeclared
    // unchanged (same hard merge-gate rule as v3 — see the comment above).
    this.version(4).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
      cachedMatches: 'match_key, event_key',
      cachedAssignments: 'id, scout_id, event_key, match_key',
      cachedRoster: 'id, name',
      cachedTeams: 'id, event_key, team_number',
      preloadMeta: 'key',
      matchupNotes: 'key, eventKey, syncState, ourTeam, oppTeam',
      strategyCanvas: 'key, eventKey, syncState',
    });
  }
}

export const db = new ScoutingDb();

// Tolerate rows written before rowRevision/syncAttempts/lastSyncError existed.
function withSyncDefaults(r: LocalMatchReport): LocalMatchReport {
  return {
    ...r,
    rowRevision: r.rowRevision ?? 1,
    syncAttempts: r.syncAttempts ?? 0,
    lastSyncError: r.lastSyncError ?? null,
  };
}

export async function saveReport(r: LocalMatchReport): Promise<void> {
  const record: LocalMatchReport = { ...r, syncState: r.syncState ?? 'dirty' };
  await db.reports.put(record);
}

export async function listReports(): Promise<LocalMatchReport[]> {
  return db.reports.toArray();
}

// Single-report read for the edit/correction flow: returns the row with
// withSyncDefaults applied (so a legacy row missing rowRevision reads as 1).
export async function getReport(id: string): Promise<LocalMatchReport | undefined> {
  const r = await db.reports.get(id);
  return r ? withSyncDefaults(r) : undefined;
}

export async function getUnsynced(): Promise<LocalMatchReport[]> {
  const all = await db.reports.toArray();
  return all.filter((r) => r.syncState !== 'synced').map(withSyncDefaults);
}

export async function countUnsynced(): Promise<number> {
  const unsynced = await getUnsynced();
  return unsynced.length;
}

// Success. When `uploadedRevision` is given, the transition applies ONLY if the
// row still holds that revision — an edit made while the upload was in flight
// bumps rowRevision and re-dirties the row, and marking THAT synced would
// silently strand the newer revision locally forever (the server would keep the
// stale content). A successful upload also resets the attempt counter.
export async function markSynced(id: string, uploadedRevision?: number): Promise<void> {
  await db.reports
    .where('id')
    .equals(id)
    .and((r) => uploadedRevision == null || (r.rowRevision ?? 1) === uploadedRevision)
    .modify({ syncState: 'synced', syncAttempts: 0, lastSyncError: null });
}

// Upload in flight: set immediately before the RPC call.
export async function markPending(id: string): Promise<void> {
  await db.reports.update(id, { syncState: 'pending' });
}

// DEAD-LETTER: terminal failure; NOT auto-retried, surfaced in the UI. The same
// revision guard as markSynced: if the row was edited mid-flight, the verdict
// belongs to the STALE upload — leave the newer dirty revision queued instead of
// dead-lettering it unattempted.
export async function markSyncError(
  id: string,
  message: string,
  uploadedRevision?: number,
): Promise<void> {
  await db.reports
    .where('id')
    .equals(id)
    .and((r) => uploadedRevision == null || (r.rowRevision ?? 1) === uploadedRevision)
    .modify({ syncState: 'error', lastSyncError: message });
}

// Transient failure: back to the queue. Bumps the attempt counter (which feeds
// the SYNC_MAX_ATTEMPTS dead-letter cap) unless `countAttempt: false` — used for
// pure network gaps, which say nothing about the report itself.
export async function markDirtyRetry(
  id: string,
  message: string,
  opts?: { countAttempt?: boolean },
): Promise<void> {
  const existing = await db.reports.get(id);
  const bump = opts?.countAttempt === false ? 0 : 1;
  const attempts = (existing?.syncAttempts ?? 0) + bump;
  await db.reports.update(id, {
    syncState: 'dirty',
    syncAttempts: attempts,
    lastSyncError: message,
  });
}

// Auto-retry worklist: dirty + pending, oldest first; EXCLUDES 'error' and 'synced'.
export async function getSyncQueue(): Promise<LocalMatchReport[]> {
  const all = await db.reports.toArray();
  return all
    .filter((r) => r.syncState === 'dirty' || r.syncState === 'pending')
    .map(withSyncDefaults)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Dead-letters for the UI / manual retry.
export async function listDeadLetters(): Promise<LocalMatchReport[]> {
  const all = await db.reports.toArray();
  return all.filter((r) => r.syncState === 'error').map(withSyncDefaults);
}

// Requeue ONLY auth/RLS/ownership-class dead-letters (e.g. the old upsert
// ownership gate's 42501) back to 'dirty'. Validation-class dead-letters are left
// alone so a genuinely-bad report does not loop forever. Returns the number
// requeued so callers can avoid a no-op sync pass. Intended to run at most once
// per session (guarded by the caller) after a server-side RLS/RPC fix ships.
export async function requeueAuthClassDeadLetters(): Promise<number> {
  const dead = await listDeadLetters();
  // Auth/RLS-class (migration 0012) AND active-report-conflict-class (migration
  // 0025: upsert now supersedes instead of raising 23505) dead-letters are both
  // server-fix-recoverable — requeue them once. Validation-class stays dead.
  const targets = dead.filter(
    (r) =>
      isAuthClassError(r.lastSyncError) ||
      isSupersedeRecoverable(r.lastSyncError) ||
      // Orphaned scout_id (migration 0030: upsert now re-resolves by name).
      isOrphanedScoutRecoverable(r.lastSyncError),
  );
  for (const r of targets) {
    await requeueReport(r.id);
  }
  return targets.length;
}

// Reset a dead-letter to 'dirty' for a manual retry.
export async function requeueReport(id: string): Promise<void> {
  await db.reports.update(id, {
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
  });
}

// Permanently drop a report from the local outbox. The recovery path for a
// dead-letter that can NEVER sync — e.g. one bound to an event that has since
// been deleted (scout_event_key_fkey), where neither Retry nor a match/team fix
// can help. Removing it is the only way to clear the stuck badge.
export async function deleteReport(id: string): Promise<void> {
  await db.reports.delete(id);
}

export async function saveDraft(draftKey: string, state: unknown): Promise<void> {
  const draft: CaptureDraft = {
    draftKey,
    updatedAt: new Date().toISOString(),
    state,
  };
  await db.drafts.put(draft);
}

export async function getDraft(draftKey: string): Promise<CaptureDraft | undefined> {
  return db.drafts.get(draftKey);
}

export async function listDrafts(): Promise<CaptureDraft[]> {
  return db.drafts.toArray();
}

export async function deleteDraft(draftKey: string): Promise<void> {
  await db.drafts.delete(draftKey);
}

// ---------------------------------------------------------------------------
// Matchup notes outbox (matchup-intelligence).
//
// Mirrors the report queue's sync-state machine. A note is written 'dirty'
// before any network call (so an offline save always succeeds locally) and
// drains through `matchupNotesSync.ts` on the next online edge / poll / syncNow.
// ---------------------------------------------------------------------------

function withMatchupDefaults(r: LocalMatchupNote): LocalMatchupNote {
  return {
    ...r,
    authorScoutId: r.authorScoutId ?? null,
    syncAttempts: r.syncAttempts ?? 0,
    lastSyncError: r.lastSyncError ?? null,
  };
}

// Persist (upsert by key) a matchup note as 'dirty'. The full record is provided
// by the client layer (matchupNotesClient) which owns the key/normalization.
export async function saveMatchupNoteLocal(note: LocalMatchupNote): Promise<void> {
  await db.matchupNotes.put({ ...note, syncState: note.syncState ?? 'dirty' });
}

export async function getMatchupNote(key: string): Promise<LocalMatchupNote | undefined> {
  const r = await db.matchupNotes.get(key);
  return r ? withMatchupDefaults(r) : undefined;
}

export async function listMatchupNotesForEvent(eventKey: string): Promise<LocalMatchupNote[]> {
  const all = await db.matchupNotes.where('eventKey').equals(eventKey).toArray();
  return all.map(withMatchupDefaults);
}

// Auto-retry worklist: dirty + pending, oldest first; EXCLUDES 'error'/'synced'.
export async function getMatchupSyncQueue(): Promise<LocalMatchupNote[]> {
  const all = await db.matchupNotes.toArray();
  return all
    .filter((r) => r.syncState === 'dirty' || r.syncState === 'pending')
    .map(withMatchupDefaults)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

export async function listMatchupDeadLetters(): Promise<LocalMatchupNote[]> {
  const all = await db.matchupNotes.toArray();
  return all.filter((r) => r.syncState === 'error').map(withMatchupDefaults);
}

export async function markMatchupPending(key: string): Promise<void> {
  await db.matchupNotes.update(key, { syncState: 'pending' });
}

// Success/dead-letter guards mirror markSynced/markSyncError: when
// `uploadedUpdatedAt` is given, the transition applies only if the note wasn't
// edited while the upload was in flight (edits rewrite updatedAt + re-dirty),
// so a stale upload's verdict can never strand or dead-letter a newer edit.
export async function markMatchupSynced(key: string, uploadedUpdatedAt?: string): Promise<void> {
  await db.matchupNotes
    .where('key')
    .equals(key)
    .and((r) => uploadedUpdatedAt == null || r.updatedAt === uploadedUpdatedAt)
    .modify({ syncState: 'synced', syncAttempts: 0, lastSyncError: null });
}

export async function markMatchupDirtyRetry(
  key: string,
  message: string,
  opts?: { countAttempt?: boolean },
): Promise<void> {
  const existing = await db.matchupNotes.get(key);
  const bump = opts?.countAttempt === false ? 0 : 1;
  const attempts = (existing?.syncAttempts ?? 0) + bump;
  await db.matchupNotes.update(key, {
    syncState: 'dirty',
    syncAttempts: attempts,
    lastSyncError: message,
  });
}

export async function markMatchupSyncError(
  key: string,
  message: string,
  uploadedUpdatedAt?: string,
): Promise<void> {
  await db.matchupNotes
    .where('key')
    .equals(key)
    .and((r) => uploadedUpdatedAt == null || r.updatedAt === uploadedUpdatedAt)
    .modify({ syncState: 'error', lastSyncError: message });
}

// Reset a matchup-note dead-letter to 'dirty' for a manual retry.
export async function requeueMatchupNote(key: string): Promise<void> {
  await db.matchupNotes.update(key, {
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
  });
}

// ---------------------------------------------------------------------------
// Strategy whiteboard outbox (Strategy tab).
//
// Mirrors the matchup-note queue's sync-state machine. A doc is written 'dirty'
// before any network call (so an offline draw always persists locally) and
// drains through `strategyCanvasSync.ts` on the next online edge / poll / syncNow.
// The server merges by stroke id (migration 0042), so re-sending is always safe.
// ---------------------------------------------------------------------------

function withStrategyDefaults(r: LocalStrategyCanvas): LocalStrategyCanvas {
  return {
    ...r,
    deletedIds: r.deletedIds ?? [],
    syncAttempts: r.syncAttempts ?? 0,
    lastSyncError: r.lastSyncError ?? null,
  };
}

/** Persist (upsert by key) a whiteboard doc as 'dirty'. */
export async function saveStrategyCanvasLocal(doc: LocalStrategyCanvas): Promise<void> {
  await db.strategyCanvas.put({ ...doc, syncState: doc.syncState ?? 'dirty' });
}

export async function getStrategyCanvasLocal(
  key: string,
): Promise<LocalStrategyCanvas | undefined> {
  const r = await db.strategyCanvas.get(key);
  return r ? withStrategyDefaults(r) : undefined;
}

/** Auto-retry worklist: dirty + pending, oldest first; EXCLUDES 'error'/'synced'. */
export async function getStrategyCanvasSyncQueue(): Promise<LocalStrategyCanvas[]> {
  const all = await db.strategyCanvas.toArray();
  return all
    .filter((r) => r.syncState === 'dirty' || r.syncState === 'pending')
    .map(withStrategyDefaults)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

export async function listStrategyCanvasDeadLetters(): Promise<LocalStrategyCanvas[]> {
  const all = await db.strategyCanvas.toArray();
  return all.filter((r) => r.syncState === 'error').map(withStrategyDefaults);
}

export async function markStrategyCanvasPending(key: string): Promise<void> {
  await db.strategyCanvas.update(key, { syncState: 'pending' });
}

// Same in-flight-edit guards as markMatchupSynced/markMatchupSyncError: the
// verdict of an upload applies only to the revision that was uploaded.
export async function markStrategyCanvasSynced(
  key: string,
  uploadedUpdatedAt?: string,
): Promise<void> {
  await db.strategyCanvas
    .where('key')
    .equals(key)
    .and((r) => uploadedUpdatedAt == null || r.updatedAt === uploadedUpdatedAt)
    .modify({ syncState: 'synced', syncAttempts: 0, lastSyncError: null });
}

export async function markStrategyCanvasDirtyRetry(
  key: string,
  message: string,
  opts?: { countAttempt?: boolean },
): Promise<void> {
  const existing = await db.strategyCanvas.get(key);
  const bump = opts?.countAttempt === false ? 0 : 1;
  const attempts = (existing?.syncAttempts ?? 0) + bump;
  await db.strategyCanvas.update(key, {
    syncState: 'dirty',
    syncAttempts: attempts,
    lastSyncError: message,
  });
}

export async function markStrategyCanvasSyncError(
  key: string,
  message: string,
  uploadedUpdatedAt?: string,
): Promise<void> {
  await db.strategyCanvas
    .where('key')
    .equals(key)
    .and((r) => uploadedUpdatedAt == null || r.updatedAt === uploadedUpdatedAt)
    .modify({ syncState: 'error', lastSyncError: message });
}

/** Reset a whiteboard dead-letter to 'dirty' for a manual retry. */
export async function requeueStrategyCanvas(key: string): Promise<void> {
  await db.strategyCanvas.update(key, {
    syncState: 'dirty',
    syncAttempts: 0,
    lastSyncError: null,
  });
}

/**
 * Requeue ONLY auth/RLS-class matchup-note dead-letters back to 'dirty' — the
 * note write RPC (migration 0033) is open to anon, so any 42501-class dead-letter
 * predating its deploy is safe to auto-requeue once. Validation-class dead-letters
 * are left alone. Mirrors requeueAuthClassDeadLetters. Returns the count requeued.
 */
export async function requeueAuthClassMatchupDeadLetters(): Promise<number> {
  const dead = await listMatchupDeadLetters();
  const targets = dead.filter((r) => isAuthClassError(r.lastSyncError));
  for (const r of targets) {
    await requeueMatchupNote(r.key);
  }
  return targets.length;
}
