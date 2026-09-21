// src/sync/queueEvents.ts
//
// The one in-tab signal that "something new is waiting in an outbox". The sync
// controller (useSync) listens for it and starts a drain immediately instead of
// waiting for the next SYNC_POLL_MS tick, and rebroadcasts it to sibling tabs.
// Every outbox writer (match capture, pit, matchup notes, strategy canvas, JSON
// import, dead-letter requeue) should call this right after its local write.
export const SYNC_QUEUE_CHANGED_EVENT = 'scout-sync-changed';

export function notifySyncQueueChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SYNC_QUEUE_CHANGED_EVENT));
}
