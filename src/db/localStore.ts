import Dexie, { type Table } from 'dexie';
import type {
  LocalMatchReport,
  CaptureDraft,
  CachedMatch,
  CachedAssignment,
  CachedRosterScouter,
  CachedTeam,
  PreloadMeta,
} from './types';
import { isAuthClassError } from '@/sync/classifyError';

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

export async function getUnsynced(): Promise<LocalMatchReport[]> {
  const all = await db.reports.toArray();
  return all.filter((r) => r.syncState !== 'synced').map(withSyncDefaults);
}

export async function countUnsynced(): Promise<number> {
  const unsynced = await getUnsynced();
  return unsynced.length;
}

export async function markSynced(id: string): Promise<void> {
  await db.reports.update(id, { syncState: 'synced' });
}

// Upload in flight: set immediately before the RPC call.
export async function markPending(id: string): Promise<void> {
  await db.reports.update(id, { syncState: 'pending' });
}

// DEAD-LETTER: terminal failure; NOT auto-retried, surfaced in the UI.
export async function markSyncError(id: string, message: string): Promise<void> {
  await db.reports.update(id, { syncState: 'error', lastSyncError: message });
}

// Transient failure: back to the queue, bump the attempt counter for backoff.
export async function markDirtyRetry(id: string, message: string): Promise<void> {
  const existing = await db.reports.get(id);
  const attempts = (existing?.syncAttempts ?? 0) + 1;
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
  const targets = dead.filter((r) => isAuthClassError(r.lastSyncError));
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
