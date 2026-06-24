// src/offline/useOfflinePreload.ts
//
// Drives the offline preload for the active event: seeds from the last-saved
// PreloadMeta, auto-refreshes once whenever the device comes online, and exposes
// a manual refresh() for the "Download for offline" button.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOnline } from '@/sync/useOnline';
import {
  preloadEventData,
  getPreloadMeta,
  type PreloadResult,
} from '@/db/preloadClient';

export interface OfflinePreloadState {
  status: 'idle' | 'running' | 'ready' | 'error';
  lastPreloadAt: string | null;
  counts: PreloadResult['counts'] | null;
  errors: string[];
  refresh: () => void; // manual trigger
}

export function useOfflinePreload(
  eventKey: string | null,
  scoutId?: string,
): OfflinePreloadState {
  const online = useOnline();
  const [status, setStatus] = useState<OfflinePreloadState['status']>('idle');
  const [lastPreloadAt, setLastPreloadAt] = useState<string | null>(null);
  const [counts, setCounts] = useState<PreloadResult['counts'] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  // Guards so we don't loop: a request is in flight, and an "already auto-ran
  // for this online session / event" marker keyed by event+scout+online-epoch.
  const inFlight = useRef(false);
  const autoKeyDone = useRef<string | null>(null);
  const mounted = useRef(true);
  // Bumped each time we transition offline->online so auto-refresh re-fires.
  const onlineEpoch = useRef(0);
  const prevOnline = useRef(online);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Seed lastPreloadAt/counts from the stored meta whenever the target changes.
  useEffect(() => {
    if (!eventKey) {
      setStatus('idle');
      setLastPreloadAt(null);
      setCounts(null);
      setErrors([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const meta = await getPreloadMeta(eventKey);
      if (cancelled || !mounted.current) return;
      if (meta) {
        setLastPreloadAt(meta.lastPreloadAt);
        // Normalize the stored partial counts into the PreloadResult shape.
        setCounts({
          matches: meta.counts.matches ?? 0,
          assignments: meta.counts.assignments ?? 0,
          roster: meta.counts.roster ?? 0,
          teams: meta.counts.teams ?? 0,
        });
        setStatus('ready');
      } else {
        setStatus('idle');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventKey, scoutId]);

  const run = useCallback(async (): Promise<void> => {
    if (!eventKey || inFlight.current) return;
    inFlight.current = true;
    if (mounted.current) setStatus('running');
    try {
      const result = await preloadEventData({ eventKey, scoutId });
      if (!mounted.current) return;
      setLastPreloadAt(result.at);
      setCounts(result.counts);
      setErrors(result.errors);
      setStatus(result.errors.length ? 'error' : 'ready');
    } catch (err) {
      // preloadEventData never throws, but guard anyway.
      if (!mounted.current) return;
      setErrors([err instanceof Error ? err.message : 'preload failed']);
      setStatus('error');
    } finally {
      inFlight.current = false;
    }
  }, [eventKey, scoutId]);

  const refresh = useCallback((): void => {
    void run();
  }, [run]);

  // Track offline->online transitions; bump the epoch so the auto-effect re-runs.
  useEffect(() => {
    if (online && !prevOnline.current) {
      onlineEpoch.current += 1;
    }
    prevOnline.current = online;
  }, [online]);

  // Auto-refresh: once per (event, scout, online-epoch) while online.
  useEffect(() => {
    if (!eventKey || !online) return;
    const key = `${eventKey}|${scoutId ?? ''}|${onlineEpoch.current}`;
    if (autoKeyDone.current === key) return;
    autoKeyDone.current = key;
    void run();
  }, [eventKey, scoutId, online, run]);

  return { status, lastPreloadAt, counts, errors, refresh };
}
