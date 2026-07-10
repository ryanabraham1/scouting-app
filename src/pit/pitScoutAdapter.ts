import { queryClient } from '@/lib/queryPersist';
import type { TeamPit } from '@/dash/useTeamPit';
import {
  enqueuePitReport,
  fetchPitReportForEdit,
  getPitDraft,
  getPitReport,
  savePitDraft,
  type LocalPitReport,
  type PitDraft,
  type PitPhotoBlobs,
  type PitReport,
} from '@/pit/pitStore';
import { signedPitPhotoUrl } from '@/pit/photoUpload';
import {
  processPitPhoto,
  type ProcessedPitPhoto,
} from '@/pit/processPhoto';

/**
 * Complete I/O boundary for the production pit wizard. A tutorial adapter can
 * safely reuse every field, validation rule, photo control, and step transition
 * without importing IndexedDB, Supabase, Storage, or the production outbox.
 */
export interface PitScoutAdapter {
  getDraft(eventKey: string, teamNumber: number): Promise<PitDraft | undefined>;
  getReport(
    eventKey: string,
    teamNumber: number,
  ): Promise<LocalPitReport | undefined>;
  fetchReportForEdit(
    eventKey: string,
    teamNumber: number,
    scoutId: string,
  ): Promise<{ report: PitReport; revision: number } | null>;
  getCachedReport(eventKey: string, teamNumber: number): TeamPit | null;
  saveDraft(
    eventKey: string,
    teamNumber: number,
    report: PitReport,
    photoBlobs: PitPhotoBlobs,
    baseRevision: number | null,
  ): Promise<void>;
  enqueueReport(
    report: PitReport,
    photoBlobs: PitPhotoBlobs,
    baseRevision: number | null,
  ): Promise<void>;
  processPhoto(file: Blob): Promise<ProcessedPitPhoto>;
  signedPhotoUrl(path: string): Promise<string | null>;
  notifyQueued(): void;
}

export const productionPitScoutAdapter: PitScoutAdapter = {
  getDraft: getPitDraft,
  getReport: getPitReport,
  fetchReportForEdit: fetchPitReportForEdit,
  getCachedReport(eventKey, teamNumber) {
    const single = queryClient.getQueryData<TeamPit | null>([
      'team-pit',
      eventKey,
      teamNumber,
    ]);
    const eventPits = queryClient.getQueryData<Map<number, TeamPit>>([
      'event-pits',
      eventKey,
    ]);
    return single ?? eventPits?.get(teamNumber) ?? null;
  },
  saveDraft: savePitDraft,
  enqueueReport: enqueuePitReport,
  processPhoto: processPitPhoto,
  signedPhotoUrl: signedPitPhotoUrl,
  notifyQueued() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('scout-sync-changed'));
    }
  },
};
