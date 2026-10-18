// src/scout/ScoutStatusCard.tsx — "what else is waiting" card on the scout home:
// pit-scouting progress and the offline outbox (with the QR hand-off shortcut).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  CloudUpload,
  CircleCheck,
  ClipboardList,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSync } from '@/sync/useSync';
import { getCachedPitAssignments } from '@/db/preloadClient';
import { listPitReportsForEvent } from '@/pit/pitStore';
import { readSubmittedPitTeams } from '@/pit/PitScoutFlow';

/** Assigned vs finished pit teams for this scout, from local caches only. */
function usePitProgress(eventKey: string, scoutId: string): { total: number; left: number } {
  const [progress, setProgress] = useState({ total: 0, left: 0 });
  useEffect(() => {
    if (!eventKey || !scoutId) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const assigned = (await getCachedPitAssignments(scoutId))
          .filter((row) => row.event_key === eventKey)
          .map((row) => row.team_number);
        const teams = [...new Set(assigned)];
        const done = new Set(readSubmittedPitTeams(eventKey));
        for (const report of await listPitReportsForEvent(eventKey)) done.add(report.teamNumber);
        if (!cancelled) {
          setProgress({ total: teams.length, left: teams.filter((t) => !done.has(t)).length });
        }
      } catch {
        /* IndexedDB unavailable: leave the generic row */
      }
    };
    void refresh();
    window.addEventListener('preload-cache-changed', refresh);
    window.addEventListener('scout-sync-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('preload-cache-changed', refresh);
      window.removeEventListener('scout-sync-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [eventKey, scoutId]);
  return progress;
}

const ROW = 'flex min-h-[56px] items-center gap-3 border-t border-border py-3 first:border-t-0';
const ICON = 'flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-background text-muted-foreground [&_svg]:size-[18px]';

export function ScoutStatusCard({
  eventKey,
  scoutId,
}: {
  eventKey: string;
  scoutId: string;
}): JSX.Element {
  const { queued, deadLetters, online } = useSync();
  const pit = usePitProgress(eventKey, scoutId);

  return (
    <div data-testid="scout-status-card" className="rounded-2xl bg-secondary/60 px-4 py-1">
      <Link to="/scout?mode=pit" data-testid="scout-pit-card" className={ROW}>
        <span className={ICON}>
          <ClipboardList aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm">Pit scouting</span>
          <span className="block text-xs text-muted-foreground">
            {pit.total === 0
              ? 'Scout any team in the pits'
              : pit.left === 0
                ? `All ${pit.total} assigned teams done`
                : `${pit.left} of ${pit.total} teams left`}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>

      {deadLetters > 0 ? (
        <Link to="/sync" data-testid="scout-sync-failed" className={ROW}>
          <span className={cn(ICON, 'text-warning')}>
            <TriangleAlert aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm">
              {deadLetters} {deadLetters === 1 ? 'report' : 'reports'} failed to sync
            </span>
            <span className="block text-xs text-muted-foreground">Tap to review and retry</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
      ) : null}

      {queued > 0 ? (
        <div className={ROW} data-testid="scout-sync-waiting">
          <span className={ICON}>
            <CloudUpload aria-hidden="true" />
          </span>
          <Link to="/sync" className="min-w-0 flex-1">
            <span className="block text-sm">
              {queued} {queued === 1 ? 'report' : 'reports'} waiting
            </span>
            <span className="block text-xs text-muted-foreground">
              {online ? 'Sending now' : 'Saved here, will sync when online'}
            </span>
          </Link>
          <Link
            to="/qr/send"
            data-testid="nav-qr-send"
            className="inline-flex min-h-11 shrink-0 items-center px-1 text-xs text-brand hover:underline"
          >
            Send by QR
          </Link>
        </div>
      ) : deadLetters === 0 ? (
        <Link to="/sync" data-testid="scout-sync-clear" className={ROW}>
          <span className={cn(ICON, 'text-success')}>
            <CircleCheck aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm">Everything is synced</span>
            <span className="block text-xs text-muted-foreground">Nothing waiting on this device</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

export default ScoutStatusCard;
