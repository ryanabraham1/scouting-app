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
  saveReport,
  finalizeReport,
  quarantineDraft,
};
