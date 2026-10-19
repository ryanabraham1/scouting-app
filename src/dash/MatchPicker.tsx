// src/dash/MatchPicker.tsx — the desktop (`md`+) match picker for the Analysis
// Match tab: filter chips, a search box, prev/next, and one scrollable row of
// match chips showing each match's red/blue score (or start time) at a glance.
// Phones keep MatchView's stacked list instead.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MatchRow } from '@/dash/useEventData';
import { isUnplayed, shortTime } from '@/dash/matchOrder';
import { formatMatchKeyRaw, isQualMatchKey } from '@/lib/formatMatch';
import { COVERAGE_STATION_CAP } from '@/dash/aggregate';

type Filter = 'all' | 'ours' | 'upcoming' | 'playoffs';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ours', label: 'Ours' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'playoffs', label: 'Playoffs' },
];

const BADGE: Record<string, string> = { Qual: 'Q', Eighth: 'EF', Quarter: 'QF', Semi: 'SF', Final: 'F' };

/** Chip label from the shared formatter: "Qual 12" → "Q12", "Semi 3-2" → "SF3-2". */
function chipLabel(matchKey: string): string {
  const label = formatMatchKeyRaw(matchKey);
  const m = /^(\w+) (.+)$/.exec(label);
  return m && BADGE[m[1]] ? `${BADGE[m[1]]}${m[2]}` : label;
}

function hasTeam(m: MatchRow, team: number): boolean {
  return [m.red1, m.red2, m.red3, m.blue1, m.blue2, m.blue3].includes(team);
}

export interface MatchPickerProps {
  /** Matches already sorted in play order and filtered by `search`. */
  matches: MatchRow[];
  selected: string | null;
  onSelect: (matchKey: string) => void;
  search: string;
  onSearch: (value: string) => void;
  ourTeam: number;
  /** Stations scouted per match, for the coverage tick. */
  stationsCovered: (matchKey: string) => number;
  className?: string;
}

export default function MatchPicker({
  matches,
  selected,
  onSelect,
  search,
  onSearch,
  ourTeam,
  stationsCovered,
  className,
}: MatchPickerProps): JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const stripRef = useRef<HTMLDivElement>(null);

  const counts = useMemo(
    () => ({
      all: matches.length,
      ours: matches.filter((m) => hasTeam(m, ourTeam)).length,
      upcoming: matches.filter(isUnplayed).length,
      playoffs: matches.filter((m) => !isQualMatchKey(m.match_key)).length,
    }),
    [matches, ourTeam],
  );

  const shown = useMemo(() => {
    switch (filter) {
      case 'ours':
        return matches.filter((m) => hasTeam(m, ourTeam));
      case 'upcoming':
        return matches.filter(isUnplayed);
      case 'playoffs':
        return matches.filter((m) => !isQualMatchKey(m.match_key));
      default:
        return matches;
    }
  }, [matches, filter, ourTeam]);

  // Keep the selected chip in view when it changes (deep link, prev/next).
  useEffect(() => {
    if (!selected) return;
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-match-chip="${selected}"]`);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [selected, shown]);

  const index = selected ? shown.findIndex((m) => m.match_key === selected) : -1;
  const step = (delta: number): void => {
    if (shown.length === 0) return;
    const next = index < 0 ? (delta > 0 ? 0 : shown.length - 1) : index + delta;
    if (next >= 0 && next < shown.length) onSelect(shown[next].match_key);
  };

  return (
    <section
      aria-label="Pick a match"
      data-testid="match-picker"
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter matches" className="inline-flex gap-0.5 rounded-[10px] bg-muted p-[3px]">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              data-testid={`match-filter-${f.id}`}
              onClick={() => setFilter(f.id)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium transition-colors',
                filter === f.id ? 'bg-card text-foreground shadow-[0_0_0_1px_hsl(var(--border))]' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
              <span className={cn('font-mono text-xs tabular-nums', f.id === 'ours' ? 'text-brand' : 'text-muted-foreground')}>
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex h-9 w-56 items-center gap-2 rounded-lg border border-border px-2.5 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <input
              type="search"
              inputMode="search"
              data-testid="match-picker-search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Jump to team or match"
              aria-label="Search matches by team or match number"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </label>
          <button
            type="button"
            aria-label="Previous match"
            data-testid="match-prev"
            onClick={() => step(-1)}
            disabled={shown.length === 0 || index === 0}
            className="flex size-9 items-center justify-center rounded-lg border border-border text-foreground hover:bg-muted/60 disabled:opacity-40"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next match"
            data-testid="match-next"
            onClick={() => step(1)}
            disabled={shown.length === 0 || index === shown.length - 1}
            className="flex size-9 items-center justify-center rounded-lg border border-border text-foreground hover:bg-muted/60 disabled:opacity-40"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <p data-testid="match-picker-empty" className="text-sm text-muted-foreground">
          {matches.length === 0 && search ? 'No matches match your search.' : 'No matches in this filter.'}
        </p>
      ) : (
        <div ref={stripRef} data-testid="match-strip" className="flex gap-2 overflow-x-auto pb-1">
          {shown.map((m) => {
            const isSel = m.match_key === selected;
            const played = !isUnplayed(m);
            const red = m.actual_red_score ?? 0;
            const blue = m.actual_blue_score ?? 0;
            const top = Math.max(red, blue, 1);
            const ours = hasTeam(m, ourTeam);
            const covered = stationsCovered(m.match_key);
            return (
              <button
                key={m.match_key}
                type="button"
                data-match-chip={m.match_key}
                data-testid={`match-chip-${m.match_key}`}
                aria-pressed={isSel}
                onClick={() => onSelect(m.match_key)}
                className={cn(
                  'flex w-[6.5rem] shrink-0 flex-col gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors',
                  isSel
                    ? 'border-brand/60 bg-brand/10 shadow-[inset_0_2px_0_hsl(var(--brand))]'
                    : 'border-border bg-card hover:bg-muted/60',
                )}
              >
                <span className="flex items-center justify-between">
                  <span className="font-mono text-sm font-semibold tabular-nums">{chipLabel(m.match_key)}</span>
                  <span className="flex items-center gap-1">
                    {played && covered > 0 ? (
                      <span
                        title={`${covered}/${COVERAGE_STATION_CAP} stations scouted`}
                        className={cn(
                          'font-mono text-[10px] tabular-nums',
                          covered >= COVERAGE_STATION_CAP ? 'text-success' : 'text-warning',
                        )}
                      >
                        {covered}/{COVERAGE_STATION_CAP}
                      </span>
                    ) : null}
                    {ours ? <span aria-label="Our match" className="size-[7px] rounded-full bg-brand" /> : null}
                  </span>
                </span>
                {played ? (
                  <span className="flex flex-col gap-1">
                    <span className="flex items-center gap-1.5">
                      <span className="h-1 rounded-full bg-red-500" style={{ width: `${(red / top) * 3}rem` }} />
                      <span className={cn('font-mono text-xs tabular-nums', red > blue ? 'text-foreground' : 'text-muted-foreground')}>{red}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-1 rounded-full bg-blue-500" style={{ width: `${(blue / top) * 3}rem` }} />
                      <span className={cn('font-mono text-xs tabular-nums', blue > red ? 'text-foreground' : 'text-muted-foreground')}>{blue}</span>
                    </span>
                  </span>
                ) : (
                  <span className="font-mono text-xs leading-[22px] text-muted-foreground">
                    {shortTime(m.scheduled_time ?? null) ?? 'Time TBD'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
