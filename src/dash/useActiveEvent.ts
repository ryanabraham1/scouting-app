import { useEffect, useId } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useOnline } from '@/sync/useOnline';
import {
  ACTIVE_EVENT_STORAGE_KEY,
  getStoredActiveEvent,
  isValidStoredEventKey,
  setStoredActiveEvent,
} from './activeEventStore';

// v2 intentionally abandons any old persisted React Query entry. The active
// event is server authority; only the explicit localStorage value is an offline
// fallback.
export const ACTIVE_EVENT_KEY = ['active-event', 'server-authority-v2'] as const;

/**
 * How often (ms) to re-resolve the active event as a safety net. The active
 * event is a global singleton a lead can flip from ANOTHER device; without a
 * re-resolve this browser would render the old event's data tabs until a manual
 * reload (BUG-LIVE-2). Realtime (when the `event` table is published) does the
 * instant work; this slow poll + a window-focus refetch are the always-present
 * fallbacks. Kept slow — the key changes at most a few times per event.
 */
const ACTIVE_EVENT_POLL_MS = 30_000;

export interface ActiveEvent {
  eventKey: string | null;
  loading: boolean;
  /** True once this browser has resolved the server, or when it is offline. */
  authoritative: boolean;
}

interface EventRow {
  event_key: string;
  is_active: boolean;
}

/**
 * Resolve the globally active event. The server's `event.is_active` row wins on
 * every successful online read. localStorage is display/operation fallback only
 * when that read cannot run (offline) or fails.
 */
export function useActiveEvent(): ActiveEvent {
  const online = useOnline();
  const queryClient = useQueryClient();
  // Unique per hook instance. This hook mounts in BOTH DashboardScreen and its
  // child SetupTab at once; a shared fixed channel topic made the second mount
  // reuse the first's already-subscribed channel, and adding a postgres_changes
  // listener after subscribe() throws ("cannot add postgres_changes callbacks
  // for realtime:active-event after subscribe()"). A per-instance topic keeps the
  // two subscriptions independent.
  const channelId = useId();

  const query = useQuery({
    queryKey: ACTIVE_EVENT_KEY,
    // placeholderData does not stamp the browser-local fallback as a fresh,
    // successful server result (unlike initialData). An online mount therefore
    // always verifies it immediately.
    placeholderData: () => getStoredActiveEvent() ?? undefined,
    enabled: online,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: online ? ACTIVE_EVENT_POLL_MS : false,
    retry: 1,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from('event')
        .select('event_key,is_active')
        .eq('is_active', true);
      if (error) {
        throw error;
      }
      const rows = (data ?? []) as EventRow[];
      const next = rows[0]?.event_key ?? null;
      // A successful empty result is authoritative "no active event". Transport
      // failures throw above and React Query preserves the prior/local fallback.
      setStoredActiveEvent(next);
      return next;
    },
  });

  // Same-browser tabs do not share a QueryClient. A storage event from another
  // tab is therefore a useful prompt: online tabs re-resolve from the server;
  // offline tabs adopt the validated fallback immediately.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== ACTIVE_EVENT_STORAGE_KEY) return;
      if (online) {
        void queryClient.invalidateQueries({ queryKey: ACTIVE_EVENT_KEY });
        return;
      }
      const next = isValidStoredEventKey(event.newValue) ? event.newValue : null;
      queryClient.setQueryData(ACTIVE_EVENT_KEY, next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [online, queryClient]);

  // Realtime: when the `event` table is in the Supabase realtime publication, a
  // flip of `is_active` on ANY device pushes here and we re-resolve immediately.
  // Harmless no-op when the table isn't published or the client lacks Realtime
  // (e.g. mocked in unit tests) — the focus/interval refetch above still covers it.
  useEffect(() => {
    if (typeof supabase.channel !== 'function') return;
    const channel = supabase
      .channel(`active-event-${channelId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'event' },
        () => {
          void queryClient.invalidateQueries({ queryKey: ACTIVE_EVENT_KEY });
        },
      )
      .subscribe();
    return () => {
      if (typeof supabase.removeChannel === 'function') supabase.removeChannel(channel);
    };
  }, [queryClient, channelId]);

  return {
    eventKey: query.data !== undefined ? query.data : getStoredActiveEvent(),
    // Gate only the first online authority check. Background poll/focus refreshes
    // keep the current event visible and swap atomically when the answer arrives.
    loading:
      online &&
      query.isFetching &&
      query.dataUpdatedAt === 0 &&
      query.failureCount === 0,
    authoritative: !online || (!query.isPlaceholderData && query.dataUpdatedAt > 0),
  };
}
