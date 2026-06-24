// src/sync/useSync.ts
//
// The controller hook that drives the outbox engine. It runs syncOnce:
//   - on mount (if online),
//   - on the offline→online reconnect edge,
//   - every SYNC_POLL_MS while online,
//   - on an explicit syncNow().
// Overlapping runs are guarded with a ref. After each run it refreshes the
// queued/dead-letter counts from the store. It never auto-runs while offline.
// See phase3-contracts.md §3/§8 and the plan Task OUTBOX Step 4.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOnline } from '@/sync/useOnline';
import { syncOnce } from '@/sync/outbox';
import { getSyncQueue, listDeadLetters } from '@/db/localStore';
import { SYNC_POLL_MS } from '@/sync/constants';

export interface UseSyncResult {
  online: boolean;
  queued: number;
  deadLetters: number;
  syncing: boolean;
  syncNow: () => void;
}

export function useSync(): UseSyncResult {
  const online = useOnline();
  const [queued, setQueued] = useState(0);
  const [deadLetters, setDeadLetters] = useState(0);
  const [syncing, setSyncing] = useState(false);

  // Overlap guard: a ref so concurrent callers see the live value synchronously
  // (state updates are async and would let a second run slip through).
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  const refreshCounts = useCallback(async () => {
    // `queued` = the retry worklist (dirty + pending), which EXCLUDES dead-letters.
    // Dead-letters are surfaced separately so the badge never double-counts them.
    const [queue, dead] = await Promise.all([getSyncQueue(), listDeadLetters()]);
    if (!mountedRef.current) return;
    setQueued(queue.length);
    setDeadLetters(dead.length);
  }, []);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    if (mountedRef.current) setSyncing(true);
    try {
      await syncOnce();
    } finally {
      await refreshCounts();
      runningRef.current = false;
      if (mountedRef.current) setSyncing(false);
    }
  }, [refreshCounts]);

  const syncNow = useCallback(() => {
    void run();
  }, [run]);

  useEffect(() => {
    mountedRef.current = true;
    // Always reflect the stored queue on mount, even while offline (offline never
    // runs syncOnce, but the queued/dead-letter counts must still be shown).
    void refreshCounts();
    return () => {
      mountedRef.current = false;
    };
  }, [refreshCounts]);

  // Run on mount and on the offline→online reconnect edge: whenever `online`
  // becomes true. Never auto-run while offline.
  useEffect(() => {
    if (!online) return;
    void run();
  }, [online, run]);

  // Periodic poll while online only.
  useEffect(() => {
    if (!online) return;
    const id = setInterval(() => {
      void run();
    }, SYNC_POLL_MS);
    return () => clearInterval(id);
  }, [online, run]);

  return { online, queued, deadLetters, syncing, syncNow };
}
