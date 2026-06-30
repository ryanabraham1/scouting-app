// src/dash/exportDash.ts
// CSV/JSON export helpers for the dashboard (contracts §8). Pure string
// builders plus a browser download helper that revokes its blob URL after the
// click (Phase 2/3 lesson: never leak object URLs).

import type { TeamAgg } from '@/dash/aggregate';
import type { PicklistEntry } from '@/dash/picklistClient';

/**
 * Escape a single CSV field: wrap in double-quotes when it contains a comma,
 * double-quote, or newline, doubling any internal double-quotes.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Join already-stringified fields into one CSV row. */
export function csvRow(fields: Array<string | number | null | undefined>): string {
  return fields.map(csvField).join(',');
}

const TEAM_AGG_HEADER = [
  'teamNumber',
  'matchesScouted',
  'scoutingExpectedPoints',
  'meanFuelPoints',
  'climbSuccessRate',
  'avgDefenseRating',
  'reliability',
] as const;

/** Header row + one row per TeamAgg, with the contract's column subset. */
export function teamAggToCsv(aggs: TeamAgg[]): string {
  const lines = [csvRow([...TEAM_AGG_HEADER])];
  for (const a of aggs) {
    lines.push(
      csvRow([
        a.teamNumber,
        a.matchesScouted,
        a.scoutingExpectedPoints,
        a.meanFuelPoints,
        a.climbSuccessRate,
        a.avgDefenseRating,
        a.reliability,
      ]),
    );
  }
  return lines.join('\n');
}

/**
 * Header `rank,teamNumber,tier,note,tierType,dnp` + one (1-based) row per entry.
 * `tierType` is the structured first/second pick bucket (empty when unset);
 * `dnp` is the do-not-pick coaching flag (`true`/`false`).
 */
export function picklistToCsv(entries: PicklistEntry[]): string {
  const lines = ['rank,teamNumber,tier,note,tierType,dnp'];
  entries.forEach((e, i) => {
    lines.push(
      csvRow([
        i + 1,
        e.teamNumber,
        e.tier ?? null,
        e.note ?? null,
        e.tierType ?? '',
        e.dnp ? 'true' : 'false',
      ]),
    );
  });
  return lines.join('\n');
}

/**
 * Trigger a client-side text download: build a Blob, create an object URL,
 * click a temporary `<a download>`, then revoke the URL (no leak).
 */
export function downloadText(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
