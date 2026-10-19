// src/dash/board/Spotlight.tsx
// Cmd/Ctrl+K search (mockup 02): type anything (a team, a nickname, a match in
// any spelling, a stat, "254 matches", "1678 vs 254") and drop the answer on
// the board as a live widget. Enter inserts at the view center, Shift+Enter
// inserts and zooms to it, Cmd+Enter runs the row's action, and any result can
// be dragged straight onto the canvas. Plan: docs/plans/ryans-board/README.md §11.5.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bot,
  CalendarRange,
  Columns3,
  ClipboardList,
  FileText,
  History,
  LayoutGrid,
  ListOrdered,
  Radio,
  Search,
  Sigma,
  Star,
  Swords,
  TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BoardEditor } from '@/dash/board/editor';
import { useBoard } from '@/dash/board/useBoard';
import { shapeRect } from '@/dash/board/model';
import { METRICS, useBoardData } from '@/dash/board/widgets/data';
import { WIDGETS } from '@/dash/board/widgets/registry';
import { insertWidget, toggleWatch, watchedTeams } from '@/dash/board/widgets/actions';
import {
  recordPick,
  search,
  suggestions,
  type ResultGroup,
  type SearchContext,
  type SearchResult,
} from '@/dash/board/search/interpret';

export const WIDGET_DRAG_TYPE = 'application/x-ryans-board-widget';
const PICKS_KEY = 'ryans-board-search-picks';
const RECENT_KEY = 'ryans-board-search-recent';

const GROUP_LABEL: Record<ResultGroup, string> = {
  best: 'Best match',
  team: 'Team',
  matches: 'Matches',
  rankings: 'Rankings',
  board: 'On this board',
  widgets: 'Widgets',
  actions: 'Actions',
};
const GROUP_ORDER: ResultGroup[] = [
  'best',
  'team',
  'matches',
  'rankings',
  'widgets',
  'board',
  'actions',
];

const KIND_ICON: Record<SearchResult['kind'], typeof Bot> = {
  team: Bot,
  match: Swords,
  schedule: CalendarRange,
  compare: Columns3,
  rankings: ListOrdered,
  teamMetric: Sigma,
  epaHistory: TrendingUp,
  onField: Radio,
  picklist: ClipboardList,
  watchlist: Star,
  watch: Star,
  boardText: FileText,
  widget: LayoutGrid,
};

const EXAMPLES = [
  'qm32',
  'q 32',
  '1678 vs 254',
  'best auto',
  'our next',
  'poofs last match',
  'who climbs',
  'top 10 bsr',
];

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // per-device convenience only
  }
}

export function useSearchContext(editor: BoardEditor): SearchContext {
  const data = useBoardData();
  const order = useBoard(editor, (e) => e.order);
  return useMemo(
    () => ({
      eventKey: data.eventKey,
      teams: data.teams.map((t) => ({ number: t.team_number, nickname: t.nickname })),
      matches: data.matches,
      baseTeam: data.baseTeam,
      watchlist: watchedTeams(editor),
      texts: order
        .filter((s) => s.type === 'text')
        .map((s) => ({ id: s.id, text: s.type === 'text' ? s.text : '' })),
      learned: readJson(PICKS_KEY, {}),
    }),
    // Rebuilt when the spotlight opens (it remounts) and when event data changes.
    [data.eventKey, data.teams, data.matches, data.baseTeam, editor, order],
  );
}

function Chip({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'brand' | 'muted';
}): JSX.Element {
  return (
    <span
      className={cn(
        'shrink-0 rounded-md px-1.5 py-0.5 text-[11px]',
        tone === 'brand' ? 'bg-brand/15 text-brand' : 'bg-white/[0.06] text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return (
    <kbd className="tnum rounded border border-[hsl(0_0%_24%)] px-1 text-[10.5px] text-muted-foreground">
      {children}
    </kbd>
  );
}

export function Spotlight({
  editor,
  onClose,
}: {
  editor: BoardEditor;
  onClose: () => void;
}): JSX.Element {
  const ctx = useSearchContext(editor);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { interpretation, results } = useMemo(() => {
    if (!query.trim()) return { interpretation: null, results: suggestions(ctx) };
    return search(query, ctx);
  }, [query, ctx]);

  // Flatten in display order so arrow keys follow what is on screen.
  const ordered = useMemo(() => {
    const out: SearchResult[] = [];
    for (const g of GROUP_ORDER) for (const r of results) if (r.group === g) out.push(r);
    return out.slice(0, 14);
  }, [results]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const remember = (r: SearchResult): void => {
    if (query.trim()) writeJson(PICKS_KEY, recordPick(readJson(PICKS_KEY, {}), query, r.key));
    const recent = readJson<string[]>(RECENT_KEY, []).filter((q) => q !== query.trim());
    if (query.trim()) writeJson(RECENT_KEY, [query.trim(), ...recent].slice(0, 8));
  };

  const run = (r: SearchResult | undefined, mode: 'insert' | 'zoom' | 'action'): void => {
    if (!r) return;
    remember(r);
    if (r.action?.type === 'focus') {
      const s = editor.shapes.get(r.action.shapeId);
      if (s) {
        editor.setTool('select');
        editor.setSelection([s.id]);
        editor.zoomToRect(shapeRect(s), 1.5, 160);
      }
      onClose();
      return;
    }
    if (r.action?.type === 'watch' && (mode === 'action' || !r.widget)) {
      toggleWatch(editor, r.action.team);
      onClose();
      return;
    }
    if (mode === 'action' && r.widget && r.kind === 'team') {
      const team = Number(r.widget.config.team);
      if (Number.isInteger(team)) toggleWatch(editor, team);
      onClose();
      return;
    }
    if (!r.widget) return;
    insertWidget(editor, r.widget.kind, r.widget.config);
    if (mode === 'zoom') editor.zoomToSelection();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(ordered.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(ordered[active], e.metaKey || e.ctrlKey ? 'action' : e.shiftKey ? 'zoom' : 'insert');
    }
  };

  const current = ordered[active];
  const chips: ReactNode[] = [];
  if (interpretation) {
    for (const t of interpretation.teams.slice(0, 4))
      chips.push(
        <Chip key={`t${t}`} tone="brand">
          team {t}
        </Chip>,
      );
    for (const m of interpretation.matches.slice(0, 2))
      chips.push(
        <Chip key={m.match_key} tone="brand">
          {m.match_key.split('_')[1]}
        </Chip>,
      );
    if (interpretation.metric)
      chips.push(<Chip key="metric">{METRICS[interpretation.metric].label}</Chip>);
    const intents = [...interpretation.intents].filter((i) => i !== 'self' && i !== 'top');
    if (intents.length) chips.push(<Chip key="intent">intent: {intents.join(', ')}</Chip>);
  }

  let lastGroup: ResultGroup | null = null;
  const recent = !query.trim() ? readJson<string[]>(RECENT_KEY, []) : [];

  return (
    <div
      className={cn(
        'absolute inset-0 z-[60] flex items-start justify-center bg-black/55 px-3 pt-[6vh] transition-opacity',
        dragging && 'pointer-events-none opacity-0',
      )}
      data-board-chrome
      data-board-scroll
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Search the board"
        className="w-full max-w-[880px] overflow-hidden rounded-2xl border border-[hsl(0_0%_22%)] bg-[hsl(0_0%_8%)] shadow-[0_24px_60px_rgba(0,0,0,0.6)]"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b border-[hsl(0_0%_15%)] px-4 py-3">
          <Search className="size-[18px] shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teams, matches, stats"
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent text-[17px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="hidden min-w-0 items-center gap-1 overflow-hidden sm:flex">{chips}</div>
          <Kbd>esc</Kbd>
        </div>
        <div className="grid md:grid-cols-[minmax(0,1fr)_340px]">
          <div
            ref={listRef}
            className="max-h-[min(60vh,520px)] overflow-y-auto px-2 py-1.5 md:border-r md:border-[hsl(0_0%_15%)]"
          >
            {recent.length > 0 && (
              <div className="px-2.5 pb-1 pt-2">
                <div className="eyebrow mb-1">Recent</div>
                <div className="flex flex-wrap gap-1">
                  {recent.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setQuery(q)}
                      className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-white/10 hover:text-foreground"
                    >
                      <History className="mr-1 inline size-3" aria-hidden />
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {ordered.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing matches that yet. Try a team number, a nickname or a match like qm32.
              </p>
            )}
            {ordered.map((r, i) => {
              const header = r.group !== lastGroup ? GROUP_LABEL[r.group] : null;
              lastGroup = r.group;
              const Icon = KIND_ICON[r.kind];
              return (
                <div key={r.key}>
                  {header && <div className="eyebrow px-2.5 pb-1 pt-3">{header}</div>}
                  <button
                    type="button"
                    data-idx={i}
                    draggable={!!r.widget}
                    onDragStart={(e) => {
                      if (!r.widget) return;
                      e.dataTransfer.setData(WIDGET_DRAG_TYPE, JSON.stringify(r.widget));
                      e.dataTransfer.effectAllowed = 'copy';
                      remember(r);
                      // Let the canvas under the overlay receive the drop.
                      requestAnimationFrame(() => setDragging(true));
                    }}
                    onDragEnd={() => {
                      setDragging(false);
                      onClose();
                    }}
                    onMouseEnter={() => setActive(i)}
                    onClick={(e) =>
                      run(r, e.metaKey || e.ctrlKey ? 'action' : e.shiftKey ? 'zoom' : 'insert')
                    }
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]',
                      i === active
                        ? 'bg-brand/[0.14] text-foreground'
                        : 'text-foreground/90 hover:bg-white/[0.04]',
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-4 shrink-0',
                        i === active ? 'text-brand' : 'text-muted-foreground',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    {r.subtitle && (
                      <span className="tnum hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
                        {r.subtitle}
                      </span>
                    )}
                    {i === active && <Kbd>{r.widget ? 'enter' : '⌘ enter'}</Kbd>}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="hidden bg-card p-3.5 md:block">
            <div className="eyebrow mb-2">Preview</div>
            {current?.widget ? (
              <Preview widget={current.widget} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {current ? 'Runs an action.' : 'Pick a result to preview it.'}
              </p>
            )}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Enter places it at the center of your view. Drag a result onto the board to drop it
              exactly where you want.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[hsl(0_0%_15%)] px-4 py-2 text-[11.5px] text-muted-foreground">
          <span>Try</span>
          {EXAMPLES.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setQuery(q)}
              className="tnum hover:text-foreground"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Preview({ widget }: { widget: NonNullable<SearchResult['widget']> }): JSX.Element {
  const data = useBoardData();
  const def = WIDGETS[widget.kind];
  const size = def.size(widget.config);
  const scale = Math.min(1, 310 / size.w, 300 / size.h);
  const Icon = def.icon;
  const Body = def.Body;
  return (
    <div style={{ width: size.w * scale, height: size.h * scale }}>
      <div
        className="flex origin-top-left flex-col overflow-hidden rounded-xl border border-[hsl(0_0%_22%)] bg-[hsl(0_0%_8%)] text-[13px] leading-snug"
        style={{ width: size.w, height: size.h, transform: `scale(${scale})` }}
      >
        <div className="flex min-h-[30px] shrink-0 items-center gap-1.5 border-b border-[hsl(0_0%_15%)] px-2.5 text-muted-foreground">
          <Icon className="size-3.5" aria-hidden />
          <span className="eyebrow truncate !tracking-[0.12em]">
            {def.title(widget.config, data)}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <Body config={widget.config} />
        </div>
      </div>
    </div>
  );
}
