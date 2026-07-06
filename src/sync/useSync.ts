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
import { syncPitOnce } from '@/sync/pitOutbox';
import { syncMatchupNotesOnce } from '@/sync/matchupNotesSync';
import {
  getSyncQueue,
  listDeadLetters,
  requeueAuthClassDeadLetters,
  getMatchupSyncQueue,
  listMatchupDeadLetters,
  requeueAuthClassMatchupDeadLetters,
} from '@/db/localStore';
import {
  getPitSyncQueue,
  listPitDeadLetters,
  requeueAuthClassPitDeadLetters,
} from '@/pit/pitStore';
import { SYNC_POLL_MS } from '@/sync/constants';

export interface UseSyncResult {
  online: boolean;
  queued: number;
  deadLetters: number;
  syncing: boolean;
  syncNow: () => void;
  /** Date.now() of the last run() that completed WITHOUT throwing; null until one does. */
  lastSyncedAt: number | null;
}

export function useSync(): UseSyncResult {
  const online = useOnline();
  const [queued, setQueued] = useState(0);
  const [deadLetters, setDeadLetters] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  // Overlap guard: a ref so concurrent callers see the live value synchronously
  // (state updates are async and would let a second run slip through).
  const runningRef = useRef(false);
  // A run() requested while a drain is in flight must not be DROPPED — the
  // in-flight drain snapshotted the queue before the new work was enqueued, so
  // dropping the request strands the new report until the next poll. Coalesce:
  // remember the request and loop one more drain before releasing the guard.
  const rerunRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  // Auto-requeue auth/RLS-class dead-letters AT MOST ONCE per session. After a
  // server-side RLS/RPC fix (migration 0012) ships, reports that were wrongly
  // dead-lettered with a 42501-class error should retry automatically — but only
  // once, so a still-failing report can't loop. Validation-class dead-letters are
  // never touched (see requeueAuthClassDeadLetters).
  const requeuedAuthRef = useRef(false);

  const refreshCounts = useCallback(async () => {
    // `queued` = the retry worklist (dirty + pending), which EXCLUDES dead-letters.
    // Dead-letters are surfaced separately so the badge never double-counts them.
    // Pit reports drain through the same indicator, so their counts are folded in.
    const [queue, dead, pitQueue, pitDead, matchupQueue, matchupDead] = await Promise.all([
      getSyncQueue(),
      listDeadLetters(),
      getPitSyncQueue(),
      listPitDeadLetters(),
      getMatchupSyncQueue(),
      listMatchupDeadLetters(),
    ]);
    if (!mountedRef.current) return;
    setQueued(queue.length + pitQueue.length + matchupQueue.length);
    setDeadLetters(dead.length + pitDead.length + matchupDead.length);
  }, []);

  const run = useCallback(async () => {
    if (runningRef.current) {
      rerunRequestedRef.current = true;
      return;
    }
    runningRef.current = true;
    if (mountedRef.current) setSyncing(true);
    // Only stamp lastSyncedAt when ALL drains resolved without throwing — a
    // thrown syncOnce/syncPitOnce leaves the stamp untouched (truthful "last
    // SUCCESSFUL sync"). Tracked via a local flag so the finally can read it.
    let ok = false;
    try {
      do {
        rerunRequestedRef.current = false;
        await syncOnce();
        await syncPitOnce();
        await syncMatchupNotesOnce();
      } while (rerunRequestedRef.current);
      ok = true;
    } catch {
      // A drain threw (transient/terminal failures are already classified into
      // dead-letters inside the outbox engines, surfaced via refreshCounts). We
      // swallow here so the fire-and-forget callers (void run() on mount / poll /
      // reconnect) never produce an unhandled rejection — and crucially `ok`
      // stays false so lastSyncedAt is NOT stamped on a failed run.
    } finally {
      await refreshCounts();
      runningRef.current = false;
      if (mountedRef.current) {
        setSyncing(false);
        if (ok) setLastSyncedAt(Date.now());
      }
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

  // Once per session, the first time we are online: requeue any auth/RLS-class
  // dead-letters (the wrongly-terminal 42501-class failures the server fix in
  // migration 0012 now accepts) and drain. Guarded by a ref so it can never loop;
  // validation-class dead-letters are left untouched by requeueAuthClassDeadLetters.
  useEffect(() => {
    if (!online || requeuedAuthRef.current) return;
    requeuedAuthRef.current = true;
    void (async () => {
      // Both the match-report (migration 0012) AND pit-report (migration 0021)
      // write paths had server-side fixes that make previously auth/RLS-class
      // dead-letters succeed now — requeue both once.
      const [matchRequeued, pitRequeued, matchupRequeued] = await Promise.all([
        requeueAuthClassDeadLetters(),
        requeueAuthClassPitDeadLetters(),
        requeueAuthClassMatchupDeadLetters(),
      ]);
      if (matchRequeued > 0 || pitRequeued > 0 || matchupRequeued > 0) {
        await run();
      } else {
        await refreshCounts();
      }
    })();
  }, [online, run, refreshCounts]);

  // React immediately when a screen enqueues work (e.g. a pit report submit):
  // refresh the badge counts right away, and drain now if we're online instead
  // of waiting up to SYNC_POLL_MS for the next poll.
  useEffect(() => {
    function onChanged(): void {
      if (online) void run();
      else void refreshCounts();
    }
    window.addEventListener('scout-sync-changed', onChanged);
    return () => window.removeEventListener('scout-sync-changed', onChanged);
  }, [online, run, refreshCounts]);

  // Periodic poll while online only.
  useEffect(() => {
    if (!online) return;
    const id = setInterval(() => {
      void run();
    }, SYNC_POLL_MS);
    return () => clearInterval(id);
  }, [online, run]);

  return { online, queued, deadLetters, syncing, syncNow, lastSyncedAt };
}
