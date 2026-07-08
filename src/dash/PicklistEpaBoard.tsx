// src/dash/PicklistEpaBoard.tsx
// Cluster PICKLIST — Team EPA Board.
// A Field-Control-Console leaderboard of EVERY event team ranked by EPA, with a
// one-tap add-to-picklist control per row. Pure/presentational: it receives the
// already-resolved per-team EPA (Statbotics → local → in-house 'est', mirroring
// RankingView's resolution) and an `onAdd` callback that reuses PicklistView's
// dedupe path, so a board add lands dirty exactly like a manual add.
//
// SIGNATURE element: a quiet horizontal "field-strength" bar behind each row,
// width = epa / maxEpa across the field, tinted by rank tier. Respects reduced
// motion (no animation). Dark theme, shadcn Card primitives, tabular-nums.

import { useMemo } from 'react';
import { Plus, Check, Ban } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { TeamRow, EventEpa } from '@/dash/useEventData';
import type { TeamAgg } from '@/dash/aggregate';

const EM_DASH = '—';

export interface PicklistEpaBoardProps {
  /** Every team participating in the event (identity + nickname). */
  teams: TeamRow[];
  /** Season-wide EPA per team + per-team source, from useEventEpa. */
  epa: EventEpa | undefined;
  /**
   * Per-team scouting aggregate (keyed by team number) — the in-house
   * `scoutingExpectedPoints` fallback when NO external EPA source resolved,
   * exactly like RankingView's `epaFromScouting` path.
   */
  aggByTeam: Map<number, TeamAgg>;
  /** Team numbers already in the picklist (drives the added/disabled state). */
  inListTeams: Set<number>;
  /** Add a team to the picklist (reuses PicklistView's dedupe path). */
  onAdd: (teamNumber: number) => void;
  /**
   * Team numbers flagged "do not pick". DNP lives HERE (browsing every team),
   * not on the curated picklist — you wouldn't list a team you won't pick.
   * Optional so the board still renders without DNP wiring.
   */
  dnpTeams?: Set<number>;
  /** Toggle a team's do-not-pick flag. When absent, the DNP control is hidden. */
  onToggleDnp?: (teamNumber: number) => void;
  /** Open a team on the dashboard's Team tab. When absent, numbers are plain text. */
  onSelectTeam?: (teamNumber: number) => void;
}

/** A fully-resolved board row: identity + resolved EPA + its source label. */
interface BoardRow {
  teamNumber: number;
  nickname: string | null;
  /** Best-available EPA: Statbotics → local → in-house scouting; null = none. */
  epa: number | null;
  /** True when `epa` is our in-house scouting estimate (shows the "est" chip). */
  inHouse: boolean;
}

function fmtEpa(n: number): string {
  return n.toFixed(0);
}

export default function PicklistEpaBoard(props: PicklistEpaBoardProps): JSX.Element {
  const { teams, epa, aggByTeam, inListTeams, onAdd, dnpTeams, onToggleDnp, onSelectTeam } = props;

  const epaByTeam = epa?.epaByTeam;
  const sourceByTeam = epa?.sourceByTeam;
  const epaAvailable = epa?.available === true;
  const epaSource = epa?.source ?? 'none';
  // When NO external EPA source resolved (Statbotics down AND no played-match
  // results), fall back to our in-house scouting estimate — same rule as
  // RankingView so the board and the table agree on every team's number.
  const epaFromScouting = !epaAvailable;

  const rows = useMemo<BoardRow[]>(() => {
    const resolved = teams.map((t): BoardRow => {
      const external = epaAvailable ? epaByTeam?.get(t.team_number) ?? null : null;
      const inHouse = external == null && epaFromScouting;
      const agg = aggByTeam.get(t.team_number);
      const epaValue = inHouse ? agg?.scoutingExpectedPoints ?? null : external;
      // A team's own source label: Statbotics/local from the map, else 'est' for
      // the in-house fallback (only when we actually produced an estimate).
      const externalSource = sourceByTeam?.get(t.team_number);
      const inHouseLabelled =
        epaValue != null && (inHouse || externalSource == null || externalSource === 'none');
      return {
        teamNumber: t.team_number,
        nickname: t.nickname,
        epa: epaValue,
        inHouse: inHouseLabelled,
      };
    });
    // Sort by EPA desc; teams with no EPA (null) sink to the bottom. Ascending
    // team-number tiebreak keeps the order stable/deterministic.
    resolved.sort((a, b) => {
      const av = a.epa ?? Number.NEGATIVE_INFINITY;
      const bv = b.epa ?? Number.NEGATIVE_INFINITY;
      if (av === bv) return a.teamNumber - b.teamNumber;
      return bv - av;
    });
    return resolved;
  }, [teams, epaByTeam, sourceByTeam, epaAvailable, epaFromScouting, aggByTeam]);

  // Field max EPA for the strength bar (positive only — a non-positive max means
  // there's nothing to scale against, so every bar is empty).
  const maxEpa = useMemo(() => {
    let m = 0;
    for (const r of rows) if (r.epa != null && r.epa > m) m = r.epa;
    return m;
  }, [rows]);

  const withEpaCount = useMemo(() => rows.filter((r) => r.epa != null).length, [rows]);

  const sourceNote =
    epaSource === 'statbotics'
      ? null
      : epaSource === 'local'
        ? 'Statbotics offline — EPA shows a local estimate computed from match results.'
        : 'Statbotics & match-result EPA unavailable — EPA shows our in-house estimate from scouting data.';

  return (
    <Card data-testid="picklist-epa-board" className="bg-card">
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-baseline justify-between gap-2">
          <span>Team EPA Board</span>
          <span
            data-testid="epa-board-count"
            className="text-xs font-normal tabular-nums text-muted-foreground"
          >
            {withEpaCount}/{rows.length} ranked
          </span>
        </CardTitle>
        {sourceNote ? (
          <div data-testid="epa-board-source-note" className="text-xs text-warning">
            {sourceNote}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">Season-wide EPA, ranked.</div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div data-testid="epa-board-empty" className="px-6 py-6 text-sm text-muted-foreground">
            No teams for this event yet.
          </div>
        ) : (
          <ul
            data-testid="epa-board-list"
            className="max-h-[24rem] overflow-y-auto"
            role="list"
          >
            {rows.map((r, i) => {
              const rank = i + 1;
              // Tier-tinted strength bar: top 3 brand, next 5 energy, rest muted.
              const tier = rank <= 3 ? 'top' : rank <= 8 ? 'mid' : 'low';
              // Width = epa / maxEpa across the field. When every value is <= 0
              // (e.g. all-zero in-house estimates) maxEpa is 0 and a naive ratio
              // would zero out EVERY bar — instead give each ranked team an equal
              // minimal bar so the board still reads as ranked, not blank.
              const barWidth =
                r.epa == null
                  ? '0%'
                  : maxEpa > 0
                    ? `${Math.max(2, Math.min(100, (r.epa / maxEpa) * 100))}%`
                    : '8%';
              const added = inListTeams.has(r.teamNumber);
              const isDnp = dnpTeams?.has(r.teamNumber) ?? false;
              const dnpBtn = onToggleDnp ? (
                <button
                  type="button"
                  data-testid={`epa-board-dnp-${r.teamNumber}`}
                  aria-pressed={isDnp}
                  aria-label={
                    isDnp
                      ? `Allow picking team ${r.teamNumber}`
                      : `Mark team ${r.teamNumber} do not pick`
                  }
                  title={isDnp ? 'Do not pick — tap to clear' : 'Mark do not pick'}
                  onClick={() => onToggleDnp(r.teamNumber)}
                  className={cn(
                    'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    isDnp
                      ? 'border-destructive bg-destructive/20 text-destructive'
                      : 'border-border text-muted-foreground hover:border-destructive hover:text-destructive',
                  )}
                >
                  <Ban className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null;
              return (
                <li
                  key={r.teamNumber}
                  data-testid={`epa-board-row-${r.teamNumber}`}
                  className="relative flex h-10 items-center gap-2 border-b border-border/40 px-3 last:border-b-0"
                >
                  {/* SIGNATURE: field-strength bar (behind the content, quiet). */}
                  <div
                    aria-hidden="true"
                    data-testid={`epa-board-bar-${r.teamNumber}`}
                    style={{ width: barWidth }}
                    className={cn(
                      'pointer-events-none absolute inset-y-1 left-0 rounded-r-sm motion-safe:transition-[width]',
                      tier === 'top'
                        ? 'bg-brand/20'
                        : tier === 'mid'
                          ? 'bg-energy/15'
                          : 'bg-muted-foreground/10',
                    )}
                  />

                  {/* Foreground content sits above the bar. */}
                  <span
                    className="relative z-10 w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                    aria-hidden="true"
                  >
                    {rank}
                  </span>
                  {onSelectTeam ? (
                    <button
                      type="button"
                      data-testid={`epa-board-team-${r.teamNumber}`}
                      onClick={() => onSelectTeam(r.teamNumber)}
                      aria-label={`Open team ${r.teamNumber}`}
                      className={cn(
                        'relative z-10 w-12 shrink-0 rounded text-left font-semibold tabular-nums hover:text-brand/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                        tier === 'top' ? 'text-brand' : 'text-brand/90',
                      )}
                    >
                      {r.teamNumber}
                    </button>
                  ) : (
                    <span
                      className={cn(
                        'relative z-10 w-12 shrink-0 font-semibold tabular-nums',
                        tier === 'top' ? 'text-brand' : 'text-brand/90',
                      )}
                    >
                      {r.teamNumber}
                    </span>
                  )}
                  <span className="relative z-10 min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {r.nickname ?? ''}
                  </span>
                  <span
                    data-testid={`epa-board-epa-${r.teamNumber}`}
                    className="relative z-10 shrink-0 text-right font-bold tabular-nums"
                  >
                    {r.epa == null ? (
                      <span className="text-muted-foreground">{EM_DASH}</span>
                    ) : (
                      <>
                        {fmtEpa(r.epa)}
                        {r.inHouse ? (
                          <span className="ml-1 align-middle text-[10px] font-medium text-warning">
                            est
                          </span>
                        ) : null}
                      </>
                    )}
                  </span>
                  {/* Right-side controls: when on the picklist, just the ✓. When
                      flagged DNP, only the active DNP toggle. Otherwise an Add
                      button beside the DNP toggle (mutually exclusive states). */}
                  <span className="relative z-10 flex shrink-0 items-center gap-1">
                    {added ? (
                      <span
                        data-testid={`epa-board-added-${r.teamNumber}`}
                        aria-label={`Team ${r.teamNumber} already in picklist`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-success"
                      >
                        <Check className="h-4 w-4" aria-hidden="true" />
                      </span>
                    ) : isDnp ? (
                      dnpBtn
                    ) : (
                      <>
                        {dnpBtn}
                        <button
                          type="button"
                          data-testid={`epa-board-add-${r.teamNumber}`}
                          onClick={() => onAdd(r.teamNumber)}
                          aria-label={`Add team ${r.teamNumber} to picklist`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
