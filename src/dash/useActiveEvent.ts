import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { getStoredActiveEvent, setStoredActiveEvent } from './activeEventStore';

export const ACTIVE_EVENT_KEY = ['active-event'] as const;

export interface ActiveEvent {
  eventKey: string | null;
  loading: boolean;
}

interface EventRow {
  event_key: string;
  is_active: boolean;
}

/**
 * Resolve the active event for staff. Reads `event.is_active` from the server but
 * seeds React Query's initialData from localStorage so a refetch / tab-focus never
 * blanks the selection mid-session (root of the "selected event disappears" bug).
 * Setting the active event happens via `setActiveEvent`.
 */
export function useActiveEvent(): ActiveEvent {
  const stored = getStoredActiveEvent();

  const query = useQuery({
    queryKey: ACTIVE_EVENT_KEY,
    initialData: stored ?? undefined,
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
      // Keep the local cache in step with the server's source of truth, but never
      // erase a known-good local value on a transient empty result.
      if (next) setStoredActiveEvent(next);
      return next ?? stored ?? null;
    },
  });

  return {
    eventKey: query.data ?? stored ?? null,
    loading: query.isLoading && !stored,
  };
}
