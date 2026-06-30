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

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Video } from 'lucide-react';
import { tbaGetOptional, isUnavailable, type ProxyUnavailable } from '@/dash/proxies';
import { cn } from '@/lib/utils';
import { useYouTubePlayer } from '@/dash/useYouTubePlayer';

export interface MatchVideoProps {
  matchKey: string;
  className?: string;
  /** Live playback position in ms; called ~4x/sec while the video plays. */
  onTimeMs?: (ms: number) => void;
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
}: {
  ytKey: string;
  onTimeMs?: (ms: number) => void;
}): JSX.Element {
  const [iframe, setIframe] = useState<HTMLIFrameElement | null>(null);
  const origin =
    typeof window !== 'undefined' && window.location ? window.location.origin : undefined;
  // enablejsapi=1 is required for the IFrame Player API to control/read the frame.
  const params = new URLSearchParams({ enablejsapi: '1' });
  if (origin) params.set('origin', origin);
  const src = `https://www.youtube.com/embed/${ytKey}?${params.toString()}`;

  useYouTubePlayer({
    iframe,
    enabled: !!onTimeMs,
    onTimeMs: onTimeMs ?? (() => {}),
  });

  return (
    <Frame>
      <iframe
        ref={setIframe}
        data-testid="match-video-frame"
        className="absolute inset-0 h-full w-full"
        src={src}
        title="Match video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    </Frame>
  );
}

export default function MatchVideo({ matchKey, className, onTimeMs }: MatchVideoProps): JSX.Element {
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

  return <div className={cn('w-full', className)}>{body}</div>;
}
