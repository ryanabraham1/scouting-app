// Collapses a burst of refresh triggers into one run per device.
//
// Realtime delivers one postgres_changes event PER ROW. A lead publishing a
// schedule rewrites hundreds of assignment rows, so an un-coalesced listener
// fires hundreds of event-wide reads on every phone at the same moment, which
// took the REST API down with 504/522s mid-event. The jitter matters as much as
// the delay: it keeps a whole stand of phones from refetching in lockstep.

export interface CoalescedRefreshOptions {
  /** Minimum wait after the first trigger of a burst. */
  delayMs: number;
  /** Extra random wait in [0, jitterMs) so devices spread out. */
  jitterMs?: number;
  random?: () => number;
}

export interface CoalescedRefresh {
  /** Schedule one run; triggers during the wait or a run share that run. */
  request: () => void;
  /** Run now (user-driven triggers), or once more after the current run. */
  flush: () => void;
  /** Drop anything pending. Later triggers are ignored. */
  cancel: () => void;
}

export function createCoalescedRefresh(
  run: () => unknown,
  { delayMs, jitterMs = 0, random = Math.random }: CoalescedRefreshOptions,
): CoalescedRefresh {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerun = false;
  let cancelled = false;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const request = (): void => {
    if (cancelled) return;
    if (running) {
      rerun = true;
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(fire, delayMs + random() * jitterMs);
  };

  function fire(): void {
    clearTimer();
    if (cancelled) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    void Promise.resolve()
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (rerun) {
          rerun = false;
          request();
        }
      });
  }

  return {
    request,
    flush: fire,
    cancel: () => {
      cancelled = true;
      rerun = false;
      clearTimer();
    },
  };
}
