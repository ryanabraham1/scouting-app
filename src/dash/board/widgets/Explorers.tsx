// src/dash/board/widgets/Explorers.tsx
// Detail widgets: scouting notes, scouting reports, pit report, robot photos,
// match video, auto paths, all team stats and the app data explorer. Built
// from the shared pieces in ui.tsx so they match the rest of the board:
// mono section labels, hairline key/value rows, tags, and compact icon links
// (click pins the related card next to this one, drag places it).
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  MapPin,
  MessageSquare,
  Pin,
  Play,
  Sigma,
  Swords,
  Video,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { FieldDiagram } from '@/components/FieldDiagram';
import { useTeamPhoto } from '@/dash/useTeamPit';
import { useMatchStream } from '@/dash/matchStream';
import { teamNoteKeyFor } from '@/dash/matchupNotesClient';
import { METRIC_KEYS, METRICS, lastPlayedMatch, nextMatchOf, resolveMatch, resolveTeam, teamMatches, useBoardData } from './data';
import type { WidgetConfig } from './registry';
import { WidgetLink, useWidgetConfig } from './interaction';
import { DATA_SOURCES, fieldLabel, sourceRecords } from './sources';
import { EmptyState, IconLinks, KeyValues, Section, Tag, type IconLinkSpec } from './ui';
import { matchLabel } from '../BoardTopBar';

const MatchVideo = lazy(() => import('@/dash/MatchVideo'));
const noSeek = (): void => {};

export function EmptyData({ children }: { children: ReactNode }): JSX.Element {
  return <EmptyState>{children}</EmptyState>;
}

export function teamLinkSpecs(team: number): IconLinkSpec[] {
  return [
    { kind: 'schedule', config: { team }, icon: CalendarRange, label: `Open ${team} schedule` },
    { kind: 'teamNotes', config: { team }, icon: MessageSquare, label: `Open ${team} scouting notes` },
    { kind: 'pit', config: { team }, icon: Wrench, label: `Open ${team} pit report` },
    { kind: 'matchVideo', config: { team }, icon: Video, label: `Open ${team} match video` },
    { kind: 'stats', config: { team }, icon: Sigma, label: `Open all ${team} stats` },
  ];
}

export function TeamLinks({ team, className }: { team: number; className?: string }): JSX.Element {
  return <IconLinks links={teamLinkSpecs(team)} className={className} />;
}

export function MatchLinks({ match, team, className }: { match: string; team?: number | null; className?: string }): JSX.Element {
  const m = matchLabel(match);
  return (
    <IconLinks
      className={className}
      links={[
        { kind: 'match', config: { match, focus: team }, icon: Swords, label: `Pin ${m} details` },
        { kind: 'matchVideo', config: { match, team }, icon: Video, label: `Pin ${m} video` },
        { kind: 'reports', config: { match, team: team ?? 'all' }, icon: FileText, label: `Pin ${m} scouting reports` },
      ]}
    >
      <a
        href={`/analysis?tab=match&match=${encodeURIComponent(match)}`}
        aria-label={`Open ${m} in Analysis`}
        title={`Open ${m} in Analysis`}
        className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-white/10 hover:text-foreground"
      >
        <ExternalLink className="size-3.5" aria-hidden />
      </a>
    </IconLinks>
  );
}

function MatchChip({ match, team }: { match: string; team?: number | null }): JSX.Element {
  return (
    <WidgetLink
      kind="match"
      config={{ match, focus: team }}
      label={`Open ${matchLabel(match)} details`}
      className="tnum !min-h-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-semibold text-foreground"
    >
      {matchLabel(match)}
    </WidgetLink>
  );
}

// ------------------------------------------------------------------ notes
export function NotesBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const match = config.match ? resolveMatch(config.match, data)?.match_key : null;
  const reports = data.reports
    .filter((r) => !r.deleted && r.target_team_number === team && (!config.match || r.match_key === match) && r.notes?.trim())
    .sort((a, b) => b.server_received_at.localeCompare(a.server_received_at));
  const strategy = team ? data.strategyNotes.get(teamNoteKeyFor(data.eventKey, team)) : null;
  if (!strategy && !reports.length) {
    return <EmptyState icon={MessageSquare}>No scouting notes for {team ?? 'this team'} yet. They appear here as reports sync.</EmptyState>;
  }
  return (
    <div className="space-y-3 px-3 py-2.5">
      {strategy && (
        <Section label="Strategy note">
          <p className="whitespace-pre-wrap break-words rounded-lg bg-brand/10 px-2.5 py-2 leading-relaxed">{strategy}</p>
        </Section>
      )}
      {reports.length > 0 && (
        <Section label="Scout notes" aside={`${reports.length} ${reports.length === 1 ? 'report' : 'reports'}`}>
          <ul className="divide-y divide-[hsl(0_0%_14%)]">
            {reports.map((r, i) => {
              const scout = data.scouts.find((s) => s.id === r.scout_id)?.display_name;
              return (
                <li key={r.id ?? i} className="py-2 first:pt-0">
                  <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                    <MatchChip match={r.match_key} team={team} />
                    <span className="min-w-0 truncate">{scout ?? 'Scout report'}</span>
                    <IconLinks
                      className="-my-1 ml-auto"
                      links={[
                        { kind: 'matchVideo', config: { match: r.match_key, team }, icon: Video, label: `Pin ${matchLabel(r.match_key)} video` },
                        {
                          kind: 'data',
                          config: { source: 'notes', team, record: r.id ?? `${r.match_key}:${r.target_team_number}:${r.scout_id}`, field: 'note', label: `${team} · ${matchLabel(r.match_key)} note` },
                          icon: Pin,
                          label: `Pin ${matchLabel(r.match_key)} scouting note`,
                        },
                      ]}
                    />
                  </div>
                  <p className="mt-1 select-text whitespace-pre-wrap break-words leading-relaxed">{r.notes}</p>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- reports
export function ReportsBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const rows = sourceRecords(data, { ...config, source: 'reports' });
  if (!rows.length) return <EmptyState icon={FileText}>No matching scouting reports yet.</EmptyState>;
  return (
    <ul className="space-y-1.5 px-2.5 py-2.5">
      {rows.map((r) => {
        const row = r.row;
        const matchKey = String(row.match_key);
        const team = Number(row.target_team_number);
        const scout = data.scouts.find((s) => s.id === row.scout_id)?.display_name;
        const flags = [row.no_show && 'No show', row.died && 'Died', row.tipped && 'Tipped'].filter(Boolean) as string[];
        return (
          <li key={r.key} className="rounded-lg bg-white/[0.03] px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <MatchChip match={matchKey} team={team} />
              <span className="tnum font-semibold">{team}</span>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">{scout ?? ''}</span>
              <span className="tnum ml-auto text-base font-semibold">{row.fuel_points == null ? '—' : String(row.fuel_points)}</span>
              <span className="text-[11px] text-muted-foreground">pts</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Tag>Auto {String(row.auto_fuel ?? '—')}</Tag>
              <Tag>Defense {String(row.defense_rating ?? '—')}</Tag>
              {flags.map((f) => (
                <Tag key={f} tone="bad">{f}</Tag>
              ))}
            </div>
            {!!row.notes && <p className="mt-1.5 line-clamp-3 select-text whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{String(row.notes)}</p>}
            <div className="mt-1 flex items-center justify-end">
              <IconLinks
                links={[
                  { kind: 'matchVideo', config: { match: matchKey, team }, icon: Video, label: `Pin ${matchLabel(matchKey)} video` },
                  { kind: 'data', config: { source: 'reports', record: r.key, team: 'all' }, icon: FileText, label: 'Pin full scouting report' },
                ]}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// -------------------------------------------------------------------- pit
export function PitBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const pit = team ? data.pits.get(team) : null;
  if (!pit || team == null) return <EmptyState icon={Wrench}>No pit report for {team ?? 'this team'} yet.</EmptyState>;
  const dims = [pit.robotLengthIn, pit.robotWidthIn, pit.robotHeightIn];
  const robot: [ReactNode, ReactNode, string][] = [];
  if (dims.some((d) => d != null)) robot.push(['Size', `${dims.map((v) => v ?? '—').join(' × ')} in`, 'size']);
  if (pit.visionSystem) robot.push(['Vision', pit.visionSystem, 'vision']);
  if (pit.batteryCount != null) robot.push(['Batteries', `${pit.batteryCount}${pit.chargerCount != null ? ` · ${pit.chargerCount} chargers` : ''}`, 'batt']);
  if (pit.intakeSources.length) robot.push(['Intake', pit.intakeSources.join(', '), 'intake']);
  const notes = pit.questionnaire?.additionalComments || pit.notes;
  return (
    <div className="space-y-3 px-3 py-2.5">
      <div className="flex flex-wrap gap-1">
        {pit.drivetrain && <Tag tone="brand">{pit.drivetrain}</Tag>}
        {pit.trenchCapable && <Tag tone="good">Trench capable</Tag>}
        {[...pit.mechanisms, ...pit.capabilities].map((v) => (
          <Tag key={v}>{v}</Tag>
        ))}
      </div>
      {robot.length > 0 && (
        <Section label="Robot">
          <KeyValues rows={robot} />
        </Section>
      )}
      {pit.matchStrategy.length > 0 && (
        <Section label="Strategy">
          <div className="flex flex-wrap gap-1">
            {pit.matchStrategy.map((s) => (
              <Tag key={s}>{s}</Tag>
            ))}
          </div>
        </Section>
      )}
      {notes && (
        <Section label="Notes">
          <p className="select-text whitespace-pre-wrap break-words leading-relaxed">{notes}</p>
        </Section>
      )}
      <div className="flex items-center justify-between border-t border-[hsl(0_0%_14%)] pt-1.5">
        <IconLinks
          links={[
            { kind: 'robotPhoto', config: { team }, icon: ImageIcon, label: `Pin ${team} robot photos` },
            { kind: 'autoPath', config: { team }, icon: MapPin, label: `Pin ${team} auto paths` },
            { kind: 'data', config: { source: 'pits', team }, icon: FileText, label: `Pin full ${team} pit report` },
          ]}
        />
        <TeamLinks team={team} />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- photos
export function PhotoBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const pit = team ? data.pits.get(team) : null;
  const photo = useTeamPhoto(data.eventKey, team, pit?.photoPath, pit?.photos?.map((p) => p.path));
  const [index, setIndex] = useState(0);
  const urls = photo.data?.urls ?? [];
  const current = index % Math.max(1, urls.length);
  if (!urls.length) return <EmptyState icon={ImageIcon}>{photo.isLoading ? 'Loading robot photos…' : 'No robot photo available yet.'}</EmptyState>;
  const nav = 'inline-flex size-7 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur hover:bg-black/80';
  return (
    <div className="relative h-full bg-black/30">
      <img src={urls[current]} alt={`Team ${team} robot`} className="h-full w-full object-contain" loading="lazy" draggable={false} />
      <div className="absolute inset-x-0 bottom-2 flex items-center justify-center gap-2">
        {urls.length > 1 && (
          <button type="button" aria-label="Previous robot photo" className={nav} onClick={() => setIndex((v) => v + urls.length - 1)}>
            <ChevronLeft className="size-4" aria-hidden />
          </button>
        )}
        <span className="tnum rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white backdrop-blur">
          {current + 1} / {urls.length}
          {photo.data?.source ? ` · ${photo.data.source}` : ''}
        </span>
        {urls.length > 1 && (
          <button type="button" aria-label="Next robot photo" className={nav} onClick={() => setIndex((v) => v + 1)}>
            <ChevronRight className="size-4" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ video
export function VideoBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const m = config.match ? resolveMatch(config.match, data) : team ? lastPlayedMatch(data.matches, team) ?? nextMatchOf(data.matches, team) : null;
  const update = useWidgetConfig();
  const matches = team ? teamMatches(data.matches, team) : [...data.matches];
  if (!m) return <EmptyState icon={Video}>No match to show. Choose a match or team in the settings.</EmptyState>;
  if (!matches.some((row) => row.match_key === m.match_key)) matches.unshift(m);
  return (
    <div className="flex h-full flex-col gap-2 p-2.5">
      <div className="flex shrink-0 items-center gap-2">
        <select
          aria-label="Video match"
          value={m.match_key}
          onChange={(e) => update({ match: e.target.value })}
          className="tnum min-w-0 flex-1 rounded-lg border border-[hsl(0_0%_22%)] bg-transparent px-2 py-1 text-xs text-foreground outline-none focus:border-brand"
        >
          {matches.map((match) => (
            <option key={match.match_key} value={match.match_key} className="bg-card">
              {matchLabel(match.match_key)}
            </option>
          ))}
        </select>
        <MatchLinks match={m.match_key} team={team} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg">
        <VideoPlayer key={m.match_key} matchKey={m.match_key} onLoad={() => update({ match: m.match_key })} />
      </div>
    </div>
  );
}

function VideoPlayer({ matchKey, onLoad }: { matchKey: string; onLoad: () => void }): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  return loaded ? (
    <Suspense fallback={<EmptyState>Loading player…</EmptyState>}>
      <LoadedVideo matchKey={matchKey} />
    </Suspense>
  ) : (
    <button
      type="button"
      onClick={() => {
        setLoaded(true);
        onLoad();
      }}
      className="group flex h-full min-h-24 w-full flex-col items-center justify-center gap-2 bg-white/[0.03] text-xs text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
    >
      <span className="inline-flex size-11 items-center justify-center rounded-full bg-brand/15 text-brand transition-transform group-hover:scale-105">
        <Play className="ml-0.5 size-5" fill="currentColor" aria-hidden />
      </span>
      Load {matchLabel(matchKey)} video
    </button>
  );
}

function LoadedVideo({ matchKey }: { matchKey: string }): JSX.Element {
  const data = useBoardData();
  const m = data.matches.find((row) => row.match_key === matchKey);
  const stream = useMatchStream(data.eventKey, m, noSeek);
  return <MatchVideo matchKey={matchKey} stream={stream.streamProps} onStreamActive={stream.onStreamActive} />;
}

// -------------------------------------------------------------- auto path
export function AutoPathBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const match = config.match ? resolveMatch(config.match, data)?.match_key : null;
  const reports = data.reports
    .filter((r) => !r.deleted && r.target_team_number === team && (!config.match || r.match_key === match))
    .sort((a, b) => b.server_received_at.localeCompare(a.server_received_at));
  const pit = team ? data.pits.get(team) : null;
  const report = reports.find((r) => r.auto_path != null);
  const start = report?.auto_start_position ?? pit?.preferredAutoStartPosition;
  const path = report?.auto_path ?? pit?.preferredAutoPath;
  if (!start && !path) return <EmptyState icon={MapPin}>No observed auto path yet. Unknown is different from observing no movement.</EmptyState>;
  return (
    <div className="flex h-full flex-col gap-2 p-2.5">
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg">
        <FieldDiagram mode="view" startPosition={start} path={path} mirror={report?.alliance_color === 'blue'} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {report ? <MatchChip match={report.match_key} team={team} /> : <Tag>Pit preference</Tag>}
        <Tag tone={path?.length === 0 ? 'warn' : 'muted'}>{path?.length === 0 ? 'Observed no movement' : report ? 'Observed path' : 'Planned path'}</Tag>
        {report && <MatchLinks match={report.match_key} team={team} className="ml-auto" />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ stats
const RATE_FIELDS = /rate|reliability|confidence/i;

function formatAgg(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (RATE_FIELDS.test(key) && value >= 0 && value <= 1) return `${Math.round(value * 100)}%`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function StatsBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const team = resolveTeam(config.team, data);
  const agg = team ? data.agg.get(team) : null;
  if (team == null) return <EmptyState icon={Sigma}>Pick a team in the settings.</EmptyState>;
  const model: [ReactNode, ReactNode, string][] = METRIC_KEYS.map((k) => {
    const v = data.metric(team, k);
    return [
      <WidgetLink key={k} kind="stat" config={{ expr: `${team}.${k}`, label: `${team} · ${METRICS[k].label}` }} label={`Pin ${team} ${METRICS[k].label}`} className="!min-h-0 hover:text-foreground">
        {METRICS[k].label}
      </WidgetLink>,
      v == null ? '—' : METRICS[k].format(v),
      k,
    ];
  });
  const scouting: [ReactNode, ReactNode, string][] = agg
    ? Object.entries(agg)
        .filter(([k, v]) => k !== 'teamNumber' && (typeof v === 'number' || typeof v === 'boolean'))
        .map(([k, v]) => [
          <WidgetLink key={k} kind="data" config={{ source: 'aggregates', team, record: String(team), field: k }} label={`Pin ${fieldLabel(k)}`} className="!min-h-0 hover:text-foreground">
            {fieldLabel(k)}
          </WidgetLink>,
          formatAgg(k, v),
          k,
        ])
    : [];
  return (
    <div className="space-y-3 px-3 py-2.5">
      <Section label="Model" aside="click a stat to pin it">
        <KeyValues rows={model} />
      </Section>
      {scouting.length > 0 && (
        <Section label="Scouting averages" aside={`${agg?.matchesScouted ?? 0} reports`}>
          <KeyValues rows={scouting} />
        </Section>
      )}
    </div>
  );
}

// ------------------------------------------------------------ data explorer
function formatValue(value: unknown): ReactNode {
  if (value == null || value === '') return <span className="text-muted-foreground">—</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return <pre className="max-w-[220px] overflow-x-auto whitespace-pre-wrap break-words text-left font-mono text-[10.5px] text-muted-foreground">{JSON.stringify(value, null, 1)}</pre>;
  return String(value);
}

export function DataBody({ config }: { config: WidgetConfig }): JSX.Element {
  const data = useBoardData();
  const [limit, setLimit] = useState(30);
  const rows = useMemo(() => sourceRecords(data, config), [data, config]);
  const sourceName = DATA_SOURCES[config.source as keyof typeof DATA_SOURCES] ?? 'data';
  if (!rows.length) return <EmptyState icon={FileText}>No matching {sourceName.toLowerCase()} yet.</EmptyState>;
  if (config.field) {
    const value = rows[0].row[String(config.field)];
    const isObject = value != null && typeof value === 'object';
    return (
      <div className="flex h-full flex-col justify-center gap-1 px-3 py-2.5">
        <span className="eyebrow !text-[10px]">{fieldLabel(String(config.field))}</span>
        {isObject ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>
        ) : (
          <div className={cn('select-text break-words', typeof value === 'string' && value.length > 24 ? 'text-sm leading-relaxed' : 'tnum text-3xl font-semibold')}>
            {value == null || value === '' ? '—' : String(value)}
          </div>
        )}
        <span className="text-[11px] text-muted-foreground">{rows[0].label}</span>
      </div>
    );
  }
  return (
    <div className="px-2.5 py-2">
      <div className="mb-1.5 flex items-center px-0.5 text-[11px] text-muted-foreground">
        <span>
          {rows.length} {rows.length === 1 ? 'record' : 'records'}
        </span>
        <span className="ml-auto">expand to pin a field</span>
      </div>
      <ul className="space-y-1">
        {rows.slice(0, limit).map((r) => (
          <RecordDetails key={r.key} label={r.label} row={r.row} config={{ ...config, record: r.key }} />
        ))}
      </ul>
      {rows.length > limit && (
        <button type="button" className="mt-2 w-full rounded-lg bg-white/[0.04] py-1.5 text-xs text-muted-foreground hover:bg-white/[0.08] hover:text-foreground" onClick={() => setLimit((n) => n + 30)}>
          Show {Math.min(30, rows.length - limit)} more of {rows.length - limit}
        </button>
      )}
    </div>
  );
}

function RecordDetails({ label, row, config }: { label: string; row: Record<string, unknown>; config: WidgetConfig }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg bg-white/[0.03]">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-semibold"
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
          <span className="tnum truncate">{label}</span>
        </button>
        <IconLinks className="pr-1" links={[{ kind: 'data', config, icon: Pin, label: `Pin ${label}` }]} />
      </div>
      {open && (
        <dl className="divide-y divide-[hsl(0_0%_14%)] px-2.5 pb-2 text-xs">
          {Object.entries(row).map(([key, value]) => (
            <div key={key} className="flex items-baseline justify-between gap-3 py-1">
              <dt className="shrink-0">
                <WidgetLink kind="data" config={{ ...config, field: key }} label={`Pin ${fieldLabel(key)}`} className="!min-h-0 text-muted-foreground hover:text-foreground">
                  {fieldLabel(key)}
                </WidgetLink>
              </dt>
              <dd className="tnum min-w-0 select-text break-words text-right">{formatValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}
