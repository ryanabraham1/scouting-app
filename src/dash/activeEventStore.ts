// src/dash/activeEventStore.ts — tiny localStorage wrapper for the active event.
// Persisting locally lets useActiveEvent seed React Query's initialData so a
// refetch/tab-focus never blanks the lead's selected event mid-session.
const KEY = 'active_event_key';

export function getStoredActiveEvent(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setStoredActiveEvent(eventKey: string | null): void {
  try {
    if (eventKey) localStorage.setItem(KEY, eventKey);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — non-fatal */
  }
}
