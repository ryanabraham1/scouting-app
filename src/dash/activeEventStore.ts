// src/dash/activeEventStore.ts — offline fallback for the server-owned active
// event. This value is never authoritative while the server is reachable.
export const ACTIVE_EVENT_STORAGE_KEY = 'active_event_key';

const EVENT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidStoredEventKey(value: unknown): value is string {
  return typeof value === 'string' && EVENT_KEY_PATTERN.test(value);
}

export function getStoredActiveEvent(): string | null {
  try {
    const value = localStorage.getItem(ACTIVE_EVENT_STORAGE_KEY);
    if (value == null) return null;
    if (isValidStoredEventKey(value)) return value;
    // Do not let corrupted/manual storage become an event authority offline.
    localStorage.removeItem(ACTIVE_EVENT_STORAGE_KEY);
    return null;
  } catch {
    return null;
  }
}

export function setStoredActiveEvent(eventKey: string | null): void {
  try {
    if (eventKey && isValidStoredEventKey(eventKey)) {
      if (localStorage.getItem(ACTIVE_EVENT_STORAGE_KEY) !== eventKey) {
        localStorage.setItem(ACTIVE_EVENT_STORAGE_KEY, eventKey);
      }
    } else {
      localStorage.removeItem(ACTIVE_EVENT_STORAGE_KEY);
    }
  } catch {
    /* storage unavailable — non-fatal */
  }
}
