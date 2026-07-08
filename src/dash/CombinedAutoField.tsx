// src/dash/CombinedAutoField.tsx
// ONE field image for the whole upcoming matchup: each team's auto drawn on the
// side they'll actually play next. Autos are stored in absolute field coords, so
// a routine scouted on the OTHER alliance is rotated 180° onto their upcoming side
// (red→red, blue→blue). Red teams use a red-ish palette, blue teams a blue-ish
// one, so the alliances read apart on the shared field.
//
// By default each team shows the type of auto it MOST RECENTLY ran. Because teams
// often run more than one routine, each team gets a small option selector — the
// same shape-clustered "auto options" the Team tab shows (`groupAutoPaths`) — so
// staff can flip any team to a different routine they've been scouted running.
// Read-only, 100% client-side.

import { useMemo, useState } from 'react';
import { FieldDiagram, type RoutineOverlay } from '@/components/FieldDiagram';
import { hasAutoData } from '@/dash/AutoRoutines';
import { collectPoints } from '@/dash/AutoHeatmap';
import { groupAutoPaths, autoPathToFrame, type AutoGroup } from '@/dash/autoGrouping';
import { type AllianceColor } from '@/dash/fieldFrame';
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

/** A, B, C … label for each discovered auto option (mirrors the Team tab). */
function optionLetter(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

export interface TeamAuto {
  team: number;
  color: string;
  /** The alliance side this team plays in the upcoming match. */
  side: AllianceColor;
  /** Distinct auto options, blue-framed, most-run first (Team-tab grouping). */
  groups: AutoGroup[];
  /** Index of the group holding the team's most-recently-scouted auto. */
  defaultIdx: number;
}

/**
 * A team's auto options (the same shape-clustered groups the Team tab shows) plus
 * the index of the group containing its most-recent auto — null when it has none.
 */
function teamAuto(team: number, side: AllianceColor, color: string, reports: MsrRow[]): TeamAuto | null {
  const { paths: rawPaths } = collectPoints(reports, team);
  if (rawPaths.length === 0) return null;
  // Canonicalize to the BLUE frame before grouping (mirror of AutoOptions) so a
  // routine run on red folds together with its blue-side equivalent.
  const paths = rawPaths.map((p) => autoPathToFrame(p, 'blue'));
  const groups = groupAutoPaths(paths);

  // The group containing the most-recent (largest server_received_at) auto — the
  // type the team last ran is what we default the selector to.
  const withAuto = reports.filter((r) => r.target_team_number === team && hasAutoData(r));
  const latest = withAuto.reduce((best, r) =>
    r.server_received_at > best.server_received_at ? r : best,
  );
  const found = groups.findIndex((g) => g.members.some((m) => m.matchKey === latest.match_key));

  return { team, color, side, groups, defaultIdx: found < 0 ? 0 : found };
}

/** Build each alliance's teams that have auto data, assigning palette by position. */
function buildSide(teams: number[], side: AllianceColor, reports: MsrRow[], palette: string[]): TeamAuto[] {
  const out: TeamAuto[] = [];
  for (const team of teams) {
    const t = teamAuto(team, side, palette[out.length % palette.length], reports);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Every matchup team's shape-clustered auto options (the same grouping the
 * interactive card below and the Team tab use), red side first. Pure — the
 * Strategy tab's whiteboard uses this to offer a per-team A/B/C switcher.
 */
export function matchupTeamAutos(
  redTeams: number[],
  blueTeams: number[],
  reports: MsrRow[],
): TeamAuto[] {
  return [
    ...buildSide(redTeams, 'red', reports, RED_PALETTE),
    ...buildSide(blueTeams, 'blue', reports, BLUE_PALETTE),
  ];
}

/** One team's chosen auto option as a read-only overlay, re-framed onto the
 *  side it will play. `idx` is clamped so a stale selection can't throw. */
export function overlayForAutoOption(t: TeamAuto, idx: number): RoutineOverlay {
  const safe = Math.min(Math.max(0, idx), t.groups.length - 1);
  const rep = autoPathToFrame(t.groups[safe].representative, t.side);
  return { color: t.color, startPosition: rep.start, path: rep.path, label: String(t.team) };
}

/**
 * Each matchup team's DEFAULT (most-recently-run) auto routine, re-framed onto
 * the side it will play, as read-only overlays — the Strategy tab's whiteboard
 * renders these UNDER the ink so a coach can draw plays over real routines.
 */
export function defaultMatchupOverlays(
  redTeams: number[],
  blueTeams: number[],
  reports: MsrRow[],
): RoutineOverlay[] {
  return matchupTeamAutos(redTeams, blueTeams, reports).map((t) =>
    overlayForAutoOption(t, t.defaultIdx),
  );
}

export default function CombinedAutoField(props: CombinedAutoFieldProps): JSX.Element {
  const { redTeams, blueTeams, reports } = props;

  const teams = useMemo<TeamAuto[]>(
    () => [
      ...buildSide(redTeams, 'red', reports, RED_PALETTE),
      ...buildSide(blueTeams, 'blue', reports, BLUE_PALETTE),
    ],
    [redTeams, blueTeams, reports],
  );

  // Per-team selected option index (team number → group index). Absent → default.
  const [sel, setSel] = useState<Record<number, number>>({});

  if (teams.length === 0) {
    return (
      <div data-testid="combined-auto-empty" className="text-sm text-muted-foreground">
        No auto routines recorded for this matchup yet.
      </div>
    );
  }

  // Resolve each team's currently-shown option, re-framed onto its play side.
  const shown = teams.map((t) => {
    const idx = Math.min(sel[t.team] ?? t.defaultIdx, t.groups.length - 1);
    const rep = autoPathToFrame(t.groups[idx].representative, t.side);
    return { t, idx, rep };
  });

  const overlays: RoutineOverlay[] = shown.map(({ t, rep }) => ({
    color: t.color,
    startPosition: rep.start,
    path: rep.path,
    label: String(t.team),
  }));

  const optBtn = (active: boolean): string =>
    [
      'rounded px-1.5 py-0.5 text-xs font-medium tabular-nums transition-colors',
      active
        ? 'bg-zinc-100 text-zinc-900'
        : 'border border-zinc-700 text-zinc-400 hover:text-zinc-200',
    ].join(' ');

  return (
    <div data-testid="combined-auto" className="flex flex-col gap-2">
      <FieldDiagram mode="view" overlays={overlays} data-testid="combined-auto-field" />
      <ul data-testid="combined-auto-legend" className="flex flex-col gap-2">
        {shown.map(({ t, idx }) => (
          <li
            key={t.team}
            data-testid={`combined-auto-team-${t.team}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-foreground"
          >
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-3 rounded-sm"
                style={{ background: t.color }}
              />
              <span className="tabular-nums font-medium">{t.team}</span>
            </span>
            {t.groups.length > 1 ? (
              <span
                role="group"
                aria-label={`Auto option for team ${t.team}`}
                className="flex flex-wrap items-center gap-1"
              >
                {t.groups.map((g, i) => (
                  <button
                    key={g.id}
                    type="button"
                    data-testid={`combined-auto-team-${t.team}-opt-${i}`}
                    aria-pressed={i === idx}
                    className={optBtn(i === idx)}
                    onClick={() => setSel((s) => ({ ...s, [t.team]: i }))}
                    title={`Ran ${g.members.length}×${i === t.defaultIdx ? ' · most recent' : ''}`}
                  >
                    {optionLetter(i)}
                    <span className="ml-1 opacity-70">{g.members.length}×</span>
                    {i === t.defaultIdx ? (
                      <span aria-hidden className="ml-1 text-brand">
                        •
                      </span>
                    ) : null}
                  </button>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
