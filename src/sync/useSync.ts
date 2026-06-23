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
import { getUnsynced, listDeadLetters } from '@/db/localStore';
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
    const [unsynced, dead] = await Promise.all([getUnsynced(), listDeadLetters()]);
    if (!mountedRef.current) return;
    setQueued(unsynced.length);
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
