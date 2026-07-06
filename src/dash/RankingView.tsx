// src/dash/RankingView.tsx
// Cluster RANKING (contracts §2 aggregate, §5 hooks, §8 testids).
// Sortable table of every team with scouting data at the event, with optional
// Statbotics EPA and TBA-rank columns that degrade to "—" when unavailable, and
// a multi-select compare panel. Read-only; dark theme; shadcn primitives.

import { useEffect, useMemo, useRef, useState } from 'react';
import { SlidersHorizontal, ChevronUp, ChevronDown, ClipboardList } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { aggregateEvent, emptyTeamAgg, type TeamAgg } from '@/dash/aggregate';
import { pctSigned, DEF_EFF_MIN_SAMPLE } from '@/dash/defenseAnalytics';
import {
  useEventReports,
  useEventEpa,
  useEventMatches,
  useEventTeams,
  useTbaRankings,
} from '@/dash/useEventData';
import { rankSortValue, resolveRowEpa } from '@/dash/sorting';
import { TeamCompare, MAX_COMPARE_TEAMS } from '@/dash/TeamCompare';

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
// Up to 6 teams can be compared at once (the radar overlay palette + the
// per-stat winner table both read cleanly through 6).
const MAX_COMPARE = MAX_COMPARE_TEAMS;

/** localStorage key persisting the lead's chosen visible stat columns. */
const VISIBLE_COLUMNS_KEY = 'ranking-visible-columns';

/**
 * Every column except the identity (`teamNumber`) is user-toggleable. The Team
 * column is always shown and never appears in the Columns picker.
 */
type ToggleableKey = Exclude<SortKey, 'teamNumber'>;

/**
 * Read the persisted hidden-column set from localStorage. We store the HIDDEN
 * keys (not the visible ones) so any column added in a future release defaults
 * to visible — an empty/missing store means "everything shown" (parity). Guarded
 * for SSR/no-window and corrupt JSON.
 */
function loadHiddenColumns(): Set<ToggleableKey> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(VISIBLE_COLUMNS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is ToggleableKey => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

/** Persist the hidden-column set; swallow quota/serialization errors. */
function saveHiddenColumns(hidden: Set<ToggleableKey>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VISIBLE_COLUMNS_KEY, JSON.stringify([...hidden]));
  } catch {
    /* ignore */
  }
}

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
  | 'climbSuccessRate'
  | 'avgDefenseRating'
  | 'reliability'
  | 'fuelSuppression'
  | 'defenderEffectiveness'
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

/**
 * Rank tier by leaderboard position — the same cut as the picklist EPA board so
 * Ranking and Picklist read as one system: top 3 (alliance captains' caliber)
 * in brand cyan, 4–8 in energy amber, the rest muted.
 */
function rankTier(rank: number): 'top' | 'mid' | 'low' {
  return rank <= 3 ? 'top' : rank <= 8 ? 'mid' : 'low';
}
/** Strength-bar tint per tier (quiet, behind the row). */
const TIER_BAR: Record<'top' | 'mid' | 'low', string> = {
  top: 'bg-brand/20',
  mid: 'bg-energy/15',
  low: 'bg-muted-foreground/10',
};
/** Rank-number text tint per tier. */
const TIER_RANK_TEXT: Record<'top' | 'mid' | 'low', string> = {
  top: 'text-brand',
  mid: 'text-energy',
  low: 'text-muted-foreground',
};

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

/**
 * Numeric value used to sort a row by a given column. The four columns shared
 * with the picklist seeder (`scoutingExpectedPoints`, `climbSuccessRate`,
 * `avgDefenseRating`, `epa`) delegate to `rankSortValue` in `sorting.ts` — the
 * single source of truth — so the table order and the seed order cannot drift.
 * The remaining columns stay local to this table.
 */
function sortValue(row: Row, key: SortKey): number {
  switch (key) {
    case 'teamNumber':
      return row.agg.teamNumber;
    case 'matchesScouted':
      return row.agg.matchesScouted;
    case 'reliability':
      return row.agg.reliability;
    case 'fuelSuppression':
      // Higher suppression is better; null sorts to the bottom.
      return row.agg.fuelSuppressionWhileDefended ?? Number.NEGATIVE_INFINITY;
    case 'defenderEffectiveness':
      // Higher is better; null sorts to the bottom.
      return row.agg.defenderEffectiveness ?? Number.NEGATIVE_INFINITY;
    case 'tbaRank':
      // Lower rank is better; unknown ranks sort to the bottom.
      return row.tbaRank ?? Number.POSITIVE_INFINITY;
    case 'scoutingExpectedPoints':
    case 'climbSuccessRate':
    case 'avgDefenseRating':
    case 'epa':
      // Shared with the picklist seeder — delegate to the single source of truth.
      return rankSortValue({ agg: row.agg, epa: row.epa }, key);
  }
}

/**
 * True when the row has NO value for the sort column. Checked before the
 * numeric compare so "—" rows land at the BOTTOM in both directions — the
 * ±Infinity sentinels in sortValue encode "worst", which an ascending sort
 * would otherwise hoist to the top as a wall of empty rows.
 */
function sortValueMissing(row: Row, key: SortKey): boolean {
  switch (key) {
    case 'fuelSuppression':
      return row.agg.fuelSuppressionWhileDefended == null;
    case 'defenderEffectiveness':
      return row.agg.defenderEffectiveness == null;
    case 'tbaRank':
      return row.tbaRank == null;
    case 'epa':
      return row.epa == null;
    default:
      return false;
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

/** Display label for the recent-form trend (em-dash when insufficient data). */
function trendLabel(agg: TeamAgg): string {
  // Guard toFixed against a non-finite delta (latent seam) like the other formatters.
  const delta = Number.isFinite(agg.recentFuelDelta) ? agg.recentFuelDelta.toFixed(1) : '0.0';
  switch (agg.recentTrend) {
    case 'improving':
      return `Improving +${delta}`;
    case 'fading':
      return `Fading ${delta}`;
    case 'stable':
      return 'Stable';
    default:
      return EM_DASH;
  }
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
    label: 'Def ↓',
    get: (r) =>
      r.agg.fuelSuppressionWhileDefended === null
        ? EM_DASH
        : pctSigned(r.agg.fuelSuppressionWhileDefended),
    value: (r) => r.agg.fuelSuppressionWhileDefended,
    better: 'higher',
  },
  {
    label: 'Defender',
    get: (r) =>
      r.agg.defenderEffectiveness === null
        ? EM_DASH
        : pctSigned(r.agg.defenderEffectiveness),
    value: (r) => r.agg.defenderEffectiveness,
    better: 'higher',
  },
  // --- Distribution (consistency) + recent-form trend ------------------------
  {
    label: 'Fuel σ',
    get: (r) => fmt(r.agg.stdDevFuelPoints),
    value: (r) => r.agg.stdDevFuelPoints,
    better: 'lower',
  },
  {
    label: 'Climb σ',
    get: (r) => fmt(r.agg.stdDevClimbPoints),
    value: (r) => r.agg.stdDevClimbPoints,
    better: 'lower',
  },
  {
    label: 'Defense σ',
    get: (r) => fmt(r.agg.stdDevDefenseRating),
    value: (r) => r.agg.stdDevDefenseRating,
    better: 'lower',
  },
  {
    // No-winner row: value() returns null for every team so no cell is ever
    // flagged best (greening a "Stable" or two "Improving" cells would mislead).
    label: 'Recent Form',
    get: (r) => trendLabel(r.agg),
    value: () => null,
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
  const teamsQuery = useEventTeams(eventKey);

  // Aggregate the scouted teams, then extend with EPA-only rows for every event
  // team that has NO scouting yet — so the Ranking tab still ranks teams by EPA
  // (in-house or Statbotics) even when scouting data is missing.
  const aggs = useMemo<TeamAgg[]>(() => {
    const byTeam = reports ? aggregateEvent(reports) : new Map<number, TeamAgg>();
    for (const t of teamsQuery.data ?? []) {
      if (!byTeam.has(t.team_number)) byTeam.set(t.team_number, emptyTeamAgg(t.team_number));
    }
    return Array.from(byTeam.values());
  }, [reports, teamsQuery.data]);

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
        // Resolve the row's EPA via the SHARED helper so the table and the seed
        // use byte-identical EPA resolution. `epaInHouse` is still derived here
        // locally for the "est" suffix UI.
        const external = epaAvailable ? epaByTeam?.get(agg.teamNumber) ?? null : null;
        const epaInHouse = external == null && epaFromScouting;
        return {
          agg,
          epa: resolveRowEpa({ agg, epaByTeam, epaAvailable, epaFromScouting }),
          epaInHouse,
          tbaRank: tbaRankByTeam.get(agg.teamNumber) ?? null,
        };
      }),
    [aggs, epaAvailable, epaFromScouting, epaByTeam, tbaRankByTeam],
  );

  const [sortKey, setSortKey] = useState<SortKey>('scoutingExpectedPoints');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selected, setSelected] = useState<number[]>([]);

  // User-chosen hidden stat columns (Team is never toggleable). We store HIDDEN
  // keys so future columns default visible; lazy init reads localStorage once.
  const [hiddenColumns, setHiddenColumns] = useState<Set<ToggleableKey>>(loadHiddenColumns);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);

  function isVisible(key: SortKey): boolean {
    return key === 'teamNumber' || !hiddenColumns.has(key as ToggleableKey);
  }

  function toggleColumn(key: ToggleableKey): void {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveHiddenColumns(next);
      return next;
    });
  }

  // Close the Columns popover on outside click / Escape.
  useEffect(() => {
    if (!columnsOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (columnsRef.current && !columnsRef.current.contains(e.target as Node)) {
        setColumnsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setColumnsOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [columnsOpen]);

  // With zero scouting at the event, Exp. Pts is 0 for everyone — rank by EPA by
  // default so the table is still a meaningful ranking. Only nudges the UNTOUCHED
  // default; once the user picks a column (or scouting lands) it's left alone.
  const anyScouted = useMemo(() => aggs.some((a) => a.matchesScouted > 0), [aggs]);
  useEffect(() => {
    if (aggs.length > 0 && !anyScouted) {
      setSortKey((k) => (k === 'scoutingExpectedPoints' ? 'epa' : k));
    }
  }, [aggs.length, anyScouted]);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const aMissing = sortValueMissing(a, sortKey);
      const bMissing = sortValueMissing(b, sortKey);
      if (aMissing !== bMissing) return aMissing ? 1 : -1; // "—" rows always last
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av === bv) return a.agg.teamNumber - b.agg.teamNumber;
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  // Field-max EPA for the per-row strength bars (positive only — the signature
  // "field strength" motif shared with the picklist EPA board).
  const maxEpa = useMemo(() => {
    let m = 0;
    for (const r of rows) if (r.epa != null && r.epa > m) m = r.epa;
    return m;
  }, [rows]);

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
      if (prev.length >= MAX_COMPARE) return prev; // cap at MAX_COMPARE
      return [...prev, teamNumber];
    });
  }

  const columns: SortableColumn[] = [
    { key: 'teamNumber', label: 'Team' },
    { key: 'matchesScouted', label: 'Matches' },
    { key: 'scoutingExpectedPoints', label: 'Exp. Pts' },
    { key: 'climbSuccessRate', label: 'Climb %' },
    { key: 'avgDefenseRating', label: 'Defense' },
    { key: 'reliability', label: 'Reliability' },
    { key: 'fuelSuppression', label: 'Def ↓' },
    { key: 'defenderEffectiveness', label: 'Defender' },
    { key: 'epa', label: 'EPA' },
    { key: 'tbaRank', label: 'TBA Rank' },
  ];

  // --- render states ---------------------------------------------------------
  if ((reportsQuery.isLoading && !reports) || (teamsQuery.isLoading && !teamsQuery.data)) {
    return (
      <div data-testid="dash-ranking" className="text-foreground">
        <Card className="bg-card">
          <CardHeader>
            <div className="h-5 w-40 rounded-lg bg-muted/40 motion-safe:animate-pulse" />
          </CardHeader>
          <CardContent className="p-0">
            {/* Skeleton rows approximating the ranked table while data loads.
                role=status + sr-only text keep it announced to screen readers. */}
            <div
              data-testid="dash-ranking-loading"
              role="status"
              className="flex flex-col gap-px"
            >
              <span className="sr-only">Loading scouting data…</span>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <div className="h-5 w-5 rounded bg-muted/40 motion-safe:animate-pulse" />
                  <div className="h-4 w-16 rounded-lg bg-muted/40 motion-safe:animate-pulse" />
                  <div className="ml-auto h-4 w-24 rounded-lg bg-muted/40 motion-safe:animate-pulse" />
                  <div className="h-4 w-14 rounded-lg bg-muted/40 motion-safe:animate-pulse" />
                </div>
              ))}
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
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <ClipboardList className="size-8 text-muted-foreground/60" />
            <div data-testid="dash-ranking-empty" className="text-sm text-muted-foreground">
              No teams or scouting data yet — import the event or capture a match to populate rankings.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Order compare columns by the user's SELECTION order, not the table's current
  // sort — tapping C then A then B should show C, A, B (filtering sortedRows would
  // re-order them by whatever column is sorted).
  const selectedRows = selected
    .map((tn) => sortedRows.find((r) => r.agg.teamNumber === tn))
    .filter((r): r is (typeof sortedRows)[number] => r != null);

  // Solid caret for the active sort column (filled lucide icon instead of a
  // muted text arrow), so the sorted column reads as clearly active.
  const sortCaret = (key: SortKey) => {
    if (key !== sortKey) return null;
    const Icon = sortDir === 'asc' ? ChevronUp : ChevronDown;
    return <Icon className="size-3.5 shrink-0" aria-hidden="true" />;
  };

  return (
    <div data-testid="dash-ranking" className="space-y-4 text-foreground">
      <Card className="bg-card">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="flex items-baseline gap-2">
              Team Rankings
              <span
                data-testid="ranking-count"
                className="text-xs font-normal tabular-nums text-muted-foreground"
              >
                {sortedRows.length} ranked
              </span>
            </CardTitle>
            <div ref={columnsRef} className="relative">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="ranking-columns-toggle"
                aria-haspopup="true"
                aria-expanded={columnsOpen}
                onClick={() => setColumnsOpen((o) => !o)}
              >
                <SlidersHorizontal />
                Columns
              </Button>
              {columnsOpen ? (
                <div
                  data-testid="ranking-columns-popover"
                  role="menu"
                  aria-label="Show or hide columns"
                  className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-border bg-card p-1 shadow-xl"
                >
                  {columns
                    .filter((col): col is SortableColumn & { key: ToggleableKey } =>
                      col.key !== 'teamNumber',
                    )
                    .map((col) => (
                      <label
                        key={col.key}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-accent/40"
                      >
                        <input
                          type="checkbox"
                          data-testid={`ranking-col-opt-${col.key}`}
                          checked={isVisible(col.key)}
                          onChange={() => toggleColumn(col.key)}
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                        <span>{col.label}</span>
                      </label>
                    ))}
                </div>
              ) : null}
            </div>
          </div>
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
                  {columns.filter((col) => isVisible(col.key)).map((col) => {
                    const active = col.key === sortKey;
                    return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className={cn(
                        'px-2 py-1 text-left font-medium text-muted-foreground',
                        (col.key === 'epa' ||
                          col.key === 'tbaRank' ||
                          col.key === 'fuelSuppression' ||
                          col.key === 'defenderEffectiveness') &&
                          'hidden sm:table-cell',
                      )}
                    >
                      <button
                        type="button"
                        data-testid={`sort-${col.key}`}
                        onClick={() => onSort(col.key)}
                        className={cn(
                          'inline-flex min-h-[44px] items-center gap-1 whitespace-nowrap rounded-md px-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          active
                            ? 'bg-brand/10 font-semibold text-brand'
                            : 'hover:text-foreground',
                        )}
                      >
                        <span>{col.label}</span>
                        {sortCaret(col.key)}
                        {col.headerExtra}
                      </button>
                    </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r, idx) => {
                  const t = r.agg.teamNumber;
                  const checked = selected.includes(t);
                  const atCap = !checked && selected.length >= MAX_COMPARE;
                  const rank = idx + 1;
                  const tier = rankTier(rank);
                  // Strength bar width = this team's EPA vs the field max (the
                  // shared field-strength motif). Absolutely positioned against the
                  // `relative` row so it spans the whole row behind the cells.
                  const barWidth =
                    r.epa == null || maxEpa <= 0
                      ? '0%'
                      : `${Math.max(2, Math.min(100, (r.epa / maxEpa) * 100))}%`;
                  return (
                    <tr
                      key={t}
                      data-testid={`ranking-row-${t}`}
                      className="relative isolate border-b border-border/50 hover:bg-accent/20"
                    >
                      <td className="px-2 py-2">
                        {/* SIGNATURE: quiet field-strength bar behind the row. The
                            row isolates a stacking context so this -z layer sits
                            behind the cell text but above the hover tint. */}
                        <div
                          aria-hidden="true"
                          data-testid={`ranking-bar-${t}`}
                          style={{ width: barWidth }}
                          className={cn(
                            'pointer-events-none absolute inset-y-0 left-0 -z-10 motion-safe:transition-[width]',
                            TIER_BAR[tier],
                          )}
                        />
                        <input
                          type="checkbox"
                          data-testid={`cmp-${t}`}
                          aria-label={`Compare team ${t}`}
                          checked={checked}
                          disabled={atCap}
                          onChange={() => toggleSelect(t)}
                          className="relative z-10 h-5 w-5 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      </td>
                      <td className="relative z-10 px-2 py-2 font-medium">
                        <span className="flex items-center gap-2">
                          <span
                            className={cn(
                              'w-7 shrink-0 text-right text-xs font-semibold font-mono tabular-nums',
                              TIER_RANK_TEXT[tier],
                            )}
                          >
                            #{rank}
                          </span>
                          {onSelectTeam ? (
                            <button
                              type="button"
                              data-testid={`ranking-team-${t}`}
                              onClick={() => onSelectTeam(t)}
                              aria-label={`Open team ${t}`}
                              className="inline-flex min-h-[44px] items-center rounded font-mono tabular-nums text-base font-semibold text-brand hover:text-brand/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              {t}
                            </button>
                          ) : (
                            <span className="font-mono tabular-nums text-base font-semibold text-brand">{t}</span>
                          )}
                        </span>
                      </td>
                      {isVisible('matchesScouted') && (
                        <td className="px-2 py-2 font-mono tabular-nums">{r.agg.matchesScouted}</td>
                      )}
                      {isVisible('scoutingExpectedPoints') && (
                        <td className="px-2 py-2 font-mono tabular-nums">{fmt(r.agg.scoutingExpectedPoints)}</td>
                      )}
                      {isVisible('climbSuccessRate') && (
                        <td
                          className={cn(
                            'px-2 py-2 font-mono tabular-nums',
                            r.agg.climbSuccessRate > 0 ? 'text-success' : 'text-muted-foreground',
                          )}
                        >
                          {pct(r.agg.climbSuccessRate)}
                        </td>
                      )}
                      {isVisible('avgDefenseRating') && (
                        <td className="px-2 py-2 font-mono tabular-nums text-brand">{fmt(r.agg.avgDefenseRating)}</td>
                      )}
                      {isVisible('reliability') && (
                        <td
                          className={cn(
                            'px-2 py-2 font-mono tabular-nums',
                            r.agg.reliability < 0.7 ? 'text-warning' : 'text-success',
                          )}
                        >
                          {pct(r.agg.reliability)}
                        </td>
                      )}
                      {isVisible('fuelSuppression') && (
                        <td
                          data-testid={`def-supp-${t}`}
                          className="hidden px-2 py-2 font-mono tabular-nums sm:table-cell"
                        >
                          {r.agg.fuelSuppressionWhileDefended === null
                            ? EM_DASH
                            : pctSigned(r.agg.fuelSuppressionWhileDefended)}
                        </td>
                      )}
                      {isVisible('defenderEffectiveness') && (
                        <td
                          data-testid={`defender-${t}`}
                          className="hidden px-2 py-2 font-mono tabular-nums sm:table-cell"
                        >
                          {r.agg.defenderEffectiveness === null ||
                          r.agg.defenseSampleCount < DEF_EFF_MIN_SAMPLE
                            ? EM_DASH
                            : pctSigned(r.agg.defenderEffectiveness)}
                        </td>
                      )}
                      {isVisible('epa') && (
                        <td
                          data-testid={`epa-${t}`}
                          className={cn(
                            'hidden px-2 py-2 font-mono tabular-nums sm:table-cell',
                            r.epaInHouse && 'text-warning',
                          )}
                          title={r.epaInHouse ? 'In-house EPA estimated from scouting data' : undefined}
                        >
                          {r.epa === null ? EM_DASH : fmt(r.epa, 0)}
                          {r.epaInHouse && r.epa !== null ? (
                            <span className="ml-1 text-[10px] text-warning">est</span>
                          ) : null}
                        </td>
                      )}
                      {isVisible('tbaRank') && (
                        <td data-testid={`tba-${t}`} className="hidden px-2 py-2 font-mono tabular-nums sm:table-cell">
                          {r.tbaRank === null ? EM_DASH : String(r.tbaRank)}
                        </td>
                      )}
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
          {/* Radar overlay across the key scouting+EPA metrics. Reuses the row's
              agg + resolved EPA directly — no refetch. Shows its own empty state
              until 2+ teams are selected. */}
          <CardContent className="border-b border-border pb-4">
            <TeamCompare
              teams={selectedRows.map((r) => ({ agg: r.agg, epa: r.epa }))}
            />
          </CardContent>
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
                                'px-2 py-2 font-mono tabular-nums',
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
