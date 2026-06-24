// src/dash/AutoRoutines.tsx
// Multi-robot auto-routines overlay (contracts §7). Builds one read-only
// RoutineOverlay per distinct target team from an alliance's reports, using
// that team's MOST RECENT report (by server_received_at) that carries auto
// data, color-coded, and OMITS our team (3256) from OUR alliance.

import { FieldDiagram } from '@/components/FieldDiagram';
import type { RoutineOverlay } from '@/components/FieldDiagram';
import { OUR_TEAM } from '@/dash/constants';
import type { MsrRow } from '@/dash/types';

export interface AutoRoutinesProps {
  reports: MsrRow[];
  isOurAlliance: boolean;
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

function hasAuto(r: MsrRow): boolean {
  return r.auto_start_position != null || r.auto_path != null;
}

/**
 * Build the per-team routines: most-recent report with auto data per distinct
 * team, omitting OUR_TEAM when this is our alliance, skipping teams with no
 * auto data. Distinct color assigned in team-number order.
 */
function buildRoutines(
  reports: MsrRow[],
  isOurAlliance: boolean
): TeamRoutine[] {
  // distinct team numbers, sorted for stable color assignment
  const teams = Array.from(
    new Set(reports.map((r) => r.target_team_number))
  ).sort((a, b) => a - b);

  const routines: TeamRoutine[] = [];
  for (const teamNumber of teams) {
    if (isOurAlliance && teamNumber === OUR_TEAM) continue;

    const withAuto = reports.filter(
      (r) => r.target_team_number === teamNumber && hasAuto(r)
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

export default function AutoRoutines(props: AutoRoutinesProps): JSX.Element {
  const { reports, isOurAlliance } = props;
  const routines = buildRoutines(reports, isOurAlliance);

  const overlays: RoutineOverlay[] = routines.map((r) => ({
    color: r.color,
    startPosition: r.startPosition,
    path: r.path,
    label: String(r.teamNumber),
  }));

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
