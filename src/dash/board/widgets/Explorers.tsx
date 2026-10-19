import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, FileText, Pin, Play, Video } from 'lucide-react';
import { FieldDiagram } from '@/components/FieldDiagram';
import { useTeamPhoto } from '@/dash/useTeamPit';
import { useMatchStream } from '@/dash/matchStream';
import { teamNoteKeyFor } from '@/dash/matchupNotesClient';
import { METRIC_KEYS, METRICS, lastPlayedMatch, nextMatchOf, resolveMatch, resolveTeam, teamMatches, useBoardData } from './data';
import type { WidgetConfig } from './registry';
import { WidgetLink, useWidgetConfig } from './interaction';
import { DATA_SOURCES, fieldLabel, sourceRecords } from './sources';
import { matchLabel } from '../BoardTopBar';

const MatchVideo = lazy(() => import('@/dash/MatchVideo'));
const noSeek = (): void => {};
export function EmptyData({ children }: { children: ReactNode }): JSX.Element {
  return <p className="p-3 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

export function TeamLinks({ team }: { team: number }): JSX.Element {
  return <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-brand">
    <WidgetLink kind="schedule" config={{ team }} label={`Open ${team} schedule`}>Schedule</WidgetLink>
    <WidgetLink kind="teamNotes" config={{ team }} label={`Open ${team} scouting notes`}>Notes</WidgetLink>
    <WidgetLink kind="pit" config={{ team }} label={`Open ${team} pit report`}>Pit</WidgetLink>
    <WidgetLink kind="matchVideo" config={{ team }} label={`Open ${team} match video`}>Video</WidgetLink>
    <WidgetLink kind="stats" config={{ team }} label={`Open all ${team} stats`}>All stats</WidgetLink>
  </div>;
}

export function MatchLinks({ match, team }: { match: string; team?: number | null }): JSX.Element {
  return <div className="flex shrink-0 flex-wrap gap-x-2 text-[11px] text-brand">
    <WidgetLink kind="match" config={{ match, focus: team }} label={`Pin ${matchLabel(match)} details`}>Details</WidgetLink>
    <WidgetLink kind="matchVideo" config={{ match, team }} label={`Pin ${matchLabel(match)} video`}><Video className="mr-1 inline size-3" />Video</WidgetLink>
    <WidgetLink kind="reports" config={{ match, team: team ?? 'all' }} label={`Pin ${matchLabel(match)} scouting reports`}>Scouting</WidgetLink>
    <a href={`/analysis?tab=match&match=${encodeURIComponent(match)}`} className="py-1 hover:underline">Open Analysis</a>
  </div>;
}

export function NotesBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const match = config.match ? resolveMatch(config.match, data)?.match_key : null;
  const reports = data.reports.filter((r) => !r.deleted && r.target_team_number === team && (!config.match || r.match_key === match) && r.notes?.trim()).sort((a, b) => b.server_received_at.localeCompare(a.server_received_at));
  const strategy = team ? data.strategyNotes.get(teamNoteKeyFor(data.eventKey, team)) : null;
  if (!strategy && !reports.length) return <EmptyData>No scouting notes for {team ?? 'this team'} yet. Notes appear here as reports sync.</EmptyData>;
  return <div className="space-y-3 p-3 text-xs">
    {strategy && <section className="rounded-lg bg-brand/10 p-2"><h4 className="mb-1 font-semibold text-brand">Strategy note</h4><p className="whitespace-pre-wrap break-words">{strategy}</p></section>}
    {reports.map((r, i) => <section key={r.id ?? i} className="border-b border-border pb-2 last:border-0">
      <div className="flex items-center justify-between gap-1 text-muted-foreground"><WidgetLink kind="match" config={{ match: r.match_key, focus: team }} label={`Open ${matchLabel(r.match_key)} details`}>{matchLabel(r.match_key)}</WidgetLink><span>{data.scouts.find((s) => s.id === r.scout_id)?.display_name ?? 'Scout report'}</span></div>
      <p className="whitespace-pre-wrap break-words select-text">{r.notes}</p>
      <MatchLinks match={r.match_key} team={team} />
      <WidgetLink kind="data" config={{ source: 'notes', team, record: r.id ?? `${r.match_key}:${r.target_team_number}:${r.scout_id}`, field: 'note', label: `${team} · ${matchLabel(r.match_key)} note` }} label={`Pin ${matchLabel(r.match_key)} scouting note`} className="text-brand"><Pin className="mr-1 inline size-3" />Pin this note</WidgetLink>
    </section>)}
  </div>;
}

export function ReportsBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const rows = sourceRecords(data, { ...config, source: 'reports' });
  if (!rows.length) return <EmptyData>No matching scouting reports yet.</EmptyData>;
  return <div className="space-y-2 p-3 text-xs">{rows.map((r) => <details key={r.key} className="rounded-lg border border-border p-2">
    <summary className="cursor-pointer font-semibold">{r.label} <span className="ml-1 font-normal text-muted-foreground">{data.scouts.find((s) => s.id === r.row.scout_id)?.display_name ?? ''}</span></summary>
    <dl className="my-2 grid grid-cols-2 gap-1"><dt>Fuel points</dt><dd>{String(r.row.fuel_points ?? '—')}</dd><dt>Auto fuel</dt><dd>{String(r.row.auto_fuel ?? '—')}</dd><dt>Defense rating</dt><dd>{String(r.row.defense_rating ?? '—')}</dd></dl>
    {!!r.row.notes && <p className="mb-1 whitespace-pre-wrap break-words">{String(r.row.notes)}</p>}
    <MatchLinks match={String(r.row.match_key)} team={Number(r.row.target_team_number)} />
    <WidgetLink kind="data" config={{ source: 'reports', record: r.key, team: 'all' }} label="Pin full scouting report"><FileText className="mr-1 inline size-3" />Every report field</WidgetLink>
  </details>)}</div>;
}

export function PitBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const pit = team ? data.pits.get(team) : null;
  if (!pit) return <EmptyData>No pit report for {team ?? 'this team'} yet.</EmptyData>;
  return <div className="space-y-2 p-3 text-xs">
    <div className="flex flex-wrap gap-1">{[pit.drivetrain, ...pit.mechanisms, ...pit.capabilities, pit.trenchCapable ? 'Trench capable' : null].filter(Boolean).map((v, i) => <span key={i} className="rounded bg-muted px-1.5 py-1">{v}</span>)}</div>
    <p>Size: {[pit.robotLengthIn, pit.robotWidthIn, pit.robotHeightIn].map((v) => v ?? '—').join(' × ')} in</p>
    <p className="whitespace-pre-wrap break-words">{pit.questionnaire?.additionalComments || pit.notes}</p>
    <div className="flex flex-wrap gap-2 text-brand"><WidgetLink kind="robotPhoto" config={{ team }} label={`Pin ${team} robot photos`}>Robot photos</WidgetLink><WidgetLink kind="autoPath" config={{ team }} label={`Pin ${team} auto paths`}>Auto paths</WidgetLink><WidgetLink kind="data" config={{ source: 'pits', team }} label={`Pin full ${team} pit report`}>Full questionnaire</WidgetLink></div>
    <TeamLinks team={team!} />
  </div>;
}

export function PhotoBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const pit = team ? data.pits.get(team) : null;
  const photo = useTeamPhoto(data.eventKey, team, pit?.photoPath, pit?.photos?.map((p) => p.path));
  const [index, setIndex] = useState(0);
  const urls = photo.data?.urls ?? [];
  const current = index % Math.max(1, urls.length);
  if (!urls.length) return <EmptyData>{photo.isLoading ? 'Loading robot photos…' : 'No robot photo available yet.'}</EmptyData>;
  return <div className="flex h-full flex-col"><img src={urls[current]} alt={`Team ${team} robot`} className="min-h-0 w-full flex-1 object-contain" loading="lazy" /><div className="flex items-center justify-between px-2 text-xs"><button aria-label="Previous robot photo" onClick={() => setIndex((v) => v + urls.length - 1)}><ChevronLeft className="size-4" /></button><span>{current + 1} / {urls.length} · {photo.data?.source}</span><button aria-label="Next robot photo" onClick={() => setIndex((v) => v + 1)}><ChevronRight className="size-4" /></button></div></div>;
}

export function VideoBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const m = config.match ? resolveMatch(config.match, data) : team ? lastPlayedMatch(data.matches, team) ?? nextMatchOf(data.matches, team) : null;
  const update = useWidgetConfig();
  const matches = team ? teamMatches(data.matches, team) : [...data.matches];
  if (!m) return <EmptyData>No match available. Choose a match or team in settings.</EmptyData>;
  if (!matches.some((row) => row.match_key === m.match_key)) matches.unshift(m);
  return <div className="flex h-full flex-col gap-1 p-2">
    <select aria-label="Video match" value={m.match_key} onChange={(e) => update({ match: e.target.value })} className="w-full shrink-0 rounded border border-border bg-card px-2 py-1 text-xs">{matches.map((match) => <option key={match.match_key} value={match.match_key}>{matchLabel(match.match_key)}</option>)}</select>
    <VideoPlayer key={m.match_key} matchKey={m.match_key} onLoad={() => update({ match: m.match_key })} />
    <MatchLinks match={m.match_key} team={team} />
  </div>;
}
function VideoPlayer({ matchKey, onLoad }: { matchKey: string; onLoad: () => void }): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  return loaded ? <Suspense fallback={<EmptyData>Loading player…</EmptyData>}><LoadedVideo matchKey={matchKey} /></Suspense> : <button type="button" onClick={() => { setLoaded(true); onLoad(); }} className="flex min-h-24 flex-1 flex-col items-center justify-center gap-2 rounded-lg bg-muted/40 text-xs text-brand"><Play className="size-7" />Load {matchLabel(matchKey)} video</button>;
}
function LoadedVideo({ matchKey }: { matchKey: string }): JSX.Element {
  const data = useBoardData();
  const m = data.matches.find((m) => m.match_key === matchKey);
  const stream = useMatchStream(data.eventKey, m, noSeek);
  return <MatchVideo matchKey={matchKey} stream={stream.streamProps} onStreamActive={stream.onStreamActive} />;
}

export function AutoPathBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const match = config.match ? resolveMatch(config.match, data)?.match_key : null;
  const reports = data.reports.filter((r) => !r.deleted && r.target_team_number === team && (!config.match || r.match_key === match)).sort((a, b) => b.server_received_at.localeCompare(a.server_received_at));
  const pit = team ? data.pits.get(team) : null;
  const report = reports.find((r) => r.auto_path != null);
  const start = report?.auto_start_position ?? pit?.preferredAutoStartPosition;
  const path = report?.auto_path ?? pit?.preferredAutoPath;
  if (!start && !path) return <EmptyData>No observed auto path yet. An unknown path is different from observing no movement.</EmptyData>;
  return <div className="space-y-2 p-2"><FieldDiagram mode="view" startPosition={start} path={path} mirror={report?.alliance_color === 'blue'} /><p className="text-xs text-muted-foreground">{report ? `${matchLabel(report.match_key)} · observed path` : 'Pit preferred auto path'}{path?.length === 0 ? ' · observed no movement' : ''}</p>{report && <MatchLinks match={report.match_key} team={team} />}</div>;
}

export function StatsBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const agg = team ? data.agg.get(team) : null;
  const metrics = team ? METRIC_KEYS.map((k) => [METRICS[k].label, data.metric(team, k) == null ? '—' : METRICS[k].format(data.metric(team, k)!), k] as const) : [];
  return (
    <div className="p-3 text-xs">
      <div className="grid grid-cols-[1fr_auto] gap-1">
        {metrics.map(([label, value, key]) => (
          <div key={key} className="contents">
            <WidgetLink kind="stat" config={{ expr: `${team}.${key}`, label: `${team} · ${label}` }} label={`Pin ${team} ${label}`}>{label}</WidgetLink>
            <span className="tnum self-center">{value}</span>
          </div>
        ))}
      </div>
      {agg && (
        <div className="mt-2 grid grid-cols-[1fr_auto] gap-1 border-t border-border pt-2">
          {Object.entries(agg).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean').map(([key, value]) => (
            <div key={key} className="contents">
              <WidgetLink kind="data" config={{ source: 'aggregates', team, record: String(team), field: key }} label={`Pin ${fieldLabel(key)}`}>{fieldLabel(key)}</WidgetLink>
              <span className="tnum self-center">{typeof value === 'number' ? Number.isFinite(value) ? Math.round(value * 100) / 100 : '—' : String(value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DataBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const [limit, setLimit] = useState(30);
  const rows = useMemo(() => sourceRecords(data, config), [data, config]);
  if (!rows.length) return <EmptyData>No matching {DATA_SOURCES[config.source as keyof typeof DATA_SOURCES] ?? 'data'} yet.</EmptyData>;
  if (config.field) {
    const value = rows[0].row[String(config.field)];
    return <div className="flex h-full flex-col justify-center gap-2 p-3"><div className="text-xs text-muted-foreground">{fieldLabel(String(config.field))}</div>{value != null && typeof value === 'object' ? <pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(value, null, 2)}</pre> : <div className="tnum break-words text-2xl">{String(value ?? '—')}</div>}</div>;
  }
  return <div className="space-y-2 p-3 text-xs">{rows.slice(0, limit).map((r) => <RecordDetails key={r.key} label={r.label} row={r.row} config={{ ...config, record: r.key }} />)}{rows.length > limit && <button className="text-brand" onClick={() => setLimit((n) => n + 30)}>Show more ({rows.length - limit})</button>}</div>;
}
function RecordDetails({ label, row, config }: { label: string; row: Record<string, unknown>; config: WidgetConfig }): JSX.Element {
  const [open, setOpen] = useState(false);
  return <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="rounded-lg border border-border p-2"><summary className="cursor-pointer font-semibold">{label}</summary>{open && <div className="mt-2 space-y-1"><WidgetLink kind="data" config={config} label={`Pin ${label}`} className="text-brand"><Pin className="mr-1 inline size-3" />Pin record</WidgetLink>{Object.entries(row).map(([key, value]) => <div key={key} className="border-t border-border py-1"><WidgetLink kind="data" config={{ ...config, field: key }} label={`Pin ${fieldLabel(key)}`} className="font-semibold text-muted-foreground">{fieldLabel(key)}</WidgetLink><div className="whitespace-pre-wrap break-words select-text">{value == null ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}</div></div>)}</div>}</details>;
}
