// src/dash/matchStream.ts
// Pure resolver for "where in the event livestream does this match start?".
// TBA match videos often land hours late (or never), but the day's YouTube
// livestream is on TBA from the start and keeps the same video id once it
// becomes a VOD. Given a match's start time and when that day's stream began
// (webcast_sync), the match is simply at `matchStart - streamStart` seconds —
// seekable live (12h DVR window) and on the VOD afterwards.
//
// YouTube only: Twitch live embeds can't seek backwards and the VOD is a
// different id, so a Twitch-only event resolves to null (no fallback, as today).

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  pickWebcast,
  localDateStr,
  useEventInfo,
  useWebcastSync,
  useAutoWebcastCalibration,
  saveWebcastSync,
  type MatchRow,
  type WebcastSyncMap,
} from '@/dash/useEventData';
import type { MatchVideoStreamProps } from '@/dash/MatchVideo';

/** Start the embed this many seconds before t=0 so the countdown is visible. */
export const MATCH_STREAM_LEAD_SECONDS = 5;

export interface MatchStreamTarget {
  /** YouTube video id of the stream covering this match's day. */
  videoId: string;
  /** Epoch ms of match start (actual_time, else predicted/scheduled). */
  matchStartMs: number;
  /** True when we only have a predicted/scheduled start, not the FMS actual. */
  approximate: boolean;
  /** Epoch ms the stream began, or null when nobody has calibrated it yet. */
  streamStartMs: number | null;
  /** Stream position (seconds) of match t=0; null until calibrated. */
  t0Seconds: number | null;
}

function parseMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Best-known match start: FMS actual, else TBA predicted, else the schedule. */
export function matchStartMs(
  match: Pick<MatchRow, 'actual_time' | 'predicted_time' | 'scheduled_time'>,
): { ms: number; approximate: boolean } | null {
  const actual = parseMs(match.actual_time);
  if (actual != null) return { ms: actual, approximate: false };
  const est = parseMs(match.predicted_time) ?? parseMs(match.scheduled_time);
  return est != null ? { ms: est, approximate: true } : null;
}

export function resolveMatchStream(
  match: Pick<MatchRow, 'actual_time' | 'predicted_time' | 'scheduled_time'> | null | undefined,
  webcasts: unknown[] | undefined,
  syncMap: WebcastSyncMap | undefined,
): MatchStreamTarget | null {
  if (!match || !webcasts || webcasts.length === 0) return null;
  const start = matchStartMs(match);
  if (!start) return null;
  const webcast = pickWebcast({ webcasts }, localDateStr(new Date(start.ms)));
  if (!webcast || webcast.type !== 'youtube') return null;
  const videoId = webcast.file || webcast.channel || '';
  if (!videoId) return null;
  const streamStartMs = parseMs(syncMap?.[videoId]?.stream_start_at);
  const t0Seconds = streamStartMs != null ? (start.ms - streamStartMs) / 1000 : null;
  // A negative position means the match predates the stream we picked (wrong
  // day's stream or a bad calibration) — treat as uncalibrated rather than
  // seeking to 0 and pretending.
  return {
    videoId,
    matchStartMs: start.ms,
    approximate: start.approximate,
    streamStartMs,
    t0Seconds: t0Seconds != null && t0Seconds >= 0 ? t0Seconds : null,
  };
}

// ---------------------------------------------------------------------------
// Shared hook for any card that embeds <MatchVideo> for a match row: resolves
// the stream target, keeps it auto-calibrated, tracks whether the fallback is
// what's showing, and turns a manual "Sync to match start" into a day-wide
// calibration. Used by the Match tab and the Team tab's last-match card so the
// two behave identically.
// ---------------------------------------------------------------------------

export interface MatchStreamState {
  target: MatchStreamTarget | null;
  /** Props for <MatchVideo stream=…>; null when there's no stream to offer. */
  streamProps: MatchVideoStreamProps | null;
  /** For <MatchVideo onStreamActive=…>. */
  onStreamActive: (active: boolean) => void;
  /**
   * Call from the card's "Sync to match start" with the current video
   * position: persists a manual calibration when the stream fallback is
   * showing and the match has an FMS actual start (a predicted start would
   * calibrate every other match wrong).
   */
  syncNow: (videoSeconds: number) => void;
}

export function useMatchStream(
  eventKey: string | null,
  match: MatchRow | null | undefined,
  onSeekedToMatch: (t0Seconds: number) => void,
): MatchStreamState {
  const eventInfoQ = useEventInfo(eventKey);
  const webcastSyncQ = useWebcastSync(eventKey);
  const target = useMemo(
    () => resolveMatchStream(match, eventInfoQ.data?.webcasts, webcastSyncQ.data),
    [match, eventInfoQ.data?.webcasts, webcastSyncQ.data],
  );
  // Zero-touch calibration: ask YouTube when this match's stream began.
  useAutoWebcastCalibration(eventKey, target?.videoId ?? null);

  const [active, setActive] = useState(false);
  const seekedRef = useRef(onSeekedToMatch);
  seekedRef.current = onSeekedToMatch;

  const streamProps = useMemo<MatchVideoStreamProps | null>(() => {
    if (!target || !eventKey) return null;
    return {
      target,
      // The stream position of t=0 is exactly the alignment offset the
      // timelines need, so seeking auto-syncs them.
      onSeekedToMatch: (t0) => seekedRef.current(t0),
      onLiveStreamStart: (epochMs) => void saveWebcastSync(eventKey, target.videoId, epochMs, 'auto'),
    };
  }, [target, eventKey]);

  const syncNow = useCallback(
    (videoSeconds: number) => {
      if (!active || !target || target.approximate || !eventKey) return;
      void saveWebcastSync(
        eventKey,
        target.videoId,
        target.matchStartMs - videoSeconds * 1000,
        'manual',
      );
    },
    [active, target, eventKey],
  );

  return { target, streamProps, onStreamActive: setActive, syncNow };
}
