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
  const inFlightKey = useRef<string | null>(null);
  const autoKeyDone = useRef<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
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
    const requestGeneration = ++generation.current;
    inFlightKey.current = null;
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
      if (cancelled || !mounted.current || generation.current !== requestGeneration) return;
      if (meta) {
        setLastPreloadAt(meta.lastPreloadAt);
        // Normalize the stored partial counts into the PreloadResult shape.
        setCounts({
          matches: meta.counts.matches ?? 0,
          assignments: meta.counts.assignments ?? 0,
          pitAssignments: meta.counts.pitAssignments ?? 0,
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

  const run = useCallback(async (): Promise<boolean> => {
    if (!eventKey) return false;
    const key = `${eventKey}|${scoutId ?? ''}`;
    if (inFlightKey.current === key) return false;
    const requestGeneration = generation.current;
    inFlightKey.current = key;
    if (mounted.current) setStatus('running');
    try {
      const result = await preloadEventData({ eventKey, scoutId });
      if (!mounted.current || generation.current !== requestGeneration) return true;
      const meta = result.errors.length ? await getPreloadMeta(eventKey) : undefined;
      if (!mounted.current || generation.current !== requestGeneration) return true;
      setLastPreloadAt(meta?.lastPreloadAt ?? result.at);
      setCounts(
        meta
          ? {
              matches: meta.counts.matches ?? 0,
              assignments: meta.counts.assignments ?? 0,
              pitAssignments: meta.counts.pitAssignments ?? 0,
              roster: meta.counts.roster ?? 0,
              teams: meta.counts.teams ?? 0,
            }
          : result.counts,
      );
      setErrors(result.errors);
      setStatus(result.errors.length ? 'error' : 'ready');
    } catch (err) {
      // preloadEventData never throws, but guard anyway.
      if (!mounted.current || generation.current !== requestGeneration) return true;
      setErrors([err instanceof Error ? err.message : 'preload failed']);
      setStatus('error');
    } finally {
      if (inFlightKey.current === key) inFlightKey.current = null;
    }
    return true;
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
    void (async () => {
      const began = await run();
      // A blocked run (for example the previous event still finishing) is not
      // considered auto-complete; a later effect/online edge may retry it.
      if (began) autoKeyDone.current = key;
    })();
  }, [eventKey, scoutId, online, run]);

  return { status, lastPreloadAt, counts, errors, refresh };
}
