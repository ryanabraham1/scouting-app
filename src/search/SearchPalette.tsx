// src/search/SearchPalette.tsx
// The spotlight dialog itself (lazy-loaded by GlobalSearch on first open).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Users, Swords, LayoutGrid } from 'lucide-react';
import { router } from '@/routes/router';
import { cn } from '@/lib/utils';
import { useActiveEvent } from '@/dash/useActiveEvent';
import { useEventMatches, useEventTeams } from '@/dash/useEventData';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';
import type { SearchContext } from '@/dash/board/search/interpret';
import { appSearch, appSuggestions, type AppResult, type AppResultGroup } from '@/search/appSearch';

const GROUP_ICON: Record<AppResultGroup, typeof Users> = { teams: Users, matches: Swords, pages: LayoutGrid };

function useSearchContext(): SearchContext | null {
  const { eventKey } = useActiveEvent();
  const teams = useEventTeams(eventKey);
  const matches = useEventMatches(eventKey);
  return useMemo(() => {
    if (!eventKey || (!teams.data && !matches.data)) return null;
    return {
      eventKey,
      teams: (teams.data ?? []).map((t) => ({ number: t.team_number, nickname: t.nickname })),
      matches: matches.data ?? [],
      baseTeam: getStoredBaseTeam(),
    };
  }, [eventKey, teams.data, matches.data]);
}

export default function SearchPalette({ onClose }: { onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ctx = useSearchContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => (query.trim() ? appSearch(query, ctx) : appSuggestions(ctx)), [query, ctx]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => inputRef.current?.focus(), []);

  const go = (r: AppResult | undefined): void => {
    if (!r) return;
    onClose();
    void router.navigate(r.to);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Search the app" data-testid="app-search" className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                go(results[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Team, match, page or setting"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="app-search-results"
            aria-activedescendant={results[active] ? `app-search-${active}` : undefined}
            className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground sm:block">esc</kbd>
        </div>
        <ul id="app-search-results" role="listbox" className="max-h-[60vh] overflow-y-auto p-2">
          {results.map((r, i) => {
            const Icon = GROUP_ICON[r.group];
            return (
              <li
                key={r.key}
                id={`app-search-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={() => go(r)}
                className={cn('flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3 py-2', i === active && 'bg-accent')}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.title}</span>
                  {r.subtitle ? <span className="block truncate text-xs text-muted-foreground">{r.subtitle}</span> : null}
                </span>
              </li>
            );
          })}
          {!results.length ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches “{query}”</li> : null}
        </ul>
      </div>
    </div>
  );
}
