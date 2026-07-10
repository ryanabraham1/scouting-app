import type { CaptureSessionStorage } from '@/capture/captureSessionStorage';
import type { CaptureDraft, LocalMatchReport } from '@/db/types';
import type { PitScoutAdapter } from '@/pit/pitScoutAdapter';
import type {
  PitDraft,
  PitReport,
} from '@/pit/pitStore';

export interface PracticeIoStats {
  matchDraftWrites: number;
  matchReportWrites: number;
  pitDraftWrites: number;
  pitReportWrites: number;
  processedPhotos: number;
}

export interface PracticeAdapters {
  capture: CaptureSessionStorage;
  pit: PitScoutAdapter;
  stats: PracticeIoStats;
  matchReports: Map<string, LocalMatchReport>;
  pitReports: Map<string, PitReport>;
}

/**
 * Creates an isolated, memory-only persistence graph for one practice run.
 * Nothing in these adapters imports a production database, outbox, Supabase
 * client, photo uploader, or query cache.
 */
export function createPracticeAdapters(): PracticeAdapters {
  const drafts = new Map<string, CaptureDraft>();
  const matchReports = new Map<string, LocalMatchReport>();
  const pitDrafts = new Map<string, PitDraft>();
  const pitReports = new Map<string, PitReport>();
  const stats: PracticeIoStats = {
    matchDraftWrites: 0,
    matchReportWrites: 0,
    pitDraftWrites: 0,
    pitReportWrites: 0,
    processedPhotos: 0,
  };

  const capture: CaptureSessionStorage = {
    async getDraft(draftKey) {
      return drafts.get(draftKey);
    },
    async saveDraft(draftKey, state) {
      stats.matchDraftWrites += 1;
      drafts.set(draftKey, {
        draftKey,
        updatedAt: new Date().toISOString(),
        state,
      });
    },
    async deleteDraft(draftKey) {
      drafts.delete(draftKey);
    },
    async getReport(id) {
      return matchReports.get(id);
    },
    async saveReport(report) {
      stats.matchReportWrites += 1;
      matchReports.set(report.id, report);
    },
  };

  const pit: PitScoutAdapter = {
    async getDraft(eventKey, teamNumber) {
      return pitDrafts.get(`${eventKey}:${teamNumber}`);
    },
    async getReport() {
      return undefined;
    },
    async fetchReportForEdit() {
      return null;
    },
    getCachedReport() {
      return null;
    },
    async saveDraft(
      eventKey,
      teamNumber,
      report,
      photoBlobs,
      baseRevision,
    ) {
      stats.pitDraftWrites += 1;
      pitDrafts.set(`${eventKey}:${teamNumber}`, {
        draftKey: `${eventKey}:${teamNumber}`,
        eventKey,
        teamNumber,
        updatedAt: new Date().toISOString(),
        data: report,
        photoBlobs: { ...photoBlobs },
        baseRevision,
      });
    },
    async enqueueReport(report) {
      stats.pitReportWrites += 1;
      pitReports.set(`${report.eventKey}:${report.teamNumber}`, report);
      pitDrafts.delete(`${report.eventKey}:${report.teamNumber}`);
    },
    async processPhoto(file) {
      stats.processedPhotos += 1;
      return { blob: file, width: 1, height: 1 };
    },
    async signedPhotoUrl() {
      return null;
    },
    notifyQueued() {
      // Practice intentionally has no sync engine or global outbox signal.
    },
  };

  return { capture, pit, stats, matchReports, pitReports };
}
