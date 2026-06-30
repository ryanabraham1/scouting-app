// src/dash/presetExports.ts
// Alliance-selection / picklist-tool export PRESETS. Pure composition of
// already-computed data: the picklist order (PicklistEntry[]), per-team scouting
// aggregates (TeamAgg), best-available EPA (with a correct PER-ROW source from
// useEventEpa's sourceByTeam map), and lazily-fetched team identity metadata.
//
// CSV escaping is reused from exportDash (csvField/csvRow) — never duplicated.
// HTML escaping is local (csvField is CSV-only). The print side-effect lives in
// printWindow.ts so this module stays a pure string builder.

import { supabase } from '@/lib/supabase';
import { csvRow } from '@/dash/exportDash';
import type { TeamAgg } from '@/dash/aggregate';
import type { PicklistEntry } from '@/dash/picklistClient';

const EM_DASH = '—';

/** Team identity for the export sheets, read from the open-SELECT `team` table. */
export interface TeamMetadata {
  teamNumber: number;
  nickname: string | null;
  city: string | null;
  stateProv: string | null;
  rookieYear: number | null;
}

/** One fully-resolved export row (one picklist entry). */
export interface PresetRow {
  rank: number; // 1-based index in the picklist
  teamNumber: number;
  nickname: string | null;
  city: string | null;
  stateProv: string | null;
  tier: string | null;
  note: string | null;
  // scouting metrics — null when the team has no TeamAgg (unscouted)
  matchesScouted: number | null;
  expPts: number | null; // agg.scoutingExpectedPoints
  fuelPts: number | null; // agg.meanFuelPoints
  climbRate: number | null; // agg.climbSuccessRate (0..1)
  defense: number | null; // agg.avgDefenseRating
  reliability: number | null; // agg.reliability (0..1)
  epa: number | null;
  epaSource: 'statbotics' | 'local' | 'scouting' | 'none';
}

/**
 * Lazy team identity lookup. One round-trip to the open-read `team` table keyed
 * by the picklist team numbers. Degrades to an EMPTY Map on any error (offline)
 * so the presets still generate with blank identity columns — never throws.
 */
export async function fetchTeamMetadata(
  teamNumbers: number[],
  client = supabase,
): Promise<Map<number, TeamMetadata>> {
  const map = new Map<number, TeamMetadata>();
  if (teamNumbers.length === 0) return map;
  const { data, error } = await client
    .from('team')
    .select('team_number,nickname,city,state_prov,rookie_year')
    .in('team_number', teamNumbers);
  if (error) return map; // degrade: identity columns just blank out
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const tn = Number(r.team_number);
    map.set(tn, {
      teamNumber: tn,
      nickname: (r.nickname as string) ?? null,
      city: (r.city as string) ?? null,
      stateProv: (r.state_prov as string) ?? null,
      rookieYear: (r.rookie_year as number) ?? null,
    });
  }
  return map;
}

/**
 * Build the ordered preset rows. PURE — fully testable with plain Maps.
 *
 * EPA value precedence matches RankingView (external EPA when available for THIS
 * team, else the in-house scoutingExpectedPoints). The per-row source label uses
 * the per-team `sourceByTeam` map (falling back to the event-wide source when a
 * caller passes a fixture without it). Unscouted teams (no agg) keep rank /
 * team / tier / note / identity but get null metrics — the in-house branch reads
 * `agg ? agg.scoutingExpectedPoints : null`, so it never derefs undefined.
 */
export function buildPresetRows(
  entries: PicklistEntry[],
  aggByTeam: Map<number, TeamAgg>,
  epaByTeam: Map<number, number | null>,
  epaAvailable: boolean,
  eventSource: 'statbotics' | 'local' | 'none',
  metaByTeam: Map<number, TeamMetadata>,
  sourceByTeam?: Map<number, 'statbotics' | 'local' | 'none'>,
): PresetRow[] {
  return entries.map((entry, i) => {
    const team = entry.teamNumber;
    const agg = aggByTeam.get(team);
    const meta = metaByTeam.get(team);

    const inHouseVal = agg ? agg.scoutingExpectedPoints : null;
    const external = epaAvailable ? epaByTeam.get(team) ?? null : null;
    const epaInHouse = external == null; // fell back to scouting for THIS team
    const epa = epaInHouse ? inHouseVal : external;

    let epaSource: PresetRow['epaSource'];
    if (epa == null) {
      epaSource = 'none';
    } else if (epaInHouse) {
      epaSource = 'scouting';
    } else {
      epaSource = sourceByTeam?.get(team) ?? eventSource;
    }

    return {
      rank: i + 1,
      teamNumber: team,
      nickname: meta?.nickname ?? null,
      city: meta?.city ?? null,
      stateProv: meta?.stateProv ?? null,
      tier: entry.tier ?? null,
      note: entry.note ?? null,
      matchesScouted: agg ? agg.matchesScouted : null,
      expPts: agg ? agg.scoutingExpectedPoints : null,
      fuelPts: agg ? agg.meanFuelPoints : null,
      climbRate: agg ? agg.climbSuccessRate : null,
      defense: agg ? agg.avgDefenseRating : null,
      reliability: agg ? agg.reliability : null,
      epa,
      epaSource,
    };
  });
}

/** `[city, state]` joined, or empty string. */
function location(row: PresetRow): string {
  return [row.city, row.stateProv].filter(Boolean).join(', ');
}

function fixed(n: number | null, digits: number, dash: string): string {
  return n == null ? dash : n.toFixed(digits);
}

function pct(n: number | null, dash: string): string {
  return n == null ? dash : `${Math.round(n * 100)}%`;
}

const ALLIANCE_HEADER =
  'Rank,Team,Nickname,Location,Tier,Note,Matches,Exp Pts,FUEL Pts,Climb %,Defense,Reliability,EPA,EPA Source';

/**
 * Human-readable, printable alliance-selection sheet CSV. Numbers formatted for
 * reading; null values render as the em-dash. All free text flows through
 * csvField so commas/quotes/newlines escape exactly like picklistToCsv.
 */
export function allianceSheetToCsv(rows: PresetRow[], _eventKey?: string): string {
  const lines = [ALLIANCE_HEADER];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.rank,
        r.teamNumber,
        r.nickname ?? EM_DASH,
        location(r) || EM_DASH,
        r.tier ?? EM_DASH,
        r.note ?? EM_DASH,
        r.matchesScouted == null ? EM_DASH : r.matchesScouted,
        fixed(r.expPts, 1, EM_DASH),
        fixed(r.fuelPts, 1, EM_DASH),
        pct(r.climbRate, EM_DASH),
        fixed(r.defense, 1, EM_DASH),
        pct(r.reliability, EM_DASH),
        fixed(r.epa, 0, EM_DASH),
        r.epaSource,
      ]),
    );
  }
  return lines.join('\n');
}

const TOOL_HEADER =
  'rank,team_number,nickname,tier,note,epa,epa_source,exp_points,fuel_points,climb_rate,defense,reliability,matches_scouted';

/**
 * Machine-friendly, snake_case flat CSV keyed by team_number for import into a
 * generic picklist tool/spreadsheet. Null numerics render as EMPTY fields (not
 * the em-dash) so a spreadsheet reads them as blank, not text. Rates are raw
 * 0..1 decimals.
 */
export function picklistToolCsv(rows: PresetRow[]): string {
  const lines = [TOOL_HEADER];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.rank,
        r.teamNumber,
        r.nickname ?? '',
        r.tier ?? '',
        r.note ?? '',
        fixed(r.epa, 1, ''),
        r.epaSource,
        fixed(r.expPts, 1, ''),
        fixed(r.fuelPts, 1, ''),
        r.climbRate == null ? '' : String(r.climbRate),
        fixed(r.defense, 1, ''),
        r.reliability == null ? '' : String(r.reliability),
        r.matchesScouted == null ? '' : String(r.matchesScouted),
      ]),
    );
  }
  return lines.join('\n');
}

/** Escape text for HTML (csvField is CSV-only). */
function htmlEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** EPA-source banner copy, mirroring RankingView's two non-Statbotics cases. */
export function epaBannerText(
  source: 'statbotics' | 'local' | 'none',
): string | null {
  if (source === 'statbotics') return null;
  if (source === 'local') {
    return 'Statbotics offline — EPA shows a local estimate computed from match results.';
  }
  return 'Statbotics & match-result EPA unavailable — EPA shows our in-house estimate from scouting data.';
}

/**
 * Self-contained, print-optimized HTML document (inline styles, works offline).
 * Header + generated-at timestamp + EPA-source note (when not live Statbotics) +
 * a table mirroring the alliance-sheet columns, top-3 rows emphasized.
 */
export function allianceSheetToHtml(
  rows: PresetRow[],
  eventKey: string,
  epaSource: 'statbotics' | 'local' | 'none',
): string {
  const title = `Alliance Selection — ${eventKey}`;
  const generatedAt = new Date().toLocaleString();
  const banner = epaBannerText(epaSource);
  const bannerHtml = banner
    ? `<p class="epa-note">${htmlEscape(banner)}</p>`
    : '';

  const headerCols = [
    'Rank',
    'Team',
    'Nickname',
    'Location',
    'Tier',
    'Note',
    'Matches',
    'Exp Pts',
    'FUEL Pts',
    'Climb %',
    'Defense',
    'Reliability',
    'EPA',
    'EPA Source',
  ];
  const thead = `<tr>${headerCols.map((c) => `<th>${htmlEscape(c)}</th>`).join('')}</tr>`;

  const body = rows
    .map((r) => {
      const cls = r.rank <= 3 ? ' class="top"' : '';
      const cells = [
        String(r.rank),
        String(r.teamNumber),
        r.nickname ?? EM_DASH,
        location(r) || EM_DASH,
        r.tier ?? EM_DASH,
        r.note ?? EM_DASH,
        r.matchesScouted == null ? EM_DASH : String(r.matchesScouted),
        fixed(r.expPts, 1, EM_DASH),
        fixed(r.fuelPts, 1, EM_DASH),
        pct(r.climbRate, EM_DASH),
        fixed(r.defense, 1, EM_DASH),
        pct(r.reliability, EM_DASH),
        fixed(r.epa, 0, EM_DASH),
        r.epaSource,
      ];
      return `<tr${cls}>${cells.map((c) => `<td>${htmlEscape(c)}</td>`).join('')}</tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${htmlEscape(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { font-size: 12px; color: #555; margin: 0 0 12px; }
  .epa-note { font-size: 12px; color: #92400e; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; }
  th { background: #f3f4f6; }
  tr.top td { font-weight: 600; }
  @media print { @page { size: landscape; } body { margin: 0; } }
</style>
</head>
<body>
<h1>${htmlEscape(title)}</h1>
<p class="meta">Generated ${htmlEscape(generatedAt)}</p>
${bannerHtml}
<table>
<thead>${thead}</thead>
<tbody>${body}</tbody>
</table>
</body>
</html>`;
}
