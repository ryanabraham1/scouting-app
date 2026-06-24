// src/offline/OfflineReadyBadge.tsx
//
// Compact "Download for offline" pill for the scout screens. Shows whether the
// active event's data is cached locally, how long ago it synced, and a button to
// re-download. Mirrors the SyncIndicator pill styling (dot + label + sm button).
import { CheckCircle2, CloudDownload, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useOfflinePreload } from './useOfflinePreload';

/** "just now" / "Xm ago" / "Xh ago" / "Xd ago" from an ISO timestamp. */
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function OfflineReadyBadge(props: {
  eventKey: string | null;
  scoutId?: string;
}): JSX.Element | null {
  const { status, lastPreloadAt, errors, refresh } = useOfflinePreload(
    props.eventKey,
    props.scoutId,
  );

  // Nothing to preload without an event.
  if (props.eventKey == null) return null;

  const running = status === 'running';
  const hasErrors = errors.length > 0;
  const ready = status === 'ready' && lastPreloadAt != null;

  const Icon = running ? Loader2 : hasErrors ? AlertTriangle : ready ? CheckCircle2 : CloudDownload;

  const label = running
    ? 'Downloading…'
    : ready
      ? `Offline data ready · ${relativeTime(lastPreloadAt)}`
      : hasErrors
        ? 'Some data couldn’t download'
        : 'Tap to download for offline';

  return (
    <div
      data-testid="offline-ready-badge"
      className={cn(
        'flex flex-wrap items-center gap-2 text-sm text-muted-foreground',
        hasErrors && 'text-destructive',
      )}
    >
      <Icon
        className={cn('size-4 shrink-0', running && 'animate-spin', ready && 'text-emerald-500')}
        aria-hidden
      />
      <span>{label}</span>
      <Button
        data-testid="offline-download"
        size="sm"
        variant="secondary"
        className="h-9 min-h-[44px] px-3"
        disabled={running}
        onClick={() => refresh()}
      >
        {running ? 'Downloading…' : ready ? 'Refresh' : 'Download'}
      </Button>
    </div>
  );
}

export default OfflineReadyBadge;
