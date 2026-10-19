// src/scout/ScoutDeviceCard.tsx — desktop-only "This device" card beside the
// scout home's next-match hero: what is saved here, what still has to sync, and
// how fresh the offline event cache is. Reads only local state (the shared sync
// counts and the preload bookkeeping), so it never starts a preload of its own —
// OfflineReadyBadge stays the one place that drives downloads.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, GraduationCap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSync } from '@/sync/useSync';
import { getPreloadMeta } from '@/db/preloadClient';
import { relativeTime } from '@/dash/relativeTime';

function useLastPreloadAt(eventKey: string): string | null {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    setAt(null);
    if (!eventKey) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const meta = await getPreloadMeta(eventKey);
        if (!cancelled) setAt(meta?.lastPreloadAt ?? null);
      } catch {
        /* IndexedDB unavailable: the row reads "Not saved" */
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('preload-cache-changed', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('preload-cache-changed', refresh);
    };
  }, [eventKey]);
  return at;
}

const ROW = 'flex items-center justify-between gap-3 border-b border-border/60 py-2.5 text-sm last:border-b-0';
const ACTION =
  'inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-border text-sm font-medium hover:bg-accent [&_svg]:size-4';

export function ScoutDeviceCard({
  eventKey,
  reportsSaved,
  className,
}: {
  eventKey: string;
  reportsSaved: number;
  className?: string;
}): JSX.Element {
  const { queued, deadLetters } = useSync();
  const lastPreloadAt = useLastPreloadAt(eventKey);
  const cacheAgeMs = lastPreloadAt ? Date.now() - Date.parse(lastPreloadAt) : null;
  // Green while the schedule cache is from today's session, amber once it is
  // stale enough that assignments may have moved, muted when never saved.
  const cacheTone =
    cacheAgeMs == null || Number.isNaN(cacheAgeMs)
      ? 'bg-muted-foreground'
      : cacheAgeMs < 2 * 60 * 60 * 1000
        ? 'bg-success'
        : 'bg-warning';

  return (
    <div
      data-testid="scout-device-card"
      className={cn('flex flex-col gap-3 rounded-2xl border border-border bg-card p-5', className)}
    >
      <p className="text-xs font-medium text-muted-foreground">This device</p>
      <div className="flex flex-col">
        <div className={ROW}>
          <span className="text-muted-foreground">Reports saved</span>
          <span className="font-mono tabular-nums">{reportsSaved}</span>
        </div>
        <div className={ROW}>
          <span className="text-muted-foreground">Waiting to sync</span>
          <span
            className={cn(
              'font-mono tabular-nums',
              deadLetters > 0 ? 'text-destructive' : queued > 0 ? 'text-warning' : '',
            )}
          >
            {queued}
            {deadLetters > 0 ? ` · ${deadLetters} failed` : ''}
          </span>
        </div>
        <div className={ROW}>
          <span className="text-muted-foreground">Event data cached</span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('size-1.5 rounded-full', cacheTone)} />
            {lastPreloadAt ? relativeTime(lastPreloadAt, Date.now()) : 'Not saved'}
          </span>
        </div>
      </div>
      <div className="mt-auto flex gap-2">
        <Link to="/sync" className={ACTION}>
          <ArrowLeftRight aria-hidden="true" /> Transfer
        </Link>
        <Link to="/scout/tutorial" className={ACTION}>
          <GraduationCap aria-hidden="true" /> Tutorial
        </Link>
      </div>
    </div>
  );
}

export default ScoutDeviceCard;
