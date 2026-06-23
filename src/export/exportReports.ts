import type { LocalMatchReport } from '@/db/types';
import { getUnsynced, saveReport } from '@/db/localStore';

const EXPORT_SCHEMA_VERSION = 1;

interface ExportDocument {
  schemaVersion: number;
  reports: LocalMatchReport[];
}

export function reportsToJson(reports: LocalMatchReport[]): string {
  const doc: ExportDocument = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    reports,
  };
  return JSON.stringify(doc, null, 2);
}

function isValidReport(value: unknown): value is LocalMatchReport {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.schemaVersion === 'number' &&
    typeof r.matchKey === 'string' &&
    typeof r.targetTeamNumber === 'number' &&
    Array.isArray(r.fuelBursts) &&
    Array.isArray(r.fuelByShift)
  );
}

function parseExportDocument(json: string): LocalMatchReport[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('importReportsFromJson: invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('importReportsFromJson: not an export document');
  }
  const doc = parsed as Record<string, unknown>;
  if (typeof doc.schemaVersion !== 'number' || !Array.isArray(doc.reports)) {
    throw new Error('importReportsFromJson: missing schemaVersion or reports');
  }
  for (const candidate of doc.reports) {
    if (!isValidReport(candidate)) {
      throw new Error('importReportsFromJson: malformed report in document');
    }
  }
  return doc.reports as LocalMatchReport[];
}

export async function importReportsFromJson(json: string): Promise<number> {
  const reports = parseExportDocument(json);
  const seen = new Set<string>();
  let imported = 0;
  for (const report of reports) {
    if (seen.has(report.id)) continue;
    seen.add(report.id);
    await saveReport(report);
    imported += 1;
  }
  return imported;
}

export async function exportUnsyncedToFile(): Promise<{
  count: number;
  filename: string;
  blobUrl: string;
}> {
  const unsynced = await getUnsynced();
  const json = reportsToJson(unsynced);
  const blob = new Blob([json], { type: 'application/json' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `scouting-unsynced-${stamp}.json`;
  const blobUrl = URL.createObjectURL(blob);
  return { count: unsynced.length, filename, blobUrl };
}
