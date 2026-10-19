// src/dash/board/widgets/WidgetInspector.tsx
// Settings for the single selected widget (top-right panel slot): which team,
// which match, metric, count, expression. Every change is one undo step.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Star, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBoard } from '@/dash/board/useBoard';
import type { BoardEditor } from '@/dash/board/editor';
import type { WidgetShape } from '@/dash/board/model';
import { PANEL } from '@/dash/board/BoardChrome';
import { WIDGETS, type WidgetConfig, type WidgetKind } from '@/dash/board/widgets/registry';
import { METRICS, METRIC_KEYS, type MetricKey } from '@/dash/board/widgets/data';
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
  const [draft, setDraft] = useState(value === 'base' ? '' : String(value ?? ''));
  const commit = (): void => {
    const n = Number(draft);
    if (Number.isInteger(n) && n > 0) onChange(n);
  };
  return (
    <div className="flex gap-1.5">
      <input
        className={FIELD}
        inputMode="numeric"
        placeholder={value === 'base' ? 'Our team' : 'Team #'}
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

export function WidgetInspector({ editor }: { editor: BoardEditor }): JSX.Element | null {
  const selection = useBoard(editor, (e) => e.selection);
  const shapes = useBoard(editor, (e) => e.shapes);
  useBoard(editor, (e) => e.version);
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
    case 'schedule':
      body = (
        <Row label="Team">
          <TeamField value={c.team} onChange={(t) => set({ team: t })} />
        </Row>
      );
      break;
    case 'match':
      body = (
        <Row label="Match">
          <div className="flex gap-1.5">
            <input
              className={FIELD}
              placeholder={c.match === 'our-next' ? 'Our next match' : 'qm32, sf2m1'}
              defaultValue={c.match === 'our-next' ? '' : String(c.match ?? '').replace(/^.*_/, '')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              onBlur={(e) => {
                const v = e.target.value.trim().toLowerCase().replace(/\s+/g, '');
                if (v) set({ match: v });
              }}
            />
            <button
              type="button"
              onClick={() => set({ match: 'our-next' })}
              className={cn('shrink-0 rounded-lg px-2 text-xs font-semibold', c.match === 'our-next' ? 'bg-brand/15 text-brand' : 'bg-white/5 hover:bg-white/10')}
            >
              Our next
            </button>
          </div>
        </Row>
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
