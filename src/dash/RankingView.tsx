// src/dash/RankingView.tsx
// Cluster RANKING (contracts §2 aggregate, §5 hooks, §8 testids).
// Sortable table of every team with scouting data at the event, with optional
// Statbotics EPA and TBA-rank columns that degrade to "—" when unavailable, and
// a multi-select compare panel. Read-only; dark theme; shadcn primitives.

import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { aggregateEvent, type TeamAgg } from '@/dash/aggregate';
import { useEventReports, useEventEpa, useTbaRankings } from '@/dash/useEventData';

export interface RankingViewProps {
  eventKey: string;
}

/** Standard TBA `/event/{key}/rankings` payload (read defensively). */
interface TbaRankingsResponse {
  rankings?: Array<{ rank?: number; team_key?: string }>;
}

const EM_DASH = '—';
const MAX_COMPARE = 4;

/** A column the user can sort by. `value` is the numeric sort key per row. */
interface SortableColumn {
  key: SortKey;
  label: string;
  /** Optional header annotation node (e.g. the rate-FUEL confidence chip). */
  headerExtra?: JSX.Element;
}

type SortKey =
  | 'teamNumber'
  | 'matchesScouted'
  | 'scoutingExpectedPoints'
  | 'meanFuelPoints'
  | 'climbSuccessRate'
  | 'avgDefenseRating'
  | 'reliability'
  | 'epa'
  | 'tbaRank';

type SortDir = 'asc' | 'desc';

/** A fully-resolved row: the pure agg plus the external (EPA/TBA) values. */
interface Row {
  agg: TeamAgg;
  /** Statbotics EPA, or null when unknown/unavailable. */
  epa: number | null;
  /** TBA rank, or null when unavailable. */
  tbaRank: number | null;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Build the lookup of teamNumber → TBA rank from the (possibly absent) payload. */
function buildTbaRankMap(data: unknown): Map<number, number> {
  const map = new Map<number, number>();
  if (typeof data !== 'object' || data === null) return map;
  const rankings = (data as TbaRankingsResponse).rankings;
  if (!Array.isArray(rankings)) return map;
  for (const r of rankings) {
    if (!r || typeof r.team_key !== 'string' || typeof r.rank !== 'number') continue;
    const m = /^frc(\d+)$/.exec(r.team_key);
    if (!m) continue;
    map.set(Number(m[1]), r.rank);
  }
  return map;
}

/** Numeric value used to sort a row by a given column. */
function sortValue(row: Row, key: SortKey): number {
  switch (key) {
    case 'teamNumber':
      return row.agg.teamNumber;
    case 'matchesScouted':
      return row.agg.matchesScouted;
    case 'scoutingExpectedPoints':
      return row.agg.scoutingExpectedPoints;
    case 'meanFuelPoints':
      return row.agg.meanFuelPoints;
    case 'climbSuccessRate':
      return row.agg.climbSuccessRate;
    case 'avgDefenseRating':
      return row.agg.avgDefenseRating;
    case 'reliability':
      return row.agg.reliability;
    case 'epa':
      // Unknown EPA sorts to the bottom regardless of direction.
      return row.epa ?? Number.NEGATIVE_INFINITY;
    case 'tbaRank':
      // Lower rank is better; unknown ranks sort to the bottom.
      return row.tbaRank ?? Number.POSITIVE_INFINITY;
  }
}

export default function RankingView(props: RankingViewProps): JSX.Element {
  const { eventKey } = props;

  const reportsQuery = useEventReports(eventKey);
  const reports = reportsQuery.data;

  // Aggregate the scouted teams once per reports change.
  const aggs = useMemo<TeamAgg[]>(() => {
    if (!reports) return [];
    return Array.from(aggregateEvent(reports).values());
  }, [reports]);

  const teamNumbers = useMemo(() => aggs.map((a) => a.teamNumber), [aggs]);

  const epaQuery = useEventEpa(teamNumbers, eventKey);
  const tbaQuery = useTbaRankings(eventKey);

  const epaByTeam = epaQuery.data?.epaByTeam;
  const epaAvailable = epaQuery.data?.available === true;
  const tbaRankByTeam = useMemo(() => buildTbaRankMap(tbaQuery.data), [tbaQuery.data]);

  const rows = useMemo<Row[]>(
    () =>
      aggs.map((agg) => ({
        agg,
        epa: epaAvailable ? epaByTeam?.get(agg.teamNumber) ?? null : null,
        tbaRank: tbaRankByTeam.get(agg.teamNumber) ?? null,
      })),
    [aggs, epaAvailable, epaByTeam, tbaRankByTeam],
  );

  const [sortKey, setSortKey] = useState<SortKey>('scoutingExpectedPoints');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selected, setSelected] = useState<number[]>([]);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av === bv) return a.agg.teamNumber - b.agg.teamNumber;
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function onSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Team number / TBA rank read best ascending; the rest descending.
      setSortDir(key === 'teamNumber' || key === 'tbaRank' ? 'asc' : 'desc');
    }
  }

  function toggleSelect(teamNumber: number): void {
    setSelected((prev) => {
      if (prev.includes(teamNumber)) return prev.filter((t) => t !== teamNumber);
      if (prev.length >= MAX_COMPARE) return prev; // cap at ~4
      return [...prev, teamNumber];
    });
  }

  const fuelChip = (
    <span
      data-testid="rate-fuel-chip"
      title="FUEL points are rate-derived and down-weighted by confidence"
      className="ml-1 inline-flex items-center rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
    >
      rate-FUEL ↓
    </span>
  );

  const columns: SortableColumn[] = [
    { key: 'teamNumber', label: 'Team' },
    { key: 'matchesScouted', label: 'Matches' },
    { key: 'scoutingExpectedPoints', label: 'Exp. Pts' },
    { key: 'meanFuelPoints', label: 'FUEL Pts', headerExtra: fuelChip },
    { key: 'climbSuccessRate', label: 'Climb %' },
    { key: 'avgDefenseRating', label: 'Defense' },
    { key: 'reliability', label: 'Reliability' },
    { key: 'epa', label: 'EPA' },
    { key: 'tbaRank', label: 'TBA Rank' },
  ];

  // --- render states ---------------------------------------------------------
  if (reportsQuery.isLoading && !reports) {
    return (
      <div data-testid="dash-ranking" className="text-foreground">
        <Card className="bg-card">
          <CardContent className="p-6">
            <div data-testid="dash-ranking-loading" className="text-sm text-muted-foreground">
              Loading scouting data…
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div data-testid="dash-ranking" className="text-foreground">
        <Card className="bg-card">
          <CardContent className="p-6">
            <div data-testid="dash-ranking-empty" className="text-sm text-muted-foreground">
              No scouting data yet for this event.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const selectedRows = sortedRows.filter((r) => selected.includes(r.agg.teamNumber));

  const arrow = (key: SortKey) =>
    key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div data-testid="dash-ranking" className="space-y-4 text-foreground">
      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Team Rankings</CardTitle>
          {!epaAvailable ? (
            <div
              data-testid="dash-ranking-epa-banner"
              className="text-xs text-muted-foreground"
            >
              Statbotics EPA unavailable — showing scouting data only.
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-medium text-muted-foreground">
                    Compare
                  </th>
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      scope="col"
                      className="px-2 py-1 text-left font-medium text-muted-foreground"
                    >
                      <button
                        type="button"
                        data-testid={`sort-${col.key}`}
                        onClick={() => onSort(col.key)}
                        className="inline-flex min-h-[44px] items-center whitespace-nowrap rounded px-2 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <span>
                          {col.label}
                          {arrow(col.key)}
                        </span>
                        {col.headerExtra}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => {
                  const t = r.agg.teamNumber;
                  const checked = selected.includes(t);
                  const atCap = !checked && selected.length >= MAX_COMPARE;
                  return (
                    <tr
                      key={t}
                      data-testid={`ranking-row-${t}`}
                      className="border-b border-border/50 hover:bg-accent/30"
                    >
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          data-testid={`cmp-${t}`}
                          aria-label={`Compare team ${t}`}
                          checked={checked}
                          disabled={atCap}
                          onChange={() => toggleSelect(t)}
                          className="h-5 w-5 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      </td>
                      <td className="px-2 py-2 font-medium">{t}</td>
                      <td className="px-2 py-2 tabular-nums">{r.agg.matchesScouted}</td>
                      <td className="px-2 py-2 tabular-nums">{fmt(r.agg.scoutingExpectedPoints)}</td>
                      <td className="px-2 py-2 tabular-nums">{fmt(r.agg.meanFuelPoints)}</td>
                      <td className="px-2 py-2 tabular-nums">{pct(r.agg.climbSuccessRate)}</td>
                      <td className="px-2 py-2 tabular-nums">{fmt(r.agg.avgDefenseRating)}</td>
                      <td className="px-2 py-2 tabular-nums">{pct(r.agg.reliability)}</td>
                      <td data-testid={`epa-${t}`} className="px-2 py-2 tabular-nums">
                        {r.epa === null ? EM_DASH : fmt(r.epa, 0)}
                      </td>
                      <td data-testid={`tba-${t}`} className="px-2 py-2 tabular-nums">
                        {r.tbaRank === null ? EM_DASH : String(r.tbaRank)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {selectedRows.length > 0 ? (
        <Card data-testid="compare-panel" className="bg-card">
          <CardHeader>
            <CardTitle>Compare ({selectedRows.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-2 py-2 text-left font-medium text-muted-foreground">
                      Stat
                    </th>
                    {selectedRows.map((r) => (
                      <th
                        key={r.agg.teamNumber}
                        scope="col"
                        className="px-2 py-2 text-left font-medium"
                      >
                        {r.agg.teamNumber}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {([
                    ['Matches', (r: Row) => String(r.agg.matchesScouted)],
                    ['Exp. Pts', (r: Row) => fmt(r.agg.scoutingExpectedPoints)],
                    ['FUEL Pts', (r: Row) => fmt(r.agg.meanFuelPoints)],
                    ['Climb %', (r: Row) => pct(r.agg.climbSuccessRate)],
                    ['Defense', (r: Row) => fmt(r.agg.avgDefenseRating)],
                    ['Reliability', (r: Row) => pct(r.agg.reliability)],
                    ['EPA', (r: Row) => (r.epa === null ? EM_DASH : fmt(r.epa, 0))],
                    ['TBA Rank', (r: Row) => (r.tbaRank === null ? EM_DASH : String(r.tbaRank))],
                  ] as Array<[string, (r: Row) => string]>).map(([label, get]) => (
                    <tr key={label} className="border-b border-border/50">
                      <td className="px-2 py-2 font-medium text-muted-foreground">{label}</td>
                      {selectedRows.map((r) => (
                        <td key={r.agg.teamNumber} className="px-2 py-2 tabular-nums">
                          {get(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
