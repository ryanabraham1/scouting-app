// src/sync/SyncIndicator.tsx
//
// Compact header widget: online/offline dot, queued + dead-letter counts, a
// "Sync now" trigger, and a "Retry all" action for dead-letters. Pure view over
// the useSync() hook plus the localStore dead-letter list.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useSync } from '@/sync/useSync';
import { listDeadLetters, requeueReport } from '@/db/localStore';

export function SyncIndicator(): JSX.Element {
  const { online, queued, deadLetters, syncing, syncNow } = useSync();
  const [retrying, setRetrying] = useState(false);

  async function retryAll(): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    try {
      const letters = await listDeadLetters();
      for (const r of letters) {
        await requeueReport(r.id);
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
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <span
        aria-label={online ? 'online' : 'offline'}
        title={online ? 'online' : 'offline'}
        className={`inline-block h-2.5 w-2.5 rounded-full ${
          online ? 'bg-emerald-500' : 'bg-muted-foreground'
        }`}
      />
      <span className="sr-only">{online ? 'online' : 'offline'}</span>
      <span data-testid="sync-queued" title="Queued">
        ↑{queued}
      </span>
      <span
        data-testid="sync-deadletters"
        className={deadLetters > 0 ? 'text-destructive' : undefined}
        title="Failed (dead-letter)"
      >
        ⚠{deadLetters}
      </span>
      <Button
        data-testid="sync-now"
        size="sm"
        variant="secondary"
        className="h-9 min-h-[44px] px-3"
        disabled={syncing || !online}
        onClick={() => syncNow()}
      >
        {syncing ? 'Syncing…' : 'Sync now'}
      </Button>
      {deadLetters > 0 ? (
        <Button
          data-testid="sync-retry-all"
          size="sm"
          variant="outline"
          className="h-9 min-h-[44px] px-3"
          disabled={retrying || !online}
          onClick={() => void retryAll()}
        >
          Retry all
        </Button>
      ) : null}
    </div>
  );
}

export default SyncIndicator;
