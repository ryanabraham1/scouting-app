// src/sync/SyncIndicator.tsx
//
// Compact header widget: online/offline dot, queued + dead-letter counts, a
// "Sync now" trigger, and a "Retry all" action for dead-letters. Pure view over
// the useSync() hook plus the localStore dead-letter list.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Wifi, WifiOff, ArrowUpFromLine, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSync } from '@/sync/useSync';
import { relativeTime } from '@/dash/relativeTime';
import { listDeadLetters, requeueReport } from '@/db/localStore';
import { listPitDeadLetters, requeuePitReport } from '@/pit/pitStore';

export function SyncIndicator({
  className,
  detailsHref,
  compact,
}: {
  className?: string;
  /** When set, the status cluster becomes a link to the full sync-status screen
   *  (needs a Router in context). Omitted in standalone/test renders. */
  detailsHref?: string;
  /** Single-line mode for the scout home status strip: the Sync action shrinks
   *  to an icon button so the row stays one thin line. Retry-all (an attention
   *  state) keeps its text. */
  compact?: boolean;
} = {}): JSX.Element {
  const { online, queued, deadLetters, syncing, syncNow, lastSyncedAt } = useSync();
  const [retrying, setRetrying] = useState(false);

  async function retryAll(): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    try {
      const [letters, pitLetters] = await Promise.all([
        listDeadLetters(),
        listPitDeadLetters(),
      ]);
      for (const r of letters) {
        await requeueReport(r.id);
      }
      for (const r of pitLetters) {
        await requeuePitReport(r.draftKey);
      }
      // Re-drain the (now larger) queue.
      syncNow();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      data-testid="sync-indicator"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground',
        className,
      )}
    >
      {/* Status group: connection + queue/dead-letter counts + last-synced. Kept
          on ONE line (nowrap) and vertically centered with the action buttons;
          the fixed icons/counts never shrink and only the "synced …" tail
          truncates when space is tight — so the buttons sit side-by-side with the
          text instead of dropping to their own line. When `detailsHref` is set the
          whole cluster is a link into the full sync-status screen. */}
      {(() => {
        const statusInner = (
          <>
            <span
              aria-label={online ? 'online' : 'offline'}
              title={online ? 'online' : 'offline'}
              className={cn('shrink-0', online ? 'text-success' : 'text-warning')}
            >
              {online ? <Wifi className="size-4" /> : <WifiOff className="size-4" />}
            </span>
            <span className="sr-only">{online ? 'online' : 'offline'}</span>
            <span
              data-testid="sync-queued"
              title="Queued to upload"
              className={cn('inline-flex shrink-0 items-center gap-0.5 font-mono tabular-nums', queued > 0 && 'text-warning')}
            >
              <ArrowUpFromLine className="size-3.5" />
              {queued}
            </span>
            <span
              data-testid="sync-deadletters"
              className={cn('inline-flex shrink-0 items-center gap-0.5 font-mono tabular-nums', deadLetters > 0 && 'text-destructive')}
              title="Failed (dead-letter)"
            >
              <AlertTriangle className="size-3.5" />
              {deadLetters}
            </span>
            {lastSyncedAt != null ? (
              <span data-testid="sync-last" title="Last successful sync" className="min-w-0 truncate text-muted-foreground">
                · synced {relativeTime(new Date(lastSyncedAt).toISOString(), Date.now())}
              </span>
            ) : null}
          </>
        );
        return detailsHref ? (
          <Link
            to={detailsHref}
            data-testid="sync-details-link"
            aria-label="View sync status"
            className="flex min-w-0 items-center gap-x-2 rounded-md underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {statusInner}
          </Link>
        ) : (
          <span className="flex min-w-0 items-center gap-x-2">{statusInner}</span>
        );
      })()}
      {/* Action group: the buttons travel together and right-align as one unit
          (ml-auto keeps them on the right edge even when they wrap to their own line). */}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <Button
          data-testid="sync-now"
          size="sm"
          variant={compact ? 'ghost' : 'secondary'}
          aria-label="Sync now"
          title="Sync now"
          className={compact ? 'size-10 min-h-0 p-0' : 'h-9 min-h-[44px] px-3'}
          disabled={syncing || !online}
          onClick={() => syncNow()}
        >
          {compact ? (
            <RefreshCw className={cn('size-4', syncing && 'animate-spin')} />
          ) : syncing ? (
            <>
              <RefreshCw className="size-4 animate-spin" /> Syncing…
            </>
          ) : (
            'Sync now'
          )}
        </Button>
        {deadLetters > 0 ? (
          <Button
            data-testid="sync-retry-all"
            size="sm"
            variant="outline"
            className={compact ? 'h-9 px-2.5' : 'h-9 min-h-[44px] px-3'}
            disabled={retrying || !online}
            onClick={() => void retryAll()}
          >
            Retry all
          </Button>
        ) : null}
      </span>
    </div>
  );
}

export default SyncIndicator;
