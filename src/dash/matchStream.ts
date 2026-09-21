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

import { pickWebcast, localDateStr, type MatchRow, type WebcastSyncMap } from '@/dash/useEventData';

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
