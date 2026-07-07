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
  /** Extra classes on the root — e.g. `w-full justify-between` to pin the button right. */
  className?: string;
  /** Single-control mode for the scout home status strip. The happy path
   *  (data cached) collapses to one icon button — the full label moves into the
   *  tooltip/aria-label — while the needs-attention states (never downloaded,
   *  errors) keep a small labeled button so the CTA stays visible. */
  compact?: boolean;
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

  if (props.compact) {
    const needsAttention = !ready && !running;
    return (
      <div
        data-testid="offline-ready-badge"
        className={cn('flex shrink-0 items-center', props.className)}
      >
        <Button
          data-testid="offline-download"
          size="sm"
          variant={needsAttention ? 'secondary' : 'ghost'}
          aria-label={`${label} — download event data for offline`}
          title={label}
          className={cn(
            'min-h-0',
            needsAttention ? 'h-9 gap-1.5 px-2.5' : 'size-10 p-0',
            hasErrors && 'text-destructive',
          )}
          disabled={running}
          onClick={() => refresh()}
        >
          <Icon
            className={cn('size-4 shrink-0', running && 'animate-spin', ready && 'text-emerald-500')}
            aria-hidden
          />
          {needsAttention ? <span className="text-xs font-medium">Download</span> : null}
        </Button>
      </div>
    );
  }

  return (
    <div
      data-testid="offline-ready-badge"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground',
        hasErrors && 'text-destructive',
        props.className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon
          className={cn('size-4 shrink-0', running && 'animate-spin', ready && 'text-emerald-500')}
          aria-hidden
        />
        <span className="truncate">{label}</span>
      </span>
      <Button
        data-testid="offline-download"
        size="sm"
        variant="secondary"
        className="ml-auto h-9 min-h-[44px] shrink-0 px-3"
        disabled={running}
        onClick={() => refresh()}
      >
        {running ? 'Downloading…' : ready ? 'Refresh' : 'Download'}
      </Button>
    </div>
  );
}

export default OfflineReadyBadge;
