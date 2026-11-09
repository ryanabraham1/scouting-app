// src/scout/ScoutPicklistView.tsx — read-only view of the lead's picklist for
// scouts in the stands. Shows the 1st-pick and 2nd-pick lists in order plus the
// do-not-pick list. Editing stays on the Lead Dashboard; this screen never
// writes. Offline it falls back to the last snapshot this device saw.
import { formatTeam } from '@/lib/teamKey';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Ban, RefreshCw } from 'lucide-react';
import { useActiveEvent } from '@/dash/useActiveEvent';
import {
  entryList,
  getCachedPicklist,
  getPicklist,
  type PicklistEntry,
} from '@/dash/picklistClient';
import { db } from '@/db/localStore';
import { ScoutBottomNav, ScoutTopNav } from '@/scout/ScoutBottomNav';
import { cn } from '@/lib/utils';

/** How often the open screen re-reads the shared picklist while online. */
export const SCOUT_PICKLIST_POLL_MS = 60_000;

type LoadState = 'loading' | 'live' | 'cached' | 'error';

/** Split stored entries into the three lists scouts see, order preserved. */
export function splitPicklist(entries: PicklistEntry[]): {
  first: PicklistEntry[];
  second: PicklistEntry[];
  dnp: PicklistEntry[];
} {
  const first: PicklistEntry[] = [];
  const second: PicklistEntry[] = [];
  const dnp: PicklistEntry[] = [];
  for (const e of entries) {
    if (e.dnp) dnp.push(e);
    else if (entryList(e) === 'second') second.push(e);
    else first.push(e);
  }
  return { first, second, dnp };
}

function useTeamNames(eventKey: string | null): Map<number, string> {
  const [names, setNames] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    if (!eventKey) {
      setNames(new Map());
      return;
    }
    let cancelled = false;
    db.cachedTeams
      .where('event_key')
      .equals(eventKey)
      .toArray()
      .then((rows) => {
        if (cancelled) return;
        setNames(
          new Map(
            rows
              .filter((r) => r.nickname)
              .map((r) => [r.team_number, r.nickname as string] as const),
          ),
        );
      })
      .catch(() => {
        /* no preload cache — numbers alone still read fine */
      });
    return () => {
      cancelled = true;
    };
  }, [eventKey]);
  return names;
}

function PickList({
  title,
  entries,
  names,
  testId,
  dnp = false,
}: {
  title: string;
  entries: PicklistEntry[];
  names: Map<number, string>;
  testId: string;
  dnp?: boolean;
}): JSX.Element {
  return (
    <section data-testid={testId} className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {dnp && <Ban aria-hidden="true" className="size-4 text-destructive" />}
        {title}
        <span className="font-mono tabular-nums">({entries.length})</span>
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No teams yet.</p>
      ) : (
        <ol className="flex flex-col rounded-xl border border-border">
          {entries.map((e, i) => (
            <li
              key={e.teamNumber}
              data-testid={`${testId}-row`}
              className="flex items-start gap-3 border-t border-border px-3 py-2.5 first:border-t-0"
            >
              {!dnp && (
                <span className="w-7 shrink-0 pt-0.5 text-right font-mono text-sm text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={cn(
                      'font-mono text-base font-semibold tabular-nums',
                      dnp ? 'text-destructive' : 'text-brand',
                    )}
                  >
                    {formatTeam(e.teamNumber)}
                  </span>
                  {names.get(e.teamNumber) && (
                    <span className="truncate text-sm">{names.get(e.teamNumber)}</span>
                  )}
                  {e.tier && (
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {e.tier}
                    </span>
                  )}
                </p>
                {e.note && <p className="mt-0.5 text-sm text-muted-foreground">{e.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function ScoutPicklistView(): JSX.Element {
  const { eventKey, loading: eventLoading } = useActiveEvent();
  const names = useTeamNames(eventKey);
  const [entries, setEntries] = useState<PicklistEntry[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const generationRef = useRef(0);

  const load = useCallback(async (key: string) => {
    const generation = ++generationRef.current;
    setRefreshing(true);
    try {
      const loaded = await getPicklist(key);
      if (generationRef.current !== generation) return;
      setEntries(loaded);
      setState('live');
    } catch {
      if (generationRef.current !== generation) return;
      const cached = getCachedPicklist(key);
      if (cached) {
        setEntries(cached);
        setState('cached');
      } else {
        setState((prev) => (prev === 'live' ? 'cached' : 'error'));
      }
    } finally {
      if (generationRef.current === generation) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (eventLoading || !eventKey) return;
    // Paint the last-known snapshot immediately, then verify with the server.
    const cached = getCachedPicklist(eventKey);
    setEntries(cached ?? []);
    setState(cached ? 'cached' : 'loading');
    void load(eventKey);
    const id = window.setInterval(() => {
      if (navigator.onLine !== false) void load(eventKey);
    }, SCOUT_PICKLIST_POLL_MS);
    const onOnline = (): void => void load(eventKey);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('online', onOnline);
      generationRef.current += 1;
    };
  }, [eventKey, eventLoading, load]);

  const { first, second, dnp } = splitPicklist(entries);

  return (
    <div
      data-testid="scout-picklist"
      className="flex min-h-dvh flex-col bg-background pb-24 text-foreground md:pb-6"
    >
      <header className="px-safe pt-safe pb-2 md:mx-auto md:w-full md:max-w-5xl">
        <ScoutTopNav active="picklist" className="mb-4" />
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-medium">Picklist</h1>
            <p className="text-xs text-muted-foreground">
              {eventKey ? `${eventKey} · view only` : 'View only'}
            </p>
          </div>
          {eventKey && (
            <button
              type="button"
              data-testid="scout-picklist-refresh"
              onClick={() => void load(eventKey)}
              disabled={refreshing}
              aria-label="Refresh picklist"
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent disabled:opacity-60"
            >
              <RefreshCw className={cn('size-4', refreshing && 'motion-safe:animate-spin')} />
              Refresh
            </button>
          )}
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-5 px-safe pb-safe pt-4 md:mx-auto md:w-full md:max-w-5xl">
        {!eventLoading && !eventKey ? (
          <p data-testid="scout-picklist-empty" className="text-muted-foreground">
            No active event selected.
          </p>
        ) : state === 'loading' ? (
          <p role="status" className="text-muted-foreground">
            Loading picklist…
          </p>
        ) : state === 'error' ? (
          <p data-testid="scout-picklist-error" className="text-muted-foreground">
            Couldn&apos;t load the picklist. Connect to the internet and tap Refresh.
          </p>
        ) : (
          <>
            {state === 'cached' && (
              <p
                data-testid="scout-picklist-cached"
                className="rounded-lg border border-warning/40 bg-warning/15 px-3 py-2 text-sm text-warning"
              >
                Offline — showing the last picklist this device downloaded.
              </p>
            )}
            {entries.length === 0 ? (
              <p data-testid="scout-picklist-empty" className="text-muted-foreground">
                The leads haven&apos;t built a picklist for this event yet.
              </p>
            ) : (
              <div className="grid gap-5 md:grid-cols-3">
                <PickList title="1st pick" entries={first} names={names} testId="scout-picklist-first" />
                <PickList title="2nd pick" entries={second} names={names} testId="scout-picklist-second" />
                <PickList title="Do not pick" entries={dnp} names={names} testId="scout-picklist-dnp" dnp />
              </div>
            )}
          </>
        )}
      </main>
      <ScoutBottomNav active="picklist" />
    </div>
  );
}
