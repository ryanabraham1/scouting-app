// src/dash/board/BoardTopBar.tsx
// The board's header strip (mockup 01): title, event chip, a live "our next
// match" chip, search, presence, sync state and the full-screen toggle.
import { useEffect, useState, type ReactNode } from 'react';
import { Clock, Maximize2, Minimize2, PenTool, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MatchRow } from '@/dash/useEventData';

export function matchLabel(matchKey: string): string {
  const i = matchKey.indexOf('_');
  return i >= 0 ? matchKey.slice(i + 1) : matchKey;
}

export function matchTimeMs(m: MatchRow): number | null {
  const iso = m.predicted_time ?? m.scheduled_time;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** "in 6 min", "in 1h 40m", "now". */
export function countdown(ms: number, now: number): string {
  const mins = Math.round((ms - now) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface BoardTopBarProps {
  eventKey: string;
  nextMatch: MatchRow | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Omitted until spotlight search is mounted (no dead buttons). */
  onOpenSearch?: () => void;
  /** Sync state chip. */
  status: ReactNode;
  /** Presence avatars (P3). */
  presence?: ReactNode;
}

export function BoardTopBar({
  eventKey,
  nextMatch,
  expanded,
  onToggleExpanded,
  onOpenSearch,
  status,
  presence,
}: BoardTopBarProps): JSX.Element {
  const now = useNow();
  const t = nextMatch ? matchTimeMs(nextMatch) : null;
  return (
    <header className="flex min-h-[46px] shrink-0 items-center gap-2.5 border-b border-border px-3">
      <PenTool className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <h2 className="shrink-0 text-sm font-semibold">Ryan&apos;s board</h2>
      <span className="tnum hidden shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground sm:inline">
        {eventKey}
      </span>
      {nextMatch && (
        <span className="hidden shrink-0 items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning md:inline-flex">
          <Clock className="size-3" aria-hidden />
          <span className="tnum">{matchLabel(nextMatch.match_key)}</span>
          {t != null && <span>{countdown(t, now)}</span>}
        </span>
      )}
      <div className="min-w-0 flex-1" />
      {onOpenSearch && (
        <>
          <button
            type="button"
            onClick={onOpenSearch}
            className="hidden h-[30px] w-[260px] min-w-0 items-center gap-2 rounded-lg border border-[hsl(0_0%_22%)] px-2.5 text-xs text-muted-foreground hover:border-[hsl(0_0%_30%)] hover:text-foreground lg:inline-flex"
          >
            <Search className="size-4" aria-hidden />
            <span className="truncate">Search teams, matches, stats</span>
            <kbd className="tnum ml-auto rounded border border-[hsl(0_0%_22%)] px-1 text-[10.5px]">
              ⌘K
            </kbd>
          </button>
          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Search"
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
          >
            <Search className="size-4" aria-hidden />
          </button>
        </>
      )}
      {presence}
      {status}
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-label={expanded ? 'Exit full screen board' : 'Full screen board'}
        title={expanded ? 'Exit full screen (Esc)' : 'Full screen'}
        className={cn(
          'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {expanded ? (
          <Minimize2 className="size-4" aria-hidden />
        ) : (
          <Maximize2 className="size-4" aria-hidden />
        )}
      </button>
    </header>
  );
}
