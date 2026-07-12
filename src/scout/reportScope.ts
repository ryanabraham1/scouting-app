import type { LocalMatchReport } from '@/db/types';

export interface ReportScoutScope {
  eventKey: string;
  scoutId: string;
  scoutName: string;
}

/**
 * Scout names are roster identity, so compare them independently of harmless
 * capitalization and spacing differences introduced by roster edits or input.
 */
export function normalizeScouterName(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Prefer event + display-name identity because select_scouter reconciliation can
 * replace a scout row id. Reports created before scoutName was stored fall back
 * to the current scout id so those legacy local rows remain recoverable.
 */
export function reportMatchesScoutScope(
  report: Pick<LocalMatchReport, 'eventKey' | 'scoutId' | 'scoutName'>,
  scope: ReportScoutScope,
): boolean {
  if (!scope.eventKey || report.eventKey !== scope.eventKey) return false;

  const currentName = normalizeScouterName(scope.scoutName);
  const reportName = normalizeScouterName(report.scoutName);
  if (currentName && reportName) return currentName === reportName;

  return !reportName && Boolean(scope.scoutId) && report.scoutId === scope.scoutId;
}
