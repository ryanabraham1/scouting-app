// src/dash/useYouTubePlayer.ts
// Loads the official YouTube IFrame Player API (window.YT) via one shared script
// injection, then attaches a YT.Player to a given iframe element so we can read
// live playback position. Used by MatchVideo to expose currentTime up to
// MatchView for syncing the activity timelines to the running match video, and
// by the livestream embeds to (a) seek the day's stream to a match's start and
// (b) derive when the stream itself started while it is live (see
// onLiveStreamStart), which is what makes the VOD seekable later.
//
// Graceful by design: if the API never loads (offline, blocked, test env) or the
// element is absent, the hook simply never reports a time and callers degrade to
// a video with no playhead. Nothing here throws.

import { useEffect, useRef } from 'react';

// Minimal shape of the bits of the YT API we touch — keeps us off a new dep.
interface YTPlayer {
  getCurrentTime?: () => number;
  /** For a live stream: seconds elapsed since it began. For a VOD: its length. */
  getDuration?: () => number;
  seekTo?: (seconds: number, allowSeekAhead?: boolean) => void;
  playVideo?: () => void;
  destroy?: () => void;
}

/** The subset of player control we hand back to callers once the API is ready. */
export interface YouTubeController {
  seekTo: (seconds: number) => void;
}
interface YTPlayerCtorOptions {
  events?: {
    onReady?: (e: { target: YTPlayer }) => void;
    onStateChange?: (e: { data: number; target: YTPlayer }) => void;
  };
}
interface YTNamespace {
  Player: new (el: HTMLElement | string, opts: YTPlayerCtorOptions) => YTPlayer;
  PlayerState?: { PLAYING?: number };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const SCRIPT_SRC = 'https://www.youtube.com/iframe_api';
const POLL_MS = 250;
// Live-stream detection: a live video's getDuration() grows with wall time; a
// VOD's is constant. Sample at least this far apart and require growth that
// tracks the wall clock (0.5x–1.5x) so a buffering VOD can never look live.
const LIVE_SAMPLE_MS = 5_000;
const LIVE_MIN_GROWTH_RATIO = 0.5;
const LIVE_MAX_GROWTH_RATIO = 1.5;
// Re-report the derived stream start at most this often (it drifts by a second
// or two as YouTube updates its elapsed counter; callers persist it).
const LIVE_REPORT_MS = 60_000;

// Resolves once window.YT.Player is available. Shared across all callers so the
// script is injected at most once. Rejects nothing — pending forever if it never
// loads, which is fine because callers tear down on unmount.
let apiPromise: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
  if (typeof window === 'undefined') return new Promise<YTNamespace>(() => {});
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YTNamespace>((resolve) => {
    const ready = () => {
      if (window.YT && window.YT.Player) resolve(window.YT);
    };
    // The API calls this global when it finishes loading. Chain any prior hook.
    const prior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prior?.();
      ready();
    };
    // If the script tag already exists (e.g. another mount), just wait for ready.
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (!existing) {
      const tag = document.createElement('script');
      tag.src = SCRIPT_SRC;
      tag.async = true;
      document.head.appendChild(tag);
    }
    // Belt-and-suspenders: in case the API was already present.
    ready();
  });
  return apiPromise;
}

export interface UseYouTubePlayerOptions {
  /** The iframe element to attach the YT.Player to (or null until mounted). */
  iframe: HTMLIFrameElement | null;
  /** Whether to attach at all (e.g. only when a video key exists). */
  enabled: boolean;
  /** Called ~4x/sec with the live playback position in milliseconds. */
  onTimeMs?: (ms: number) => void;
  /** Called once the player is controllable (seek etc.). */
  onReady?: (ctl: YouTubeController) => void;
  /**
   * Called (throttled) with the epoch-ms the stream began, derived as
   * `now - getDuration()` — only while the video is detectably LIVE, never for a
   * VOD (whose duration is its length, which would give a nonsense start).
   */
  onLiveStreamStart?: (epochMs: number) => void;
}

/**
 * Attaches a YT.Player to `iframe` and polls its currentTime, reporting it (in
 * ms) through onTimeMs. Cleans up the player + interval on unmount or when the
 * iframe/enabled inputs change. Never throws; if the API can't load, onTimeMs is
 * simply never called.
 */
export function useYouTubePlayer({
  iframe,
  enabled,
  onTimeMs,
  onReady,
  onLiveStreamStart,
}: UseYouTubePlayerOptions): void {
  // Keep the latest callbacks without re-running the attach effect each render.
  const onTimeRef = useRef(onTimeMs);
  onTimeRef.current = onTimeMs;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onLiveRef = useRef(onLiveStreamStart);
  onLiveRef.current = onLiveStreamStart;

  useEffect(() => {
    if (!enabled || !iframe) return;
    let cancelled = false;
    let player: YTPlayer | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    // Live detection state: last duration sample + when it was taken, and when
    // we last reported a derived stream start.
    let lastSample: { duration: number; at: number } | null = null;
    let lastReportAt = 0;

    const sampleLive = () => {
      if (!onLiveRef.current) return;
      const d = player?.getDuration?.();
      if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return;
      const now = Date.now();
      if (!lastSample) {
        lastSample = { duration: d, at: now };
        return;
      }
      const wall = now - lastSample.at;
      if (wall < LIVE_SAMPLE_MS) return;
      const growth = (d - lastSample.duration) * 1000;
      lastSample = { duration: d, at: now };
      const ratio = growth / wall;
      if (ratio < LIVE_MIN_GROWTH_RATIO || ratio > LIVE_MAX_GROWTH_RATIO) return;
      if (now - lastReportAt < LIVE_REPORT_MS) return;
      lastReportAt = now;
      onLiveRef.current?.(now - d * 1000);
    };

    const startPolling = () => {
      if (timer) return;
      timer = setInterval(() => {
        const t = player?.getCurrentTime?.();
        if (typeof t === 'number' && Number.isFinite(t)) onTimeRef.current?.(t * 1000);
        sampleLive();
      }, POLL_MS);
    };

    const onPlayerReady = () => {
      startPolling();
      const p = player;
      if (!p || !onReadyRef.current) return;
      onReadyRef.current({
        seekTo: (seconds) => {
          try {
            p.seekTo?.(Math.max(0, seconds), true);
          } catch {
            /* seek before the player is usable — ignore */
          }
        },
      });
    };

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        try {
          player = new YT.Player(iframe, {
            events: {
              onReady: () => onPlayerReady(),
              onStateChange: () => startPolling(),
            },
          });
        } catch {
          // Constructing the player failed — degrade silently to no playhead.
        }
      })
      .catch(() => {
        /* never rejects, but stay defensive */
      });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      try {
        player?.destroy?.();
      } catch {
        /* ignore teardown errors */
      }
    };
  }, [iframe, enabled]);
}
