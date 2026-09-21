import {
  deleteDraft,
  finalizeReport,
  getDraft,
  getReport,
  quarantineDraft,
  saveDraft,
  saveReport,
} from '@/db/localStore';
import type { CaptureDraft, LocalMatchReport } from '@/db/types';
import { notifySyncQueueChanged } from '@/sync/queueEvents';

/**
 * All persistence used by a match-capture session. Production uses IndexedDB;
 * practice injects an in-memory implementation of this exact contract.
 */
export interface CaptureSessionStorage {
  getDraft(draftKey: string): Promise<CaptureDraft | undefined>;
  saveDraft(draftKey: string, state: unknown): Promise<void>;
  deleteDraft(draftKey: string): Promise<void>;
  getReport(id: string): Promise<LocalMatchReport | undefined>;
  saveReport(report: LocalMatchReport): Promise<void>;
  finalizeReport?(report: LocalMatchReport, draftKey: string): Promise<void>;
  quarantineDraft?(draftKey: string, reason: string): Promise<void>;
}

export const productionCaptureSessionStorage: CaptureSessionStorage = {
  getDraft,
  saveDraft,
  deleteDraft,
  getReport,
  // A submitted (or edited) report is a new outbox row: wake the sync
  // controller right away so it uploads within seconds of the tap instead of on
  // the next poll tick — this is what makes a fresh match show up on the lead
  // dashboard while the scout is still walking back to their seat.
  async saveReport(report) {
    await saveReport(report);
    notifySyncQueueChanged();
  },
  async finalizeReport(report, draftKey) {
    await finalizeReport(report, draftKey);
    notifySyncQueueChanged();
  },
  quarantineDraft,
};
