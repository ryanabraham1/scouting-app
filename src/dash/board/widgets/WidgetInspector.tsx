// src/dash/board/widgets/WidgetInspector.tsx
// Settings for the single selected widget (top-right panel slot): which team,
// which match, metric, count, expression. Every change is one undo step.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Star, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBoard } from '@/dash/board/useBoard';
import type { BoardEditor } from '@/dash/board/editor';
import type { WidgetShape } from '@/dash/board/model';
import { PANEL } from '@/dash/board/BoardChrome';
import { DATA_SOURCES } from './sources';
import { WIDGETS, type WidgetConfig, type WidgetKind } from '@/dash/board/widgets/registry';
import { METRICS, METRIC_KEYS, byPlayOrder, isPlayed, resolveTeam, teamMatches, teamsOf, useBoardData, type MetricKey } from '@/dash/board/widgets/data';
import { matchLabel } from '@/dash/board/BoardTopBar';
import { toggleWatch, updateWidgetConfig, watchedTeams } from '@/dash/board/widgets/actions';

const FIELD =
  'w-full min-w-0 rounded-lg border border-[hsl(0_0%_22%)] bg-transparent px-2 py-1 text-sm text-foreground outline-none focus:border-brand';

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="eyebrow mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div className="grid gap-1 text-xs font-semibold" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn('rounded-md py-1.5', value === v ? 'bg-white/10 text-foreground' : 'hover:bg-white/5')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TeamField({ value, onChange, allowBase = true }: { value: unknown; onChange: (v: number | 'base') => void; allowBase?: boolean }): JSX.Element {
  const [draft, setDraft] = useState(value === 'base' || value === 'all' ? '' : String(value ?? ''));
  useEffect(() => setDraft(value === 'base' || value === 'all' ? '' : String(value ?? '')), [value]);
  const commit = (): void => {
    const n = Number(draft);
    if (Number.isInteger(n) && n > 0) onChange(n);
  };
  return (
    <div className="flex gap-1.5">
      <input
        className={FIELD}
        inputMode="numeric"
        placeholder={value === 'base' ? 'Our team' : value === 'all' ? 'All teams' : 'Team #'}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {allowBase && (
        <button
          type="button"
          onClick={() => {
            setDraft('');
            onChange('base');
          }}
          className={cn('shrink-0 rounded-lg px-2 text-xs font-semibold', value === 'base' ? 'bg-brand/15 text-brand' : 'bg-white/5 hover:bg-white/10')}
        >
          Us
        </button>
      )}
    </div>
  );
}

function TeamsField({ value, onChange, max = 8 }: { value: unknown; onChange: (teams: number[]) => void; max?: number }): JSX.Element {
  const teams = Array.isArray(value) ? (value as number[]) : [];
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const n = Number(draft);
    if (Number.isInteger(n) && n > 0 && !teams.includes(n) && teams.length < max) onChange([...teams, n]);
    setDraft('');
  };
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap gap-1">
        {teams.map((t) => (
          <span key={t} className="tnum inline-flex items-center gap-1 rounded-md bg-white/5 py-0.5 pl-1.5 pr-0.5 text-xs">
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(teams.filter((x) => x !== t))} className="rounded p-0.5 hover:bg-white/10">
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
      {teams.length < max && (
        <input
          className={FIELD}
          inputMode="numeric"
          placeholder="Add team #, Enter"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          onBlur={() => draft && add()}
        />
      )}
    </div>
  );
}

/** First number in a short match label: qm32 -> 32, sf2m1 -> 2. */
function labelNumber(label: string): string {
  return label.match(/\d+/)?.[0] ?? '';
}

/** Tap a match instead of typing its key. Starts on `team`'s matches (the
 * ones anyone actually wants), with an All toggle and a number filter. */
function MatchPicker({ value, team, onChange, extra }: { value: unknown; team: number | null; onChange: (matchKey: string) => void; extra?: ReactNode }): JSX.Element {
  const data = useBoardData();
  const [scope, setScope] = useState<'team' | 'all'>(team ? 'team' : 'all');
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const selected = typeof value === 'string' && value !== 'our-next' ? matchLabel(value) : null;
  const matches = useMemo(() => {
    const base = scope === 'team' && team ? teamMatches(data.matches, team) : [...data.matches].sort(byPlayOrder);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((m) => {
      const label = matchLabel(m.match_key);
      return /^\d+$/.test(q) ? labelNumber(label) === q : label.startsWith(q);
    });
  }, [data.matches, scope, team, query]);
  const nextKey = useMemo(() => matches.find((m) => !isPlayed(m))?.match_key, [matches]);

  // Open on the chosen match, else the next unplayed one.
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? list?.querySelector<HTMLElement>('[data-next]');
    if (list && el) list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
  }, [scope]);

  // No schedule (offline before preload, or a fresh event): typing still works.
  if (!data.matches.length) {
    return (
      <input
        className={FIELD}
        aria-label="Widget match"
        placeholder="qm32, sf2m1"
        defaultValue={selected ?? ''}
        onBlur={(e) => {
          const v = e.target.value.trim().toLowerCase().replace(/\s+/g, '');
          if (v) onChange(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex gap-1.5">
        {team != null && (
          <div className="grid shrink-0 grid-cols-2 gap-1 text-xs font-semibold">
            {(['team', 'all'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={cn('rounded-md px-2 py-1.5', scope === s ? 'bg-white/10 text-foreground' : 'hover:bg-white/5')}
              >
                {s === 'team' ? (team === data.baseTeam ? 'Ours' : team) : 'All'}
              </button>
            ))}
          </div>
        )}
        <input
          className={FIELD}
          aria-label="Find match"
          inputMode="numeric"
          placeholder="Match #"
          value={query}
          onChange={(e) => setQuery(e.target.value.replace(/\s+/g, '').slice(0, 8))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches.length === 1) onChange(matches[0].match_key);
          }}
        />
      </div>
      {extra}
      <div ref={listRef} role="group" aria-label="Matches" className="relative grid max-h-52 grid-cols-4 gap-1 overflow-auto overscroll-contain pr-0.5">
        {matches.map((m) => {
          const label = matchLabel(m.match_key);
          const on = label === selected;
          const ours = data.baseTeam > 0 && teamsOf(m).includes(data.baseTeam);
          return (
            <button
              key={m.match_key}
              type="button"
              aria-pressed={on}
              data-next={m.match_key === nextKey ? '' : undefined}
              onClick={() => onChange(m.match_key)}
              className={cn(
                'tnum min-h-9 rounded-md text-xs font-semibold',
                on ? 'bg-brand/20 text-brand' : 'bg-white/5 hover:bg-white/10',
                !on && isPlayed(m) && 'text-muted-foreground',
                !on && m.match_key === nextKey && 'ring-1 ring-inset ring-brand/60',
                scope === 'all' && ours && !on && 'text-foreground underline decoration-brand underline-offset-2',
              )}
            >
              {label}
            </button>
          );
        })}
        {!matches.length && <p className="col-span-4 py-2 text-center text-xs text-muted-foreground">No matching matches</p>}
      </div>
    </div>
  );
}

export function WidgetInspector({ editor }: { editor: BoardEditor }): JSX.Element | null {
  const selection = useBoard(editor, (e) => e.selection);
  const shapes = useBoard(editor, (e) => e.shapes);
  if (selection.size !== 1) return null;
  const shape = shapes.get([...selection][0]);
  if (!shape || shape.type !== 'widget') return null;
  const def = WIDGETS[shape.kind as WidgetKind];
  if (!def) return null;
  return <Inspector key={shape.id} editor={editor} shape={shape} />;
}

function Inspector({ editor, shape }: { editor: BoardEditor; shape: WidgetShape }): JSX.Element {
  const kind = shape.kind as WidgetKind;
  const def = WIDGETS[kind];
  const c = shape.config;
  const set = (patch: WidgetConfig, resize = false): void => updateWidgetConfig(editor, shape, { ...c, ...patch }, resize);
  const Icon = def.icon;
  const watched = watchedTeams(editor);
  const data = useBoardData();
  const team = typeof c.team === 'number' ? c.team : null;

  let body: ReactNode = null;
  switch (kind) {
    case 'team':
      body = (
        <>
          <Row label="Team">
            <TeamField value={c.team} onChange={(t) => set({ team: t })} />
          </Row>
          <Row label="Size">
            <Seg
              value={c.variant === 'compact' ? 'compact' : 'detailed'}
              options={[
                ['detailed', 'Detailed'],
                ['compact', 'Compact'],
              ]}
              onChange={(v) => {
                const cfg = { ...c, variant: v };
                const size = def.size(cfg);
                editor.updateShape(shape.id, { config: cfg, w: size.w, h: size.h });
              }}
            />
          </Row>
        </>
      );
      break;
    case 'teamNotes':
    case 'pit':
    case 'robotPhoto':
    case 'stats':
    case 'nextMatch':
    case 'schedule':
      body = (
        <Row label="Team">
          <TeamField value={c.team} onChange={(t) => set({ team: t })} />
        </Row>
      );
      break;
    case 'reports':
    case 'matchVideo':
    case 'autoPath':
    case 'data':
      body = <>
        {kind === 'data' && <Row label="Data source"><select aria-label="Data source" className={FIELD} value={String(c.source ?? 'reports')} onChange={(e) => set({ source: e.target.value, record: undefined, field: undefined, match: undefined })}>{Object.entries(DATA_SOURCES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Row>}
        <Row label="Team"><TeamField value={c.team} onChange={(team) => set({ team, record: undefined })} /></Row>
        {(kind === 'reports' || kind === 'data') && <button type="button" onClick={() => set({ team: 'all', record: undefined })} className="text-xs text-brand">All teams</button>}
        <div>
          <span className="eyebrow mb-1 block">Match (optional)</span>
          <MatchPicker
            key={String(c.team)}
            value={c.match}
            team={resolveTeam(c.team, data)}
            onChange={(match) => set({ match, record: undefined })}
            extra={c.match ? <button type="button" className="mb-1.5 text-xs text-brand" onClick={() => set({ match: undefined })}>Any match</button> : null}
          />
        </div>
        {kind === 'matchVideo' && c.match && <button type="button" className="text-xs text-brand" onClick={() => set({ match: undefined })}>Follow this team's latest match</button>}
        {kind === 'data' && (c.record || c.field) && <button type="button" className="text-xs text-brand" onClick={() => set({ record: undefined, field: undefined })}>Show all matching records</button>}
      </>;
      break;
    case 'match':
      body = (
        <div>
          <span className="eyebrow mb-1 block">Match</span>
          <MatchPicker
            value={c.match}
            team={data.baseTeam > 0 ? data.baseTeam : null}
            onChange={(match) => set({ match })}
            extra={
              <button
                type="button"
                onClick={() => set({ match: 'our-next' })}
                className={cn('mb-1.5 w-full rounded-lg py-1.5 text-xs font-semibold', c.match === 'our-next' ? 'bg-brand/15 text-brand' : 'bg-white/5 hover:bg-white/10')}
              >
                Always our next match
              </button>
            }
          />
        </div>
      );
      break;
    case 'watchlist':
      body = (
        <Row label="Teams">
          <TeamsField value={c.teams} max={20} onChange={(teams) => set({ teams }, true)} />
        </Row>
      );
      break;
    case 'compare':
    case 'epaHistory':
      body = (
        <>
          <Row label="Teams">
            <TeamsField value={c.teams} max={kind === 'epaHistory' ? 4 : 6} onChange={(teams) => set({ teams }, kind === 'compare')} />
          </Row>
          {kind === 'compare' && (
            <div>
              <span className="eyebrow mb-1 block">Stats</span>
              <div className="flex flex-wrap gap-1">
                {METRIC_KEYS.map((k) => {
                  const list = Array.isArray(c.metrics) ? (c.metrics as MetricKey[]) : [];
                  const on = list.includes(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => set({ metrics: on ? list.filter((x) => x !== k) : [...list, k] }, true)}
                      className={cn('rounded-md px-1.5 py-0.5 text-xs', on ? 'bg-brand/15 text-brand' : 'bg-white/5 hover:bg-white/10')}
                    >
                      {METRICS[k].label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      );
      break;
    case 'rankings':
      body = (
        <>
          <Row label="Stat">
            <select className={FIELD} value={String(c.metric ?? 'bsr')} onChange={(e) => set({ metric: e.target.value }, false)}>
              {METRIC_KEYS.map((k) => (
                <option key={k} value={k}>
                  {METRICS[k].label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="How many">
            <input
              className={FIELD}
              type="number"
              min={3}
              max={30}
              defaultValue={Number(c.count) || 5}
              onBlur={(e) => set({ count: Math.max(3, Math.min(30, Number(e.target.value) || 5)) }, true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </Row>
          <Row label="Order">
            <Seg
              value={c.dir === 'asc' ? 'asc' : c.dir === 'desc' ? 'desc' : 'auto'}
              options={[
                ['auto', 'Best'],
                ['desc', 'High'],
                ['asc', 'Low'],
              ]}
              onChange={(v) => set({ dir: v === 'auto' ? undefined : v })}
            />
          </Row>
        </>
      );
      break;
    case 'stat':
      body = (
        <>
          <Row label="Expression">
            <input
              className={cn(FIELD, 'font-mono text-xs')}
              defaultValue={String(c.expr ?? '')}
              placeholder="1678.bsr - our.bsr"
              onBlur={(e) => set({ expr: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </Row>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Use team.stat with {METRIC_KEYS.join(', ')}; our.stat for us; + − × ÷ and parentheses.
          </p>
          <Row label="Label">
            <input className={FIELD} defaultValue={String(c.label ?? '')} placeholder="BSR gap" onBlur={(e) => set({ label: e.target.value })} />
          </Row>
        </>
      );
      break;
    case 'picklist':
      body = (
        <Link to="/dashboard?tab=picklist" className="block rounded-lg bg-white/5 px-2 py-1.5 text-center text-xs font-semibold hover:bg-white/10">
          Open Picklist
        </Link>
      );
      break;
    case 'onField':
      body = <p className="text-xs text-muted-foreground">Follows the live Nexus field status.</p>;
      break;
  }

  return (
    <div className={cn(PANEL, 'w-[236px] space-y-2.5 p-3')} aria-label="Widget settings">
      <div className="flex items-center gap-1.5 text-foreground">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-semibold">{def.label}</span>
        <button type="button" aria-label="Close widget settings" className="ml-auto rounded p-1 hover:bg-white/10" onClick={() => editor.setSelection([])}><X className="size-3.5" /></button>
        {team != null && (kind === 'team' || kind === 'schedule') && (
          <button
            type="button"
            onClick={() => toggleWatch(editor, team)}
            aria-pressed={watched.includes(team)}
            title={watched.includes(team) ? 'Remove from watchlist' : 'Add to watchlist'}
            className={cn('ml-auto rounded-md p-1 hover:bg-white/10', watched.includes(team) ? 'text-warning' : 'text-muted-foreground')}
          >
            <Star className="size-4" fill={watched.includes(team) ? 'currentColor' : 'none'} aria-hidden />
          </button>
        )}
      </div>
      {body}
    </div>
  );
}
