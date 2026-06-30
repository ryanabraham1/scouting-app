// Pure helpers that turn one scouting report's persisted bursts + intervals into
// a single absolute-time match timeline (auto, then teleop) so the dashboard can
// draw color-coded activity bars showing what a robot was doing, and when.
//
// Time model: auto occupies [0, AUTO_MS); teleop occupies [AUTO_MS, MATCH_MS).
// Bursts carry a `window` ('auto' or a teleop window); intervals carry a `phase`.
import { AUTO_MS, TELEOP_MS } from '@/capture/clock';
import type { BurstRow, IntervalRow, MsrRow } from '@/dash/types';

export const MATCH_MS = AUTO_MS + TELEOP_MS; // 160_000
export { AUTO_MS, TELEOP_MS };

export type TimelineKind = 'shoot' | 'feed' | 'defense' | 'defended';

export interface TimelineSegment {
  kind: TimelineKind;
  /** Absolute match milliseconds (0 = match start). */
  startMs: number;
  endMs: number;
  /** Balls/sec for shoot/feed segments; undefined for defense/defended. */
  rate?: number;
}

/** A burst's window is 'auto' only during autonomous; everything else is teleop. */
export function burstAbsStart(b: BurstRow): number {
  return b.window === 'auto' ? b.startMs : AUTO_MS + b.startMs;
}
export function intervalAbsStart(i: IntervalRow): number {
  return i.phase === 'auto' ? i.startMs : AUTO_MS + i.startMs;
}

function clampToMatch(start: number, dur: number): { startMs: number; endMs: number } {
  const s = Math.max(0, Math.min(MATCH_MS, start));
  const e = Math.max(s, Math.min(MATCH_MS, start + Math.max(0, dur)));
  return { startMs: s, endMs: e };
}

function burstsToSegments(bursts: BurstRow[] | null | undefined, kind: TimelineKind): TimelineSegment[] {
  if (!Array.isArray(bursts)) return [];
  return bursts.map((b) => {
    const { startMs, endMs } = clampToMatch(burstAbsStart(b), b.endMs - b.startMs);
    return { kind, startMs, endMs, rate: b.rate };
  });
}

function intervalsToSegments(
  intervals: IntervalRow[] | null | undefined,
  kind: TimelineKind,
): TimelineSegment[] {
  if (!Array.isArray(intervals)) return [];
  return intervals.map((i) => {
    const { startMs, endMs } = clampToMatch(intervalAbsStart(i), i.endMs - i.startMs);
    return { kind, startMs, endMs };
  });
}

/**
 * Build the full set of timeline segments for a report, sorted by start time.
 * Returns [] when the report has no timestamped data (legacy / pre-migration).
 */
export function buildTimeline(report: MsrRow): TimelineSegment[] {
  const segments = [
    ...burstsToSegments(report.fuel_bursts, 'shoot'),
    ...burstsToSegments(report.feeding_bursts, 'feed'),
    ...intervalsToSegments(report.defense_intervals, 'defense'),
    ...intervalsToSegments(report.defended_intervals, 'defended'),
  ].filter((s) => s.endMs > s.startMs);
  segments.sort((a, b) => a.startMs - b.startMs);
  return segments;
}

/** True when there's any timestamped activity to draw a timeline from. */
export function hasTimeline(report: MsrRow): boolean {
  return buildTimeline(report).length > 0;
}

/** Convert an absolute match ms to a 0..1 fraction of the whole match. */
export function fractionOfMatch(ms: number): number {
  return Math.max(0, Math.min(1, ms / MATCH_MS));
}

/** Human label for a segment kind (UI legend / tooltip). */
export const KIND_LABEL: Record<TimelineKind, string> = {
  shoot: 'Shooting',
  feed: 'Feeding',
  defense: 'Playing defense',
  defended: 'Being defended',
};
