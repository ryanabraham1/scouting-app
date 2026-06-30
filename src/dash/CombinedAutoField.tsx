// src/dash/CombinedAutoField.tsx
// ONE field image for the whole upcoming matchup: each team's MOST RECENT auto
// drawn on the side they'll actually play next. Autos are stored in absolute
// field coords, so a team whose latest auto was scouted on the OTHER alliance has
// it rotated 180° onto their upcoming side (red→red, blue→blue). Red teams use a
// red-ish palette, blue teams a blue-ish one, so the alliances read apart on the
// shared field. Read-only, 100% client-side.

import { FieldDiagram, type RoutineOverlay, type FieldPoint } from '@/components/FieldDiagram';
import { hasAutoData } from '@/dash/AutoRoutines';
import { rotate180, type AllianceColor } from '@/dash/fieldFrame';
import type { MsrRow } from '@/dash/types';

export interface CombinedAutoFieldProps {
  redTeams: number[];
  blueTeams: number[];
  /** All reports for the matchup's teams (filtered per-team here). */
  reports: MsrRow[];
}

// Distinct hues within each alliance so three same-side teams stay legible.
const RED_PALETTE = ['#ef4444', '#f97316', '#fb7185'];
const BLUE_PALETTE = ['#3b82f6', '#22d3ee', '#a855f7'];

interface AutoEntry {
  team: number;
  color: string;
  start: FieldPoint | null;
  path: FieldPoint[] | null;
}

/** A team's most-recent report carrying auto data (or null), with its alliance. */
function latestAuto(
  team: number,
  reports: MsrRow[],
): { start: FieldPoint | null; path: FieldPoint[] | null; alliance: AllianceColor } | null {
  const withAuto = reports.filter((r) => r.target_team_number === team && hasAutoData(r));
  if (withAuto.length === 0) return null;
  const latest = withAuto.reduce((best, r) =>
    r.server_received_at > best.server_received_at ? r : best,
  );
  return {
    start: latest.auto_start_position ?? null,
    path: latest.auto_path ?? null,
    alliance: latest.alliance_color === 'blue' ? 'blue' : 'red',
  };
}

/** Build overlay entries for one alliance, re-framing each auto onto `side`. */
function buildSide(
  teams: number[],
  side: AllianceColor,
  reports: MsrRow[],
  palette: string[],
): AutoEntry[] {
  const out: AutoEntry[] = [];
  for (const team of teams) {
    const a = latestAuto(team, reports);
    if (!a) continue;
    const tf = (p: FieldPoint): FieldPoint => (a.alliance === side ? p : rotate180(p));
    out.push({
      team,
      color: palette[out.length % palette.length],
      start: a.start ? tf(a.start) : null,
      path: a.path ? a.path.map(tf) : null,
    });
  }
  return out;
}

export default function CombinedAutoField(props: CombinedAutoFieldProps): JSX.Element {
  const { redTeams, blueTeams, reports } = props;
  const entries = [
    ...buildSide(redTeams, 'red', reports, RED_PALETTE),
    ...buildSide(blueTeams, 'blue', reports, BLUE_PALETTE),
  ];

  if (entries.length === 0) {
    return (
      <div data-testid="combined-auto-empty" className="text-sm text-muted-foreground">
        No auto routines recorded for this matchup yet.
      </div>
    );
  }

  const overlays: RoutineOverlay[] = entries.map((e) => ({
    color: e.color,
    startPosition: e.start,
    path: e.path,
    label: String(e.team),
  }));

  return (
    <div data-testid="combined-auto" className="flex flex-col gap-2">
      <FieldDiagram mode="view" overlays={overlays} data-testid="combined-auto-field" />
      <ul
        data-testid="combined-auto-legend"
        className="flex flex-wrap gap-x-4 gap-y-1.5"
      >
        {entries.map((e) => (
          <li key={e.team} className="flex items-center gap-1.5 text-sm text-foreground">
            <span
              aria-hidden
              className="inline-block size-3 rounded-sm"
              style={{ background: e.color }}
            />
            <span className="tabular-nums">{e.team}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
