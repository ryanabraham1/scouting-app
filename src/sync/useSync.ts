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
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useOnline } from '@/sync/useOnline';
import { syncOnce } from '@/sync/outbox';
import { syncPitOnce } from '@/sync/pitOutbox';
import { syncMatchupNotesOnce } from '@/sync/matchupNotesSync';
import { syncStrategyCanvasOnce } from '@/sync/strategyCanvasSync';
import {
  getSyncQueue,
  listDeadLetters,
  requeueAuthClassDeadLetters,
  getMatchupSyncQueue,
  listMatchupDeadLetters,
  requeueAuthClassMatchupDeadLetters,
  getStrategyCanvasSyncQueue,
  listStrategyCanvasDeadLetters,
} from '@/db/localStore';
import {
  getPitSyncQueue,
  listPitDeadLetters,
  requeueAuthClassPitDeadLetters,
} from '@/pit/pitStore';
import { SYNC_POLL_MS } from '@/sync/constants';
import { withCrossTabSyncLease } from '@/sync/syncLease';

export interface UseSyncResult {
  online: boolean;
  queued: number;
  deadLetters: number;
  syncing: boolean;
  syncNow: () => void;
  /** Date.now() of the last fully completed leased drain; null until one finishes. */
  lastSyncedAt: number | null;
}

interface SharedSyncState {
  queued: number;
  deadLetters: number;
  syncing: boolean;
  lastSyncedAt: number | null;
}

let sharedState: SharedSyncState = {
  queued: 0,
  deadLetters: 0,
  syncing: false,
  lastSyncedAt: null,
};
const sharedListeners = new Set<() => void>();
let sharedRunning = false;
let sharedRerunRequested = false;
let authRequeuePromise: Promise<void> | null = null;
let controllerGeneration = 0;
let schedulerConsumers = 0;
let onlineSchedulerConsumers = 0;
let sharedPoll: ReturnType<typeof setInterval> | null = null;
let syncBroadcast: BroadcastChannel | null = null;

/** Read-only controller snapshot (also useful for deterministic diagnostics). */
export function getSyncControllerState(): Readonly<SharedSyncState> {
  return sharedState;
}

/** @internal Test isolation for fake-timer runs that intentionally stop mid-drain. */
export function resetSyncControllerForTests(): void {
  controllerGeneration += 1;
  sharedRunning = false;
  sharedRerunRequested = false;
  authRequeuePromise = null;
  schedulerConsumers = 0;
  onlineSchedulerConsumers = 0;
  if (sharedPoll) clearInterval(sharedPoll);
  sharedPoll = null;
  if (typeof window !== 'undefined') {
    window.removeEventListener('scout-sync-changed', onSharedQueueChanged);
  }
  syncBroadcast?.close();
  syncBroadcast = null;
  sharedState = { ...sharedState, syncing: false };
}

function publishShared(patch: Partial<SharedSyncState>): void {
  sharedState = { ...sharedState, ...patch };
  for (const listener of sharedListeners) listener();
}

function subscribeShared(listener: () => void): () => void {
  sharedListeners.add(listener);
  return () => sharedListeners.delete(listener);
}

async function refreshSharedCounts(): Promise<void> {
  const [queue, dead, pitQueue, pitDead, matchupQueue, matchupDead, canvasQueue, canvasDead] =
    await Promise.all([
      getSyncQueue(),
      listDeadLetters(),
      getPitSyncQueue(),
      listPitDeadLetters(),
      getMatchupSyncQueue(),
      listMatchupDeadLetters(),
      getStrategyCanvasSyncQueue(),
      listStrategyCanvasDeadLetters(),
    ]);
  publishShared({
    queued: queue.length + pitQueue.length + matchupQueue.length + canvasQueue.length,
    deadLetters: dead.length + pitDead.length + matchupDead.length + canvasDead.length,
  });
}

async function runSharedSync(): Promise<void> {
  if (sharedRunning) {
    sharedRerunRequested = true;
    return;
  }
  sharedRunning = true;
  const generation = controllerGeneration;
  publishShared({ syncing: true });
  let ok = false;
  let retriedIncompleteDrain = false;
  try {
    for (;;) {
      sharedRerunRequested = false;
      const leaseResult = await withCrossTabSyncLease(async (stillOwner) => {
        if (!(await stillOwner())) return 'incomplete';
        await syncOnce();
        if (!(await stillOwner())) return 'incomplete';
        await syncPitOnce();
        if (!(await stillOwner())) return 'incomplete';
        await syncMatchupNotesOnce();
        if (!(await stillOwner())) return 'incomplete';
        await syncStrategyCanvasOnce();
        return 'completed';
      });
      if (generation !== controllerGeneration) return;
      if (leaseResult === 'not-acquired') break;
      if (leaseResult === 'incomplete') {
        // A suspended tab can lose its fallback lease between outbox phases.
        // Retry once immediately: if a successor owns the lease this resolves
        // as not-acquired, and if no successor claimed it we finish the drain.
        // A second loss stops here and leaves the normal poll/queue event as the
        // bounded retry path rather than spinning inside one controller run.
        if (retriedIncompleteDrain) break;
        retriedIncompleteDrain = true;
        continue;
      }
      ok = true;
      if (!sharedRerunRequested) break;
    }
  } catch {
    ok = false;
  } finally {
    if (generation !== controllerGeneration) return;
    try {
      await refreshSharedCounts();
    } catch {
      /* best-effort */
    }
    sharedRunning = false;
    publishShared({
      syncing: false,
      ...(ok ? { lastSyncedAt: Date.now() } : {}),
    });
  }
}

function onSharedQueueChanged(): void {
  syncBroadcast?.postMessage({ type: 'queue-changed' });
  handleQueueChanged();
}

function handleQueueChanged(): void {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) {
    void runSharedSync();
  } else {
    void refreshSharedCounts();
  }
}

function addSharedScheduler(online: boolean): () => void {
  schedulerConsumers += 1;
  if (schedulerConsumers === 1 && typeof window !== 'undefined') {
    window.addEventListener('scout-sync-changed', onSharedQueueChanged);
    if (typeof BroadcastChannel !== 'undefined') {
      syncBroadcast = new BroadcastChannel('frc-scout-sync');
      syncBroadcast.addEventListener('message', handleQueueChanged);
    }
  }
  if (online) {
    onlineSchedulerConsumers += 1;
    if (onlineSchedulerConsumers === 1) {
      void runSharedSync();
      sharedPoll = setInterval(() => void runSharedSync(), SYNC_POLL_MS);
    }
  } else {
    void refreshSharedCounts();
  }

  return () => {
    schedulerConsumers = Math.max(0, schedulerConsumers - 1);
    if (schedulerConsumers === 0 && typeof window !== 'undefined') {
      window.removeEventListener('scout-sync-changed', onSharedQueueChanged);
      syncBroadcast?.close();
      syncBroadcast = null;
    }
    if (online) {
      onlineSchedulerConsumers = Math.max(0, onlineSchedulerConsumers - 1);
      if (onlineSchedulerConsumers === 0 && sharedPoll) {
        clearInterval(sharedPoll);
        sharedPoll = null;
      }
    }
  };
}

export function useSync(): UseSyncResult {
  const online = useOnline();
  const syncState = useSyncExternalStore(subscribeShared, () => sharedState, () => sharedState);

  const refreshCounts = useCallback(async () => {
    // `queued` = the retry worklist (dirty + pending), which EXCLUDES dead-letters.
    // Dead-letters are surfaced separately so the badge never double-counts them.
    // Pit reports drain through the same indicator, so their counts are folded in.
    const [queue, dead, pitQueue, pitDead, matchupQueue, matchupDead, canvasQueue, canvasDead] =
      await Promise.all([
        getSyncQueue(),
        listDeadLetters(),
        getPitSyncQueue(),
        listPitDeadLetters(),
        getMatchupSyncQueue(),
        listMatchupDeadLetters(),
        getStrategyCanvasSyncQueue(),
        listStrategyCanvasDeadLetters(),
      ]);
    publishShared({
      queued: queue.length + pitQueue.length + matchupQueue.length + canvasQueue.length,
      deadLetters: dead.length + pitDead.length + matchupDead.length + canvasDead.length,
    });
  }, []);

  const run = useCallback(async () => {
    await runSharedSync();
  }, []);

  const syncNow = useCallback(() => {
    void run();
  }, [run]);

  useEffect(() => {
    // Always reflect the stored queue on mount, even while offline (offline never
    // runs syncOnce, but the queued/dead-letter counts must still be shown).
    void refreshCounts();
  }, [refreshCounts]);

  // One shared listener/poll controller for every mounted consumer. Reconnects
  // start it when the first online consumer appears; duplicate hooks only
  // subscribe to shared state and cannot create duplicate drain loops.
  useEffect(() => addSharedScheduler(online), [online]);

  // Once per session, the first time we are online: requeue any auth/RLS-class
  // dead-letters (the wrongly-terminal 42501-class failures the server fix in
  // migration 0012 now accepts) and drain. Guarded by a ref so it can never loop;
  // repairable validation dead-letters are handled independently inside every
  // match-report syncOnce drain, with a persisted recipe version preventing loops.
  useEffect(() => {
    if (!online || authRequeuePromise) return;
    authRequeuePromise = (async () => {
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
    })().finally(() => {
      authRequeuePromise = null;
    });
  }, [online, run, refreshCounts]);

  return { online, ...syncState, syncNow };
}
