import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export interface ActiveEvent {
  eventKey: string | null;
  loading: boolean;
}

interface EventRow {
  event_key: string;
  is_active: boolean;
}

/**
 * Resolve the active event for staff. Staff (admins) have no `scout`, so the
 * dashboard reads the active event directly from the `event` table where
 * `is_active`. Returns `{ eventKey: null }` when there is no active event.
 */
export function useActiveEvent(): ActiveEvent {
  const query = useQuery({
    queryKey: ['active-event'],
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from('event')
        .select('event_key,is_active')
        .eq('is_active', true);
      if (error) {
        throw error;
      }
      const rows = (data ?? []) as EventRow[];
      return rows[0]?.event_key ?? null;
    },
  });

  return {
    eventKey: query.data ?? null,
    loading: query.isLoading,
  };
}
