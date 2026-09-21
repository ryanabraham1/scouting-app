// src/dash/Leaderboard.tsx
// Broadcast-style official event LEADERBOARD, fed by The Blue Alliance rankings.
// PURE + presentational: props in → JSX out (no fetching, no QueryClient). The
// orchestrator fetches `/event/{key}/rankings` and passes the parsed rows in.
//
// Exports:
//   - parseTbaRankings(data): defensive parser, never throws.
//   - Leaderboard (default): the full ranking table Card.
//   - EventRankSummary: "Event Rankings" StatTiles for OUR team.

import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { TeamLink } from '@/components/ui/TeamLink';

const EM_DASH = '—';

/** A single resolved leaderboard row (one team's official standing). */
export interface RankRow {
  rank: number;
  teamNumber: number;
  rp: number; // ranking score (avg RP)
  total: number; // total ranking points: TBA's real value when available, else ≈ rp * matchesPlayed
  /** True when `total` is our reconstructed estimate (rp × games), not a real TBA field. */
  totalApprox: boolean;
  record: string; // "W-L-T"
  wins: number;
  losses: number;
  ties: number;
}

/** Standard TBA `/event/{key}/rankings` payload (every field read defensively). */
interface TbaRankingsResponse {
  rankings?: unknown;
}

/** Coerce an unknown into a finite number, or `fallback` when it isn't one. */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A finite number, or null when the value isn't a usable number. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Parse a TBA rankings payload into sorted `RankRow[]`. Never throws: malformed
 * rows (missing/garbled team_key or non-numeric rank) are skipped.
 */
export function parseTbaRankings(data: unknown): RankRow[] {
  if (typeof data !== 'object' || data === null) return [];
  const rankings = (data as TbaRankingsResponse).rankings;
  if (!Array.isArray(rankings)) return [];

  const rows: RankRow[] = [];
  for (const entry of rankings) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as Record<string, unknown>;

    if (typeof r.rank !== 'number' || !Number.isFinite(r.rank)) continue;
    if (typeof r.team_key !== 'string') continue;
    const m = /^frc(\d+)$/.exec(r.team_key);
    if (!m) continue;
    const teamNumber = Number(m[1]);

    const sortOrders = Array.isArray(r.sort_orders) ? r.sort_orders : [];
    const rp = num(sortOrders[0], 0);

    const rec =
      typeof r.record === 'object' && r.record !== null
        ? (r.record as Record<string, unknown>)
        : null;
    const wins = rec ? num(rec.wins, 0) : 0;
    const losses = rec ? num(rec.losses, 0) : 0;
    const ties = rec ? num(rec.ties, 0) : 0;

    // Games played: prefer the record, fall back to matches_played when absent.
    const gamesPlayed = rec ? wins + losses + ties : num(r.matches_played, 0);

    // Total RP: prefer a REAL TBA field when present (some payloads carry the
    // running total under a `total_rp` field or `extra_stats[0]`) over a
    // reconstruction. Only fall back to `round(rp × games)` — flagged approximate
    // so the UI never implies a precision TBA didn't give us.
    const extraStats = Array.isArray(r.extra_stats) ? r.extra_stats : [];
    const realTotal = finiteOrNull(r.total_rp) ?? finiteOrNull(extraStats[0]);
    const total = realTotal != null ? realTotal : Math.round(rp * gamesPlayed);
    const totalApprox = realTotal == null;

    rows.push({
      rank: r.rank,
      teamNumber,
      rp,
      total,
      totalApprox,
      record: `${wins}-${losses}-${ties}`,
      wins,
      losses,
      ties,
    });
  }

  rows.sort((a, b) => a.rank - b.rank);
  return rows;
}

export interface LeaderboardProps {
  rows: RankRow[];
  ourTeam: number;
  className?: string;
}

/**
 * The official event leaderboard: a scrollable, broadcast-style table of every
 * ranked team. OUR team's row is highlighted.
 */
export default function Leaderboard(props: LeaderboardProps): JSX.Element {
  const { rows, ourTeam, className } = props;

  return (
    <div data-testid="dash-leaderboard" className={cn('text-foreground', className)}>
      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Leaderboard</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <div
              data-testid="dash-leaderboard-empty"
              className="p-6 text-sm text-muted-foreground"
            >
              No rankings available yet.
            </div>
          ) : (
            <div className="max-h-[28rem] overflow-x-auto overflow-y-auto">
              <table className="w-full min-w-[20rem] border-collapse text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border">
                    <th className="px-2 py-2 text-left font-medium text-muted-foreground">#</th>
                    <th className="px-2 py-2 text-left font-medium text-muted-foreground">Team</th>
                    <th className="px-2 py-2 text-right font-medium text-muted-foreground">RP</th>
                    <th
                      className="px-2 py-2 text-right font-medium text-muted-foreground"
                      title="Total ranking points. '~' marks an estimate (avg RP × games) when TBA doesn't report a real total."
                    >
                      Tot
                    </th>
                    <th className="px-2 py-2 text-left font-medium text-muted-foreground">Rec</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const isOurs = row.teamNumber === ourTeam;
                    return (
                      <tr
                        key={row.teamNumber}
                        data-testid={`leaderboard-row-${row.teamNumber}`}
                        data-our={isOurs ? 'true' : undefined}
                        className={cn(
                          'border-b border-border/50',
                          isOurs ? 'bg-brand/15 font-semibold' : 'hover:bg-accent/30',
                        )}
                      >
                        <td className="px-2 py-2 tabular-nums">{row.rank}</td>
                        <td className="px-2 py-2 tabular-nums font-medium">
                          <TeamLink team={row.teamNumber} />
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.rp.toFixed(3)}</td>
                        <td
                          data-testid={`leaderboard-total-${row.teamNumber}`}
                          className="px-2 py-2 text-right tabular-nums"
                          title={
                            row.totalApprox
                              ? 'Estimated total RP (avg RP × games) — TBA did not report a real total'
                              : undefined
                          }
                        >
                          {row.totalApprox ? '~' : ''}
                          {row.total}
                        </td>
                        <td
                          className={cn(
                            'px-2 py-2 tabular-nums',
                            row.wins > row.losses
                              ? 'text-success'
                              : row.losses > row.wins
                                ? 'text-warning'
                                : undefined,
                          )}
                        >
                          {row.record}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export interface EventRankSummaryProps {
  /** OUR team's official row, or null when we're absent / rankings are missing. */
  row: RankRow | null;
  /** Total ranked teams at the event, or null when unknown. */
  teamCount: number | null;
}

/**
 * "Event Rankings" tiles for OUR team: record, rank (out of the field), avg RP.
 * Degrades to em-dashes when our row is unavailable.
 */
/**
 * A colored broadcast stat tile: small label + big tabular value, with an
 * optional `sub` node in the corner. Shared by the Event/Season ranking blocks
 * so both match the broadcast look (light tiles popping off the dark page).
 */
export function RankTile({
  label,
  value,
  testid,
  tone,
  big = false,
  sub = null,
}: {
  label: string;
  value: string;
  testid: string;
  // Semantic broadcast tiles: green=success (trusted/good standing),
  // blue=brand (cyan, season/world context), warning=amber (below .500),
  // gray=neutral (no data yet).
  tone: 'green' | 'blue' | 'warning' | 'gray';
  big?: boolean;
  sub?: ReactNode;
}): JSX.Element {
  const bg = {
    green: 'bg-emerald-100 text-emerald-950',
    blue: 'bg-cyan-100 text-cyan-950',
    warning: 'bg-amber-100 text-amber-950',
    gray: 'bg-neutral-200 text-neutral-900',
  }[tone];
  const labelColor = {
    green: 'text-emerald-700',
    blue: 'text-cyan-700',
    warning: 'text-amber-700',
    gray: 'text-neutral-600',
  }[tone];
  return (
    <div className={cn('rounded-lg px-4 py-3', bg)}>
      <div className="flex items-center justify-between gap-2">
        <div className={cn('text-sm font-semibold', labelColor)}>{label}</div>
        {sub}
      </div>
      <div
        data-testid={testid}
        className={cn('mt-1 font-black leading-none tabular-nums', big ? 'text-5xl' : 'text-3xl')}
      >
        {value}
      </div>
    </div>
  );
}

export function EventRankSummary(props: EventRankSummaryProps): JSX.Element {
  const { row, teamCount } = props;

  const record = row ? row.record : EM_DASH;
  const rankValue = row ? `${row.rank}${teamCount ? ` / ${teamCount}` : ''}` : EM_DASH;
  const avgRp = row ? row.rp.toFixed(3) : EM_DASH;

  return (
    <div data-testid="dash-event-rank" className="flex flex-col gap-2">
      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
        Event Rankings
      </div>
      <RankTile tone="green" big label="Event Record" value={record} testid="dash-event-record" />
      <div className="grid grid-cols-2 gap-2">
        <RankTile tone="green" label="Event Rank" value={rankValue} testid="dash-event-rank-value" />
        <RankTile tone="green" label="Avg RP" value={avgRp} testid="dash-event-avg-rp" />
      </div>
    </div>
  );
}
