// src/dash/setActiveEvent.ts — make an event the single active one. Flips the
// server `is_active` flag (exclusive), persists locally, and updates the query
// cache so the dashboard reflects it immediately without a flicker.
import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { setStoredActiveEvent } from './activeEventStore';
import { ACTIVE_EVENT_KEY } from './useActiveEvent';

export async function setActiveEvent(
  eventKey: string,
  queryClient?: QueryClient,
): Promise<void> {
  // Exactly one active event: clear others, then set this one.
  await supabase.from('event').update({ is_active: false }).neq('event_key', eventKey);
  const { error } = await supabase
    .from('event')
    .update({ is_active: true })
    .eq('event_key', eventKey);
  if (error) throw error;

  setStoredActiveEvent(eventKey);
  queryClient?.setQueryData(ACTIVE_EVENT_KEY, eventKey);
}
