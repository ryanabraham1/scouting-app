import { registerSW } from 'virtual:pwa-register';

// The ~2.4 MB field image every capture/auto/review screen renders. Precached by
// the SW (vite.config globPatterns), but devices still running a STALE SW built
// under the old 2 MB precache cap never got it — warming it on launch routes it
// through that SW's /assets/ CacheFirst runtime rule so one online launch makes
// it durably available offline.
const FIELD_IMAGE_URL = '/assets/field/field.png';

export async function registerPwa(): Promise<void> {
  registerSW({
    immediate: true,
    onRegistered(registration) {
      // Hourly update check: scouting devices keep the app open all day, and
      // without this a stale SW (and its stale precache) survives until a full
      // relaunch — the field image bug lived exactly there.
      if (registration) {
        setInterval(() => void registration.update().catch(() => {}), 60 * 60 * 1000);
      }
    },
  });

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
