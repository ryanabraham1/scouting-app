import { registerSW } from 'virtual:pwa-register';

// The ~2.4 MB field image every capture/auto/review screen renders. Precached by
// the SW (vite.config globPatterns), but devices still running a STALE SW built
// under the old 2 MB precache cap never got it — warming it on launch routes it
// through that SW's /assets/ CacheFirst runtime rule so one online launch makes
// it durably available offline.
const FIELD_IMAGE_URL = '/assets/field/field.png';
let pendingUpdate = false;
let blockedActivities = 0;
let activateUpdate: (() => Promise<void>) | null = null;
let updatePoll: ReturnType<typeof setInterval> | null = null;
const updateListeners = new Set<() => void>();
const tabId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
const remoteBlockedTabs = new Set<string>();
let updateChannel: BroadcastChannel | null = null;

type UpdateChannelMessage =
  | { type: 'block-state'; tabId: string; blocked: boolean }
  | { type: 'request-state'; tabId: string };

function isBlocked(): boolean {
  return blockedActivities > 0 || remoteBlockedTabs.size > 0;
}

function publishBlockState(): void {
  updateChannel?.postMessage({
    type: 'block-state',
    tabId,
    blocked: blockedActivities > 0,
  } satisfies UpdateChannelMessage);
}

function ensureUpdateChannel(): void {
  if (updateChannel || typeof BroadcastChannel === 'undefined') return;
  updateChannel = new BroadcastChannel('frc-pwa-update-safety-v1');
  updateChannel.addEventListener('message', (event: MessageEvent<UpdateChannelMessage>) => {
    const message = event.data;
    if (!message || message.tabId === tabId) return;
    if (message.type === 'request-state') {
      publishBlockState();
      return;
    }
    const wasBlocked = isBlocked();
    if (message.blocked) remoteBlockedTabs.add(message.tabId);
    else remoteBlockedTabs.delete(message.tabId);
    if (wasBlocked !== isBlocked()) notifyUpdateState();
  });
  updateChannel.postMessage({ type: 'request-state', tabId } satisfies UpdateChannelMessage);
  if (typeof window !== 'undefined') {
    window.addEventListener(
      'pagehide',
      () => {
        blockedActivities = 0;
        publishBlockState();
        updateChannel?.close();
        updateChannel = null;
      },
      { once: true },
    );
  }
}

function notifyUpdateState(): void {
  for (const listener of updateListeners) listener();
}

export function subscribePwaUpdate(listener: () => void): () => void {
  ensureUpdateChannel();
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

export function getPwaUpdateState(): { pending: boolean; blocked: boolean } {
  ensureUpdateChannel();
  return { pending: pendingUpdate, blocked: isBlocked() };
}

/** Mark a live capture/review/pit editor as unsafe for an app-shell reload. */
export function beginPwaUpdateBlock(): () => void {
  ensureUpdateChannel();
  blockedActivities += 1;
  if (blockedActivities === 1) publishBlockState();
  notifyUpdateState();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    blockedActivities = Math.max(0, blockedActivities - 1);
    if (blockedActivities === 0) publishBlockState();
    notifyUpdateState();
  };
}

export async function applyPendingPwaUpdate(): Promise<boolean> {
  if (!pendingUpdate || isBlocked() || !activateUpdate) return false;
  await activateUpdate();
  pendingUpdate = false;
  notifyUpdateState();
  return true;
}

export async function registerPwa(): Promise<void> {
  ensureUpdateChannel();
  let updateSW: (reloadPage?: boolean) => Promise<void> = async () => {};
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // Never reload underneath live data entry. Keep the update pending until
      // the global prompt is visible on a safe screen and the user activates it.
      pendingUpdate = true;
      notifyUpdateState();
    },
    onRegisteredSW(_swScriptUrl, registration) {
      // Check immediately on every launch. Browser-managed update checks can be
      // throttled, which otherwise leaves a recently reopened PWA displaying the
      // previous bundle until a later navigation or the hourly poll.
      void registration?.update().catch(() => {});
      // Hourly update check: scouting devices keep the app open all day, and
      // without this a stale SW (and its stale precache) survives until a full
      // relaunch — the field image bug lived exactly there.
      if (registration) {
        if (updatePoll) clearInterval(updatePoll);
        updatePoll = setInterval(
          () => void registration.update().catch(() => {}),
          60 * 60 * 1000,
        );
        window.addEventListener(
          'pagehide',
          () => {
            if (updatePoll) clearInterval(updatePoll);
            updatePoll = null;
          },
          { once: true },
        );
      }
    },
  });
  activateUpdate = () => updateSW(true);

  if (typeof fetch === 'function') {
    void fetch(FIELD_IMAGE_URL).catch(() => {
      // Offline right now — the precache (or next online launch) covers it.
    });
  }

  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.persist === 'function'
  ) {
    try {
      await navigator.storage.persist();
    } catch {
      // Persistent storage is best-effort; ignore failures.
    }
  }
}
