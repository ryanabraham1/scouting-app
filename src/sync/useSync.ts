// src/sync/useSync.ts
//
// The controller hook that drives the outbox engine. It runs syncOnce:
//   - on mount (if online),
//   - on the offline→online reconnect edge,
//   - every SYNC_POLL_MS while online,
//   - the moment any outbox gains a row (`scout-sync-changed`, also relayed
//     across tabs),
//   - when the tab becomes visible again (phones throttle background timers),
//   - when an anonymous session (re)appears — auth-class dead-letters are
//     requeued first so a device that booted without a session self-heals,
//   - on an explicit syncNow().
// Overlapping runs are guarded with a ref. After each run it refreshes the
// queued/dead-letter counts from the store and invalidates the React Query keys
// of whatever kinds of rows just landed, so this device's own dashboard/analysis
// views refresh without waiting for realtime. It never auto-runs while offline.
// Mount ONE `<SyncController />` (App.tsx) so drains run on every route; extra
// consumers only subscribe to the shared state.
// See phase3-contracts.md §3/§8 and the plan Task OUTBOX Step 4.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useOnline } from '@/sync/useOnline';
import { syncOnce } from '@/sync/outbox';
import { syncPitOnce } from '@/sync/pitOutbox';
import { syncMatchupNotesOnce } from '@/sync/matchupNotesSync';
import { syncStrategyCanvasOnce } from '@/sync/strategyCanvasSync';
import { clearSyncCircuit } from '@/sync/retrySchedule';
import { SYNC_QUEUE_CHANGED_EVENT } from '@/sync/queueEvents';
import { queryClient } from '@/lib/queryPersist';
import { supabase } from '@/lib/supabase';
import {
  getSyncQueue,
  listDeadLetters,
  requeueReport,
  getMatchupSyncQueue,
  listMatchupDeadLetters,
  requeueMatchupNote,
  getStrategyCanvasSyncQueue,
  listStrategyCanvasDeadLetters,
  requeueStrategyCanvas,
} from '@/db/localStore';
import { getPitSyncQueue, listPitDeadLetters, requeuePitReport } from '@/pit/pitStore';
import { isAutoRepairableReportValidationError } from '@/sync/classifyError';
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
// Set once the session-start requeue has completed. `authRequeuePromise` alone
// only serialized concurrent runs — it reset in `finally`, so every screen that
// mounted a sync badge re-requeued (and re-uploaded) every dead-letter again,
// including ones that can never succeed. A new/refreshed session re-arms it
// through subscribeAuthRecovery, which requeues on its own.
let sessionRequeueDone = false;
let controllerGeneration = 0;
let schedulerConsumers = 0;
let onlineSchedulerConsumers = 0;
let sharedPoll: ReturnType<typeof setInterval> | null = null;
let syncBroadcast: BroadcastChannel | null = null;
let authUnsubscribe: (() => void) | null = null;
let lastKnownOnline: boolean | null = null;

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
  sessionRequeueDone = false;
  schedulerConsumers = 0;
  onlineSchedulerConsumers = 0;
  if (sharedPoll) clearInterval(sharedPoll);
  sharedPoll = null;
  if (typeof window !== 'undefined') {
    window.removeEventListener(SYNC_QUEUE_CHANGED_EVENT, onSharedQueueChanged);
    document.removeEventListener('visibilitychange', onVisibilityChanged);
  }
  syncBroadcast?.close();
  syncBroadcast = null;
  authUnsubscribe?.();
  authUnsubscribe = null;
  lastKnownOnline = null;
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
  const landed = { reports: 0, pits: 0, notes: 0, canvases: 0 };
  // Each outbox drains in its own guard: a storage/DB failure in one (say a
  // blocked Dexie upgrade in scouting-db) must not silently starve the others
  // for the life of the tab. The first failure is rethrown after all four ran.
  let outboxFailure: unknown = null;
  const guarded = async (
    drain: () => Promise<{ synced: number }>,
    key: keyof typeof landed,
  ): Promise<void> => {
    try {
      landed[key] += (await drain()).synced;
    } catch (error) {
      outboxFailure ??= error;
    }
  };
  try {
    for (;;) {
      sharedRerunRequested = false;
      outboxFailure = null;
      const leaseResult = await withCrossTabSyncLease(async (stillOwner) => {
        if (!(await stillOwner())) return 'incomplete';
        await guarded(syncOnce, 'reports');
        if (!(await stillOwner())) return 'incomplete';
        await guarded(syncPitOnce, 'pits');
        if (!(await stillOwner())) return 'incomplete';
        await guarded(syncMatchupNotesOnce, 'notes');
        if (!(await stillOwner())) return 'incomplete';
        await guarded(syncStrategyCanvasOnce, 'canvases');
        if (outboxFailure) throw outboxFailure;
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
    invalidateLanded(landed);
  }
}

/**
 * This device just uploaded rows: refresh the server-backed queries that show
 * them so its own Analysis / Dashboard reflect the upload immediately — realtime
 * still covers every OTHER device. Runs after `syncing` flips back so a screen
 * that reacts to the flag sees the fresh data on the same tick.
 */
function invalidateLanded(landed: {
  reports: number;
  pits: number;
  notes: number;
  canvases: number;
}): void {
  if (landed.reports > 0) void queryClient.invalidateQueries({ queryKey: ['reports'] });
  if (landed.pits > 0) {
    void queryClient.invalidateQueries({ queryKey: ['event-pits'] });
    void queryClient.invalidateQueries({ queryKey: ['team-pit'] });
    void queryClient.invalidateQueries({ queryKey: ['team-photo'] });
  }
  if (landed.notes > 0) void queryClient.invalidateQueries({ queryKey: ['matchup-notes'] });
  if (landed.canvases > 0) {
    void queryClient.invalidateQueries({ queryKey: ['strategy-canvas'] });
  }
}

function onVisibilityChanged(): void {
  // Mobile browsers freeze timers in the background; the poll that "should"
  // have fired is silently late. A foreground return is the moment the scout
  // looks at the screen, so drain (and refresh counts) right then.
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  handleQueueChanged();
}

/**
 * The anonymous session can appear AFTER the first drain (a 429 on the venue
 * NAT at boot, a refresh that failed while offline). Rows that dead-lettered
 * as auth/RLS-class in the meantime are recoverable now, so re-arm the once-per-
 * session auth requeue and drain again. `TOKEN_REFRESHED` is the same signal for
 * a session that expired and came back.
 */
function subscribeAuthRecovery(): () => void {
  const auth = (supabase as { auth?: { onAuthStateChange?: unknown } }).auth;
  if (!auth || typeof auth.onAuthStateChange !== 'function') return () => {};
  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event !== 'SIGNED_IN' && event !== 'TOKEN_REFRESHED') return;
    authRequeuePromise = null;
    void requeueRecoverableDeadLetters().then((requeued) => {
      if (requeued > 0) void runSharedSync();
    });
  });
  return () => data.subscription.unsubscribe();
}

/**
 * Requeue every dead-letter that has a chance of succeeding now, across all
 * four outboxes. Runs once per session and again whenever a session (re)appears,
 * so a report parked by an outage, a server-side fix that has since deployed, a
 * missing session, or an old app version gets another try without anyone
 * opening the sync screen. Every upload is idempotent, so a row that is still
 * genuinely broken simply dead-letters again (same message, seconds later) and
 * stays visible with its Fix / Discard controls. Skipped on purpose:
 *   - validator dead-letters the sanitize pass repairs in-drain (it needs the
 *     stored error message to pick them out);
 *   - note/whiteboard conflicts, which autoResolveConflicts merges in-drain.
 */
async function requeueRecoverableDeadLetters(): Promise<number> {
  const [matchDead, pitDead, noteDead, canvasDead] = await Promise.all([
    listDeadLetters(),
    listPitDeadLetters(),
    listMatchupDeadLetters(),
    listStrategyCanvasDeadLetters(),
  ]);
  const matchTargets = matchDead.filter(
    (r) => !isAutoRepairableReportValidationError(r.lastSyncError),
  );
  const noteTargets = noteDead.filter((r) => r.recoveryIssue?.kind !== 'conflict');
  const canvasTargets = canvasDead.filter((r) => r.recoveryIssue?.kind !== 'conflict');
  await Promise.all([
    ...matchTargets.map((r) => requeueReport(r.id)),
    ...pitDead.map((r) => requeuePitReport(r.draftKey)),
    ...noteTargets.map((r) => requeueMatchupNote(r.key)),
    ...canvasTargets.map((r) => requeueStrategyCanvas(r.key)),
  ]);
  return matchTargets.length + pitDead.length + noteTargets.length + canvasTargets.length;
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
    window.addEventListener(SYNC_QUEUE_CHANGED_EVENT, onSharedQueueChanged);
    document.addEventListener('visibilitychange', onVisibilityChanged);
    if (typeof BroadcastChannel !== 'undefined') {
      syncBroadcast = new BroadcastChannel('frc-scout-sync');
      syncBroadcast.addEventListener('message', handleQueueChanged);
    }
    authUnsubscribe = subscribeAuthRecovery();
  }
  if (online) {
    // A reconnect edge is new information about the link: whatever backoff a
    // shared outage left behind (persisted, up to 5 min) no longer applies.
    if (lastKnownOnline === false) clearSyncCircuit();
    onlineSchedulerConsumers += 1;
    if (onlineSchedulerConsumers === 1) {
      void runSharedSync();
      sharedPoll = setInterval(() => void runSharedSync(), SYNC_POLL_MS);
    }
  } else {
    void refreshSharedCounts();
  }
  lastKnownOnline = online;

  return () => {
    schedulerConsumers = Math.max(0, schedulerConsumers - 1);
    if (schedulerConsumers === 0 && typeof window !== 'undefined') {
      window.removeEventListener(SYNC_QUEUE_CHANGED_EVENT, onSharedQueueChanged);
      document.removeEventListener('visibilitychange', onVisibilityChanged);
      syncBroadcast?.close();
      syncBroadcast = null;
      authUnsubscribe?.();
      authUnsubscribe = null;
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
    // An explicit tap is the user saying "try again now": drop any shared
    // outage backoff so the drain actually probes the server instead of
    // returning early for up to five minutes.
    clearSyncCircuit();
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

  // Once per session, the first time we are online: give every recoverable
  // dead-letter another try and drain (see requeueRecoverableDeadLetters).
  // Guarded so it can never loop; the auth listener re-arms it when a session
  // appears later. Repairable validation dead-letters are handled independently
  // inside every match-report syncOnce drain with a persisted recipe version.
  useEffect(() => {
    if (!online || authRequeuePromise || sessionRequeueDone) return;
    authRequeuePromise = (async () => {
      const requeued = await requeueRecoverableDeadLetters();
      // Only a completed pass counts: a storage failure above leaves it armed.
      sessionRequeueDone = true;
      if (requeued > 0) {
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

/**
 * Headless app-root consumer. Keeps the shared scheduler alive on EVERY route
 * (capture screen, analysis, dashboard, QR) — before this, the drain only ran
 * while a screen with a SyncIndicator was mounted, so a report submitted and
 * followed by a hop to Analysis on the same phone sat in the outbox until the
 * scout came back to Scout Home.
 */
export function SyncController(): null {
  useSync();
  return null;
}
