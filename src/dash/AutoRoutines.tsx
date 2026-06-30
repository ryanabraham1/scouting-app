// src/dash/AutoRoutines.tsx
// Multi-robot auto-routines overlay (contracts §7). Builds one read-only
// RoutineOverlay per distinct target team from an alliance's reports, using
// that team's MOST RECENT report (by server_received_at) that carries auto
// data, color-coded, and OMITS our team (3256) from OUR alliance.

import { FieldDiagram } from '@/components/FieldDiagram';
import type { RoutineOverlay } from '@/components/FieldDiagram';
import AutoHeatmap from '@/dash/AutoHeatmap';
import { OUR_TEAM } from '@/dash/constants';
import type { MsrRow } from '@/dash/types';

export interface AutoRoutinesProps {
  reports: MsrRow[];
  isOurAlliance: boolean;
  /** The base/own team to omit from OUR alliance overlay. Defaults to OUR_TEAM. */
  baseTeam?: number;
  /**
   * 'latest' (default) = existing per-team polyline overlays (broadcast view).
   * 'all-heatmap' = density heatmap of ALL stored autos. In heatmap mode a single
   * team is isolated via the clickable legend chips (multi-team heatmap is
   * illegible). Mode + selected team are LIFTED to the parent so both alliance
   * columns share one toggle.
   */
  mode?: 'latest' | 'all-heatmap';
  /** Team isolated in 'all-heatmap' mode; null = faint combined heatmap. */
  selectedTeam?: number | null;
  onSelectTeam?: (team: number | null) => void;
}

/**
 * Shared "does this report carry auto data" predicate — single source of truth for
 * BOTH the latest-mode routine builder and the heatmap point collection, so the two
 * never disagree on edge rows (a non-null-but-EMPTY auto_path counts as no data).
 */
export function hasAutoData(r: MsrRow): boolean {
  return r.auto_start_position != null || (r.auto_path?.length ?? 0) > 0;
}

/** Small, visually-distinct palette for per-team overlay colors. */
const PALETTE = [
  '#ef4444', // red
  '#3b82f6', // blue
  '#22c55e', // green
  '#eab308', // yellow
  '#a855f7', // purple
  '#f97316', // orange
];

interface TeamRoutine {
  teamNumber: number;
  color: string;
  startPosition: { x: number; y: number } | null;
  path: { x: number; y: number }[] | null;
}

/**
 * Build the per-team routines: most-recent report with auto data per distinct
 * team, omitting OUR_TEAM when this is our alliance, skipping teams with no
 * auto data. Distinct color assigned in team-number order.
 */
function buildRoutines(
  reports: MsrRow[],
  isOurAlliance: boolean,
  baseTeam: number
): TeamRoutine[] {
  // distinct team numbers, sorted for stable color assignment
  const teams = Array.from(
    new Set(reports.map((r) => r.target_team_number))
  ).sort((a, b) => a - b);

  const routines: TeamRoutine[] = [];
  for (const teamNumber of teams) {
    if (isOurAlliance && teamNumber === baseTeam) continue;

    const withAuto = reports.filter(
      (r) => r.target_team_number === teamNumber && hasAutoData(r)
    );
    if (withAuto.length === 0) continue;

    // most recent by server_received_at (ISO strings sort lexicographically)
    const latest = withAuto.reduce((best, r) =>
      r.server_received_at > best.server_received_at ? r : best
    );

    routines.push({
      teamNumber,
      color: PALETTE[routines.length % PALETTE.length],
      startPosition: latest.auto_start_position,
      path: latest.auto_path,
    });
  }
  return routines;
}

/** Flatten the latest-per-team routines into one raw-space point cloud for the
 *  combined (no-team-isolated) heatmap fallback. */
function collectAllPoints(
  routines: TeamRoutine[],
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (const r of routines) {
    if (r.startPosition) pts.push(r.startPosition);
    if (r.path) for (const p of r.path) pts.push(p);
  }
  return pts;
}

export default function AutoRoutines(props: AutoRoutinesProps): JSX.Element {
  const {
    reports,
    isOurAlliance,
    baseTeam = OUR_TEAM,
    mode = 'latest',
    selectedTeam = null,
    onSelectTeam,
  } = props;
  const routines = buildRoutines(reports, isOurAlliance, baseTeam);

  const overlays: RoutineOverlay[] = routines.map((r) => ({
    color: r.color,
    startPosition: r.startPosition,
    path: r.path,
    label: String(r.teamNumber),
  }));

  // 'all-heatmap': replace polyline overlays with a per-team density heatmap.
  // A multi-team heatmap is illegible, so isolate one team via the (now clickable)
  // legend chips; null = faint combined heatmap of every team on this alliance.
  if (mode === 'all-heatmap') {
    if (routines.length === 0) {
      return (
        <div data-testid="auto-routines">
          <div data-testid="auto-routines-empty">No auto routines recorded.</div>
        </div>
      );
    }
    const heatTeam =
      selectedTeam != null &&
      routines.some((r) => r.teamNumber === selectedTeam)
        ? selectedTeam
        : null;
    return (
      <div data-testid="auto-routines">
        <p
          style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', opacity: 0.7 }}
        >
          Tap a team to isolate its autos.
        </p>
        <ul
          data-testid="auto-routines-legend"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            listStyle: 'none',
            padding: 0,
            margin: '0 0 0.5rem',
          }}
        >
          {routines.map((r) => (
            <li key={r.teamNumber}>
              <button
                type="button"
                data-testid={`auto-routines-team-${r.teamNumber}`}
                aria-pressed={heatTeam === r.teamNumber}
                onClick={() =>
                  onSelectTeam?.(
                    heatTeam === r.teamNumber ? null : r.teamNumber,
                  )
                }
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  minHeight: 44,
                  padding: '0.35rem 0.6rem',
                  borderRadius: 6,
                  cursor: 'pointer',
                  border:
                    heatTeam === r.teamNumber
                      ? `2px solid ${r.color}`
                      : '1px solid rgba(255,255,255,0.2)',
                  background:
                    heatTeam === r.teamNumber
                      ? 'rgba(255,255,255,0.08)'
                      : 'transparent',
                  color: 'inherit',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 12,
                    height: 12,
                    borderRadius: 2,
                    background: r.color,
                  }}
                />
                <span>{r.teamNumber}</span>
              </button>
            </li>
          ))}
        </ul>
        {heatTeam != null ? (
          <AutoHeatmap
            teamNumber={heatTeam}
            reports={reports}
            data-testid="auto-routines"
          />
        ) : (
          // No team isolated: a faint combined heatmap of every alliance team.
          <FieldDiagram
            mode="view"
            heatmap={{ points: collectAllPoints(routines) }}
            data-testid="auto-routines-field"
          />
        )}
      </div>
    );
  }

  return (
    <div data-testid="auto-routines">
      {overlays.length === 0 ? (
        <div data-testid="auto-routines-empty">No auto routines recorded.</div>
      ) : (
        <>
          <FieldDiagram
            mode="view"
            overlays={overlays}
            data-testid="auto-routines-field"
          />
          <ul
            data-testid="auto-routines-legend"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              listStyle: 'none',
              padding: 0,
              margin: '0.5rem 0 0',
            }}
          >
            {routines.map((r) => (
              <li
                key={r.teamNumber}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
              >
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 12,
                    height: 12,
                    borderRadius: 2,
                    background: r.color,
                  }}
                />
                <span>{r.teamNumber}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
