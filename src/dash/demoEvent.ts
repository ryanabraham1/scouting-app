// src/dash/demoEvent.ts — "demo mode": spin up a fully-populated simulated event
// so every dashboard feature can be explored without a live event. The demo event
// (`2026demo`) is built by the `seed-demo` Edge Function from a REAL source event
// (`2026casnv`) — real teams + real schedule from TBA, with scouting data derived
// from TBA results. We POST to the function, then activate the event and invalidate
// all queries so the dashboard refetches against it. Teardown reuses the existing
// `delete_event` wrapper.
import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { env } from '@/lib/env';
import { setActiveEvent } from './setActiveEvent';
import { deleteEvent } from './deleteEvent';

export const DEMO_EVENT_KEY = '2026demo';
export const DEMO_SOURCE_EVENT_KEY = '2026casnv';

export function isDemoEvent(key: string | null): boolean {
  return key === DEMO_EVENT_KEY;
}

export interface EnableDemoResult {
  team_count: number;
  match_count: number;
  report_count: number;
}

/**
 * Build the demo event from the real source event via the `seed-demo` Edge
 * Function (idempotent server-side), make it the active event, and invalidate all
 * queries so every dashboard read refetches against the freshly-seeded data.
 */
export async function enableDemoMode(
  queryClient?: QueryClient,
): Promise<EnableDemoResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error('Not signed in.');
  }

  const res = await fetch(`${env.SUPABASE_URL}/functions/v1/seed-demo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      source_event_key: DEMO_SOURCE_EVENT_KEY,
      demo_event_key: DEMO_EVENT_KEY,
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ?? '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `Demo setup failed (${res.status})`);
  }

  const result = (await res.json()) as EnableDemoResult;

  await setActiveEvent(DEMO_EVENT_KEY, queryClient);
  await queryClient?.invalidateQueries();

  return result;
}

/**
 * Tear down the demo event and all of its data, then invalidate all queries so the
 * dashboard stops pointing at the now-deleted event.
 */
export async function disableDemoMode(queryClient?: QueryClient): Promise<void> {
  await deleteEvent(DEMO_EVENT_KEY, queryClient);
  await queryClient?.invalidateQueries();
}
