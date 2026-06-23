import Dexie, { type Table } from 'dexie';
import type { LocalMatchReport, CaptureDraft } from './types';

export class ScoutingDb extends Dexie {
  reports!: Table<LocalMatchReport, string>;
  drafts!: Table<CaptureDraft, string>;

  constructor() {
    super('scouting-db');
    this.version(1).stores({
      reports: 'id, syncState, matchKey, scoutId, targetTeamNumber',
      drafts: 'draftKey, updatedAt',
    });
  }
}

export const db = new ScoutingDb();

export async function saveReport(r: LocalMatchReport): Promise<void> {
  const record: LocalMatchReport = { ...r, syncState: r.syncState ?? 'dirty' };
  await db.reports.put(record);
}

export async function listReports(): Promise<LocalMatchReport[]> {
  return db.reports.toArray();
}

export async function getUnsynced(): Promise<LocalMatchReport[]> {
  const all = await db.reports.toArray();
  return all.filter((r) => r.syncState !== 'synced');
}

export async function countUnsynced(): Promise<number> {
  const unsynced = await getUnsynced();
  return unsynced.length;
}

export async function markSynced(id: string): Promise<void> {
  await db.reports.update(id, { syncState: 'synced' });
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
