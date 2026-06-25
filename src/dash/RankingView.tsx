// src/dash/RankingView.tsx
// Cluster RANKING (contracts §2 aggregate, §5 hooks, §8 testids).
// Sortable table of every team with scouting data at the event, with optional
// Statbotics EPA and TBA-rank columns that degrade to "—" when unavailable, and
// a multi-select compare panel. Read-only; dark theme; shadcn primitives.

import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { aggregateEvent, type TeamAgg } from '@/dash/aggregate';
import { useEventReports, useEventEpa, useEventMatches, useTbaRankings } from '@/dash/useEventData';

export interface RankingViewProps {
  eventKey: string;
  /**
   * Open a team's Team page. When provided, each row's team number becomes a
   * button that calls this with the team number (the Dashboard then switches to
   * the Team tab with that team preselected).
   */
  onSelectTeam?: (teamNumber: number) => void;
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
  /** Best-available EPA: Statbotics → local match-results → in-house scouting. */
  epa: number | null;
  /** True when `epa` is our in-house scouting estimate (no external EPA source). */
  epaInHouse: boolean;
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

/**
 * Compare-panel stat rows. `value` returns the raw numeric (or null when
 * unavailable) used to find the per-row winner; `better` says which direction
 * wins so the best cell can be flagged with the success token.
 */
interface CompareRow {
  label: string;
  get: (r: Row) => string;
  value: (r: Row) => number | null;
  better: 'higher' | 'lower';
}

const COMPARE_ROWS: CompareRow[] = [
  {
    label: 'Matches',
    get: (r) => String(r.agg.matchesScouted),
    value: (r) => r.agg.matchesScouted,
    better: 'higher',
  },
  {
    label: 'Exp. Pts',
    get: (r) => fmt(r.agg.scoutingExpectedPoints),
    value: (r) => r.agg.scoutingExpectedPoints,
    better: 'higher',
  },
  {
    label: 'FUEL Pts',
    get: (r) => fmt(r.agg.meanFuelPoints),
    value: (r) => r.agg.meanFuelPoints,
    better: 'higher',
  },
  {
    label: 'Climb %',
    get: (r) => pct(r.agg.climbSuccessRate),
    value: (r) => r.agg.climbSuccessRate,
    better: 'higher',
  },
  {
    label: 'Defense',
    get: (r) => fmt(r.agg.avgDefenseRating),
    value: (r) => r.agg.avgDefenseRating,
    better: 'higher',
  },
  {
    label: 'Reliability',
    get: (r) => pct(r.agg.reliability),
    value: (r) => r.agg.reliability,
    better: 'higher',
  },
  {
    label: 'EPA',
    get: (r) => (r.epa === null ? EM_DASH : fmt(r.epa, 0)),
    value: (r) => r.epa,
    better: 'higher',
  },
  {
    label: 'TBA Rank',
    get: (r) => (r.tbaRank === null ? EM_DASH : String(r.tbaRank)),
    value: (r) => r.tbaRank,
    better: 'lower',
  },
];

export default function RankingView(props: RankingViewProps): JSX.Element {
  const { eventKey, onSelectTeam } = props;

  const reportsQuery = useEventReports(eventKey);
  const reports = reportsQuery.data;

  // Aggregate the scouted teams once per reports change.
  const aggs = useMemo<TeamAgg[]>(() => {
    if (!reports) return [];
    return Array.from(aggregateEvent(reports).values());
  }, [reports]);

  const teamNumbers = useMemo(() => aggs.map((a) => a.teamNumber), [aggs]);

  // Pass the event's played matches so EPA can fall back to a local estimate
  // (Statbotics-style, computed from real results) when Statbotics is offline.
  const matchesQuery = useEventMatches(eventKey);
  const epaQuery = useEventEpa(teamNumbers, eventKey, matchesQuery.data ?? []);
  const tbaQuery = useTbaRankings(eventKey);

  const epaByTeam = epaQuery.data?.epaByTeam;
  const epaAvailable = epaQuery.data?.available === true;
  const epaSource = epaQuery.data?.source ?? 'none';
  // When NO external EPA source is available (Statbotics down AND no played-match
  // results to compute a local EPA from), fall back to OUR in-house scouting
  // estimate (scoutingExpectedPoints) so the EPA column shows a real number
  // instead of "—". This is literally our home-grown EPA from scouting data.
  const epaFromScouting = !epaAvailable;
  const tbaRankByTeam = useMemo(() => buildTbaRankMap(tbaQuery.data), [tbaQuery.data]);

  const rows = useMemo<Row[]>(
    () =>
      aggs.map((agg) => {
        const external = epaAvailable ? epaByTeam?.get(agg.teamNumber) ?? null : null;
        const epaInHouse = external == null && epaFromScouting;
        return {
          agg,
          epa: epaInHouse ? agg.scoutingExpectedPoints : external,
          epaInHouse,
          tbaRank: tbaRankByTeam.get(agg.teamNumber) ?? null,
        };
      }),
    [aggs, epaAvailable, epaFromScouting, epaByTeam, tbaRankByTeam],
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
          {epaSource === 'local' ? (
            <div
              data-testid="dash-ranking-epa-banner"
              className="text-xs text-warning"
            >
              Statbotics offline — EPA column shows a local estimate computed from match results.
            </div>
          ) : !epaAvailable ? (
            <div
              data-testid="dash-ranking-epa-banner"
              className="text-xs text-warning"
            >
              Statbotics &amp; match-result EPA unavailable — EPA column shows our in-house
              estimate from scouting data.
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
                      className={cn(
                        'px-2 py-1 text-left font-medium text-muted-foreground',
                        col.key === 'teamNumber' && 'sticky left-0 z-10 bg-card',
                        (col.key === 'epa' || col.key === 'tbaRank') && 'hidden sm:table-cell',
                      )}
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
                      <td className="sticky left-0 z-10 bg-card px-2 py-1 font-medium">
                        {onSelectTeam ? (
                          <button
                            type="button"
                            data-testid={`ranking-team-${t}`}
                            onClick={() => onSelectTeam(t)}
                            aria-label={`Open team ${t}`}
                            className="inline-flex min-h-[44px] items-center rounded px-2 tabular-nums text-brand hover:text-brand/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {t}
                          </button>
                        ) : (
                          <span className="tabular-nums text-brand">{t}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 tabular-nums">{r.agg.matchesScouted}</td>
                      <td className="px-2 py-2 tabular-nums">{fmt(r.agg.scoutingExpectedPoints)}</td>
                      <td className="px-2 py-2 tabular-nums text-energy">{fmt(r.agg.meanFuelPoints)}</td>
                      <td
                        className={cn(
                          'px-2 py-2 tabular-nums',
                          r.agg.climbSuccessRate > 0 ? 'text-success' : 'text-muted-foreground',
                        )}
                      >
                        {pct(r.agg.climbSuccessRate)}
                      </td>
                      <td className="px-2 py-2 tabular-nums text-brand">{fmt(r.agg.avgDefenseRating)}</td>
                      <td
                        className={cn(
                          'px-2 py-2 tabular-nums',
                          r.agg.reliability < 0.7 ? 'text-warning' : 'text-success',
                        )}
                      >
                        {pct(r.agg.reliability)}
                      </td>
                      <td
                        data-testid={`epa-${t}`}
                        className={cn(
                          'hidden px-2 py-2 tabular-nums sm:table-cell',
                          r.epaInHouse && 'text-warning',
                        )}
                        title={r.epaInHouse ? 'In-house EPA estimated from scouting data' : undefined}
                      >
                        {r.epa === null ? EM_DASH : fmt(r.epa, 0)}
                        {r.epaInHouse && r.epa !== null ? (
                          <span className="ml-1 text-[10px] text-warning">est</span>
                        ) : null}
                      </td>
                      <td data-testid={`tba-${t}`} className="hidden px-2 py-2 tabular-nums sm:table-cell">
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
                  {COMPARE_ROWS.map(({ label, get, value, better }) => {
                    // The winning numeric value for this stat across the selected
                    // teams (null when no team has a value), so we can flag the
                    // best cell green — a scannable winner-per-row matrix.
                    const nums = selectedRows
                      .map((r) => value(r))
                      .filter((n): n is number => n !== null);
                    const best =
                      nums.length === 0
                        ? null
                        : better === 'higher'
                          ? Math.max(...nums)
                          : Math.min(...nums);
                    return (
                      <tr key={label} className="border-b border-border/50">
                        <td className="px-2 py-2 font-medium text-muted-foreground">{label}</td>
                        {selectedRows.map((r) => {
                          const v = value(r);
                          const isBest = best !== null && v !== null && v === best;
                          return (
                            <td
                              key={r.agg.teamNumber}
                              className={cn(
                                'px-2 py-2 tabular-nums',
                                isBest && 'font-bold text-success',
                              )}
                            >
                              {get(r)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
