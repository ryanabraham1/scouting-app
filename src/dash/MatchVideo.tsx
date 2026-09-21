// src/dash/MatchVideo.tsx
// Lazily fetches the TBA match object for a match key and embeds the first
// youtube video as a responsive 16:9 iframe. Fetched with TanStack Query so it
// caches per match and never blocks the rest of the match detail — loading,
// no-video, and error all degrade to a small inline note.
//
// When an `onTimeMs` callback is supplied, we also attach the official YouTube
// IFrame Player API (via useYouTubePlayer) to the embed and report the live
// playback position so the caller can sync the activity timelines to the video.
// The embed sets enablejsapi=1 (required for the JS API) and an origin so the
// API can talk to the frame. If the API never loads, the video still plays and
// onTimeMs is simply never called — the timeline degrades to no playhead.
//
// Livestream fallback: when TBA has no match video yet but the caller resolved
// the day's YouTube stream (`stream`, see matchStream.ts), embed that stream
// instead and seek it to the match's start (live via the DVR window, or the
// VOD later). The same playhead/sync plumbing applies, so the activity
// timelines line up with the stream just like with a proper match video.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Radio, Video } from 'lucide-react';
import { tbaGetOptional, isUnavailable, type ProxyUnavailable } from '@/dash/proxies';
import { cn } from '@/lib/utils';
import { useYouTubePlayer, type YouTubeController } from '@/dash/useYouTubePlayer';
import { MATCH_STREAM_LEAD_SECONDS, type MatchStreamTarget } from '@/dash/matchStream';

export interface MatchVideoStreamProps {
  target: MatchStreamTarget;
  /** Called with the stream position (s) of match t=0 whenever we seek there. */
  onSeekedToMatch?: (t0Seconds: number) => void;
  /** Forwarded from the player: the stream's derived start while it is live. */
  onLiveStreamStart?: (epochMs: number) => void;
}

export interface MatchVideoProps {
  matchKey: string;
  className?: string;
  /** Live playback position in ms; called ~4x/sec while the video plays. */
  onTimeMs?: (ms: number) => void;
  /** Event livestream to fall back to when TBA has no video for this match. */
  stream?: MatchVideoStreamProps | null;
  /** Reports whether the livestream fallback (not a match video) is showing. */
  onStreamActive?: (active: boolean) => void;
}

interface TbaVideo {
  type?: string;
  key?: string;
}
interface TbaMatch {
  videos?: TbaVideo[] | null;
}

const STALE_TIME = 5 * 60_000;

/** First youtube video key on a TBA match object, or null. */
function firstYoutubeKey(match: TbaMatch | undefined): string | null {
  const videos = match?.videos;
  if (!Array.isArray(videos)) return null;
  const yt = videos.find((v) => v?.type === 'youtube' && typeof v.key === 'string' && v.key);
  return yt?.key ?? null;
}

function Frame({ children }: { children: React.ReactNode }): JSX.Element {
  // 16:9 responsive box.
  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-border bg-black/40">
      <div style={{ paddingTop: '56.25%' }} />
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

// The embedded player itself: holds the iframe ref and (when asked) wires the YT
// API to it. Mounted only once a youtube key exists so the API attaches to a
// real, stable element.
function PlayerFrame({
  ytKey,
  onTimeMs,
  startSeconds,
  onSeeked,
  onLiveStreamStart,
  title = 'Match video',
  testId = 'match-video-frame',
}: {
  ytKey: string;
  onTimeMs?: (ms: number) => void;
  /** Seek here once the API is ready (and again if it changes). */
  startSeconds?: number | null;
  onSeeked?: (seconds: number) => void;
  onLiveStreamStart?: (epochMs: number) => void;
  title?: string;
  testId?: string;
}): JSX.Element {
  const [iframe, setIframe] = useState<HTMLIFrameElement | null>(null);
  const [ctl, setCtl] = useState<YouTubeController | null>(null);
  const origin =
    typeof window !== 'undefined' && window.location ? window.location.origin : undefined;
  const wantsApi = !!onTimeMs || startSeconds != null || !!onLiveStreamStart;
  // enablejsapi=1 is required for the IFrame Player API to control/read the frame.
  const params = new URLSearchParams({ enablejsapi: '1' });
  if (origin) params.set('origin', origin);
  // `start` is honored by VOD embeds without the API; live embeds ignore it and
  // rely on the seekTo below. Pinned to the FIRST value so a later target change
  // (a calibration landing mid-watch) seeks in place instead of changing the
  // src and reloading the frame under the attached player.
  const [initialStart] = useState(startSeconds);
  if (initialStart != null) params.set('start', String(Math.max(0, Math.floor(initialStart))));
  const src = `https://www.youtube.com/embed/${ytKey}?${params.toString()}`;

  useYouTubePlayer({
    iframe,
    enabled: wantsApi,
    onTimeMs,
    onReady: setCtl,
    onLiveStreamStart,
  });

  // Seek when the player becomes controllable or the target moves (e.g. a
  // calibration arriving after mount).
  const onSeekedRef = useRef(onSeeked);
  onSeekedRef.current = onSeeked;
  useEffect(() => {
    if (!ctl || startSeconds == null) return;
    ctl.seekTo(startSeconds);
    onSeekedRef.current?.(startSeconds);
  }, [ctl, startSeconds]);

  return (
    <Frame>
      <iframe
        ref={setIframe}
        data-testid={testId}
        className="absolute inset-0 h-full w-full"
        src={src}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    </Frame>
  );
}

// The livestream fallback body: the day's stream seeked to the match (when the
// stream is calibrated) plus an honest note about what it is showing.
function StreamFallback({
  stream,
  onTimeMs,
}: {
  stream: MatchVideoStreamProps;
  onTimeMs?: (ms: number) => void;
}): JSX.Element {
  const { target, onSeekedToMatch, onLiveStreamStart } = stream;
  const t0 = target.t0Seconds;
  const startSeconds = t0 != null ? Math.max(0, t0 - MATCH_STREAM_LEAD_SECONDS) : null;
  const seekedRef = useRef(onSeekedToMatch);
  seekedRef.current = onSeekedToMatch;
  let note: string;
  if (t0 == null) {
    note =
      'No match video yet — showing the event livestream. Stream not calibrated: keep it playing live (here or on Next Match), or scrub to this match and press Sync to match start.';
  } else if (target.approximate) {
    note =
      'No match video yet — event livestream from this match’s scheduled start (estimated; the actual start may differ by a few minutes).';
  } else {
    note = 'No match video yet — event livestream from this match’s start.';
  }
  return (
    <div className="flex flex-col gap-1">
      <PlayerFrame
        ytKey={target.videoId}
        onTimeMs={onTimeMs}
        startSeconds={startSeconds}
        onSeeked={() => {
          if (t0 != null) seekedRef.current?.(t0);
        }}
        onLiveStreamStart={onLiveStreamStart}
        title="Event livestream"
        testId="match-video-stream-frame"
      />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span
          data-testid="match-video-stream-note"
          className="inline-flex items-start gap-2 text-xs text-muted-foreground"
        >
          <Radio className="mt-0.5 size-3 shrink-0" /> {note}
        </span>
        <a
          data-testid="match-video-stream-link"
          href={`https://youtu.be/${encodeURIComponent(target.videoId)}${
            startSeconds != null ? `?t=${Math.floor(startSeconds)}` : ''
          }`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3" /> Open on YouTube
        </a>
      </div>
    </div>
  );
}

export default function MatchVideo({
  matchKey,
  className,
  onTimeMs,
  stream,
  onStreamActive,
}: MatchVideoProps): JSX.Element {
  const query = useQuery({
    queryKey: ['tba', 'match', matchKey],
    enabled: !!matchKey,
    staleTime: STALE_TIME,
    queryFn: (): Promise<TbaMatch | ProxyUnavailable> =>
      tbaGetOptional<TbaMatch>(`/match/${matchKey}`),
  });
  // Avoid re-subscribing the player effect on every parent render.
  const onTimeRef = useRef(onTimeMs);
  onTimeRef.current = onTimeMs;

  let body: JSX.Element;
  let streamActive = false;
  if (query.isLoading) {
    body = (
      <Frame>
        <span data-testid="match-video-loading" className="text-sm text-muted-foreground">
          Loading match video…
        </span>
      </Frame>
    );
  } else if (query.isError) {
    // Defensive: tbaGetOptional never rejects in production (it degrades to the
    // { available:false } sentinel handled below). Retained as a belt-and-
    // suspenders path for a genuine query rejection.
    body = (
      <Frame>
        <span data-testid="match-video-error" className="text-sm text-warning">
          Couldn’t load match video.
        </span>
      </Frame>
    );
  } else if (isUnavailable(query.data) && stream) {
    // TBA offline but we already know the day's stream (from an earlier event
    // fetch) — the stream still plays, so prefer it over an "unavailable" note.
    streamActive = true;
    body = <StreamFallback stream={stream} onTimeMs={onTimeMs ? (ms) => onTimeRef.current?.(ms) : undefined} />;
  } else if (isUnavailable(query.data)) {
    // TBA offline — calm info-tone note matching the Statbotics/Nexus degrade
    // pattern. Early return so query.data narrows to TbaMatch below.
    body = (
      <Frame>
        <span
          data-testid="match-video-unavailable"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Video className="size-4" /> Video unavailable — TBA offline
        </span>
      </Frame>
    );
  } else {
    const key = firstYoutubeKey(query.data);
    if (key) {
      body = (
        <div className="flex flex-col gap-1">
          <PlayerFrame
            ytKey={key}
            onTimeMs={onTimeMs ? (ms) => onTimeRef.current?.(ms) : undefined}
          />
          <a
            data-testid="match-video-yt-link"
            href={`https://youtu.be/${encodeURIComponent(key)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 self-end text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" /> Watch on YouTube
          </a>
        </div>
      );
    } else if (stream) {
      streamActive = true;
      body = <StreamFallback stream={stream} onTimeMs={onTimeMs ? (ms) => onTimeRef.current?.(ms) : undefined} />;
    } else {
      body = (
        <div className="flex flex-col items-center gap-1">
          <Frame>
            <span
              data-testid="match-video-none"
              className="inline-flex items-center gap-2 text-sm text-warning/80"
            >
              <Video className="size-4" /> No video available
            </span>
          </Frame>
          <span className="text-xs text-muted-foreground">
            Videos usually appear 1–4h after the match.
          </span>
        </div>
      );
    }
  }

  const onStreamActiveRef = useRef(onStreamActive);
  onStreamActiveRef.current = onStreamActive;
  useEffect(() => {
    onStreamActiveRef.current?.(streamActive);
  }, [streamActive]);

  return <div className={cn('w-full', className)}>{body}</div>;
}
