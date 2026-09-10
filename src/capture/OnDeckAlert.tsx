// src/capture/OnDeckAlert.tsx
// Prominent "You're on deck" banner for the scout home. Renders only when the
// pure `selectOnDeck` selector flags an imminent assigned match (driven by live
// Nexus status, else schedule time). Tapping it jumps straight into capture.
//
// Optionally fires ONE Web Notification per imminent match — but only when
// permission is ALREADY granted. We never call requestPermission() here, so the
// scout is never nagged; they opt in elsewhere (or via the browser) if they want it.

import { useEffect, useRef } from 'react';
import { Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import { matchLabelFromKey } from '@/capture/UpcomingMatches';
import { onDeckHeadline, type OnDeckResult, type OnDeckMatch } from '@/capture/onDeck';
import { matchTimeSourceLabel, type MatchTimeDisplay } from '@/capture/matchTime';

interface OnDeckAlertProps<A extends OnDeckMatch> {
  result: OnDeckResult<A>;
  timing?: MatchTimeDisplay | null;
  onStart: (a: A) => void;
}

/** Notify once per (match + team + urgency) key while permission is already granted. */
function useOnDeckNotification(assignment: OnDeckMatch, urgency: string) {
  const notifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const a = assignment;
    const key = `${a.match_key}:${a.target_team_number}:${urgency}`;
    if (notifiedRef.current === key) return;
    notifiedRef.current = key;
    const title = "You're on deck — scout now";
    const options: NotificationOptions = {
      body: `${matchLabelFromKey(a.match_key)} · team #${a.target_team_number} · ${a.alliance_color} ${a.station}`,
      tag: 'frc-scout-on-deck',
    };
    void (async () => {
      try {
        if ('serviceWorker' in navigator) {
          const registration = await navigator.serviceWorker.ready;
          await registration.showNotification(title, options);
          return;
        }
        new Notification(title, options);
      } catch {
        // Delivery remains best-effort; the visible on-deck banner is the fallback.
      }
    })();
  }, [assignment, urgency]);
}

export function OnDeckAlert<A extends OnDeckMatch>({ result, timing, onStart }: OnDeckAlertProps<A>) {
  const { assignment: a, urgency, liveStatus } = result;
  useOnDeckNotification(a, urgency);

  return (
    <button
      type="button"
      data-testid="scout-on-deck-alert"
      data-urgency={urgency}
      onClick={() => onStart(a)}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border-l-4 px-4 py-3 text-left shadow-sm transition-colors',
        'animate-in fade-in slide-in-from-top-1',
        urgency === 'on-field'
          ? 'border-l-success bg-success/15 hover:bg-success/20'
          : urgency === 'soon'
            ? 'border-l-brand bg-brand/10 hover:bg-brand/15'
            : 'border-l-warning bg-warning/15 hover:bg-warning/20',
      )}
    >
      <span className="relative flex size-3 shrink-0">
        <span
          className={cn(
            'absolute inline-flex size-full animate-ping rounded-full opacity-75',
            urgency === 'on-field'
              ? 'bg-success'
              : urgency === 'soon'
                ? 'bg-brand'
                : 'bg-warning',
          )}
        />
        <span
          className={cn(
            'relative inline-flex size-3 rounded-full',
            urgency === 'on-field'
              ? 'bg-success'
              : urgency === 'soon'
                ? 'bg-brand'
                : 'bg-warning',
          )}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide">
          <Radio className="size-4 shrink-0" />
          <span className="truncate">{onDeckHeadline(urgency)}</span>
          {liveStatus ? (
            <span className="shrink-0 rounded-full bg-background/40 px-2 py-0.5 text-[10px] font-semibold">
              {liveStatus}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-sm">
          <span className="font-semibold">{matchLabelFromKey(a.match_key)}</span>
          {' — scout '}
          <span className="font-mono font-bold">#{a.target_team_number}</span>
          {' at '}
          <span className="font-semibold">
            {a.alliance_color} {a.station}
          </span>
        </div>
        <div
          data-testid="scout-on-deck-time"
          className={cn(
            'mt-1 flex items-center gap-1.5 text-xs font-semibold tabular-nums',
            timing?.state === 'late' ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          {timing
            ? `${matchTimeSourceLabel(timing.source)} ${timing.clock} · ${timing.relative}`
            : 'Time TBD'}
        </div>
      </div>
      <span className="hidden shrink-0 rounded-md bg-foreground/10 px-3 py-1.5 text-sm font-semibold sm:inline-flex">
        Scout now
      </span>
    </button>
  );
}
