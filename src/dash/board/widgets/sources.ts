import type { BoardData } from './data';
import { teamsOf } from './data';
import type { WidgetConfig } from './registry';

export const DATA_SOURCES = {
  teams: 'Teams', matches: 'Matches', reports: 'Scouting reports', pits: 'Pit reports',
  notes: 'Scouting and strategy notes', aggregates: 'All scouting stats', rankings: 'Standings',
  picklist: 'Picklist', scouts: 'Scouters', assignments: 'Assignments',
} as const;
export type DataSource = keyof typeof DATA_SOURCES;
export interface DataRecord { key: string; label: string; row: Record<string, unknown> }

export function sourceRecords(data: BoardData, config: WidgetConfig): DataRecord[] {
  const source = config.source as DataSource;
  const team = config.team === 'base' ? data.baseTeam : Number(config.team);
  const match = typeof config.match === 'string' && config.match ? (config.match.includes('_') ? config.match : `${data.eventKey}_${config.match}`) : null;
  const rows: DataRecord[] = [];
  const add = (key: string, label: string, row: object, teamNumber?: number, matchKey?: string): void => {
    if (team > 0 && teamNumber !== team) return;
    if (match && matchKey !== match) return;
    if (config.record && key !== config.record) return;
    rows.push({ key, label, row: row as Record<string, unknown> });
  };
  switch (source) {
    case 'teams': for (const t of data.teams) add(String(t.team_number), `${t.team_number} · ${t.nickname ?? ''}`, t, t.team_number); break;
    case 'matches': for (const m of data.matches) {
      if (team > 0 && !teamsOf(m).includes(team)) continue;
      // A schedule can be filtered by any of its six teams.
      add(m.match_key, m.match_key.split('_').pop()!, m, team > 0 ? team : undefined, m.match_key);
    } break;
    case 'reports': for (const r of data.reports.filter((r) => !r.deleted)) add(r.id ?? `${r.match_key}:${r.target_team_number}:${r.scout_id}:${r.station}`, `${r.target_team_number} · ${r.match_key.split('_').pop()}`, r, r.target_team_number, r.match_key); break;
    case 'pits': for (const [t, p] of data.pits) add(String(t), `${t} · pit report`, p, t); break;
    case 'notes':
      for (const r of data.reports.filter((r) => !r.deleted && r.notes?.trim())) add(r.id ?? `${r.match_key}:${r.target_team_number}:${r.scout_id}`, `${r.target_team_number} · ${r.match_key.split('_').pop()}`, { note: r.notes, scout: r.scout_id, match: r.match_key, team: r.target_team_number }, r.target_team_number, r.match_key);
      for (const [key, note] of data.strategyNotes) { const t = Number(key.split(':').pop()); if (note.trim()) add(key, `${t} · strategy`, { note, team: t }, t); }
      break;
    case 'aggregates': for (const [t, a] of data.agg) add(String(t), `${t} · all scouting stats`, a, t); break;
    case 'rankings': for (const [t, standing] of data.standings) add(String(t), `${t} · rank ${standing.rank}`, standing, t); break;
    case 'picklist': for (const entry of data.picklist ?? []) add(String(entry.teamNumber), `${entry.teamNumber} · picklist`, entry, entry.teamNumber); break;
    case 'scouts': for (const s of data.scouts) add(s.id, s.display_name ?? 'Unnamed scouter', s); break;
    case 'assignments': for (const a of data.assignments) add(`${a.match_key}:${a.alliance_color}:${a.station}`, `${a.target_team_number ?? '—'} · ${a.match_key.split('_').pop()}`, a, a.target_team_number ?? undefined, a.match_key); break;
  }
  return rows;
}

export function fieldLabel(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
