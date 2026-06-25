// src/dash/TeamTimeline.tsx
// NOTE: named TeamTimeline (not MatchTimeline) to avoid a case-only filename
// collision with the foundation util src/dash/matchTimeline.ts on
// case-insensitive filesystems (macOS) — that collision resolves the import to
// the util (no default export) and silently breaks the component.
//
// Per-report activity timeline: an absolute-time bar showing what one robot was
// doing across the whole match. Shoot/feed segments live on the top row;
// defense/defended (which can overlap fuel work and each other) stack on a
// sub-row beneath so a lead can read all four activities at once. Auto/teleop
// divider + second-tick axis give it real time context. Legacy reports (no
// timestamped data) get a graceful note, with a coarse fuel_by_shift mini-bar
// fallback when shift totals are present.

import { useMemo } from 'react';
import {
  buildTimeline,
  fractionOfMatch,
  KIND_LABEL,
  AUTO_MS,
  MATCH_MS,
  type TimelineKind,
  type TimelineSegment,
} from '@/dash/matchTimeline';
import type { MsrRow } from '@/dash/types';
import { cn } from '@/lib/utils';

export interface TeamTimelineProps {
  report: MsrRow;
  className?: string;
  /**
   * Live match position (absolute match ms) driven by the synced video. When a
   * finite, non-negative value is given we draw a vertical playhead and
   * highlight the segment(s) active at that instant. Undefined/null = no
   * playhead (graceful degradation when there's no video / time).
   */
  currentTimeMs?: number | null;
}

// Tailwind background + legend swatch per kind (Field-Control Console tokens).
const KIND_BG: Record<TimelineKind, string> = {
  shoot: 'bg-energy',
  feed: 'bg-brand',
  defense: 'bg-violet-500',
  defended: 'bg-warning',
};

// Order kinds are listed in the legend.
const KIND_ORDER: TimelineKind[] = ['shoot', 'feed', 'defense', 'defended'];

// Which row a kind lives on: fuel work on top, defense activity stacked below.
function rowForKind(kind: TimelineKind): 'top' | 'bottom' {
  return kind === 'shoot' || kind === 'feed' ? 'top' : 'bottom';
}

function pct(n: number): string {
  return `${(n * 100).toFixed(3)}%`;
}

function secs(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

function segLabel(seg: TimelineSegment): string {
  const range = `${secs(seg.startMs)}–${secs(seg.endMs)}`;
  const rate = seg.rate != null ? ` · ${seg.rate.toFixed(1)}/s` : '';
  return `${KIND_LABEL[seg.kind]} ${range}${rate}`;
}

function Legend(): JSX.Element {
  return (
    <ul
      data-testid="timeline-legend"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"
    >
      {KIND_ORDER.map((kind) => (
        <li key={kind} className="inline-flex items-center gap-1.5">
          <span className={cn('inline-block size-3 rounded-sm', KIND_BG[kind])} aria-hidden />
          <span>{KIND_LABEL[kind]}</span>
        </li>
      ))}
    </ul>
  );
}

// Coarse fallback for legacy reports: render fuel_by_shift as a tiny bar chart so
// a lead still gets a sense of when the robot scored, even without timestamps.
function ShiftFallback({ shifts }: { shifts: number[] }): JSX.Element {
  const max = Math.max(1, ...shifts);
  return (
    <div
      data-testid="timeline-shift-fallback"
      className="mt-2 flex items-end gap-1"
      style={{ height: 48 }}
    >
      {shifts.map((v, i) => (
        <div
          key={i}
          data-testid={`timeline-shift-bar-${i}`}
          title={`Shift ${i + 1}: ${v} fuel`}
          className="flex-1 rounded-t bg-energy/70"
          style={{ height: pct(v / max) }}
        />
      ))}
    </div>
  );
}

export default function TeamTimeline({
  report,
  className,
  currentTimeMs,
}: TeamTimelineProps): JSX.Element {
  const segments = useMemo(() => buildTimeline(report), [report]);

  // Only show a playhead for a finite, in-bounds time (clamped to the match).
  const hasPlayhead = typeof currentTimeMs === 'number' && Number.isFinite(currentTimeMs);
  const headMs = hasPlayhead ? Math.max(0, currentTimeMs as number) : 0;
  const isActive = (seg: TimelineSegment): boolean =>
    hasPlayhead && headMs >= seg.startMs && headMs < seg.endMs;

  // Second-tick axis: 0s … 160s at a handful of marks.
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let ms = 0; ms <= MATCH_MS; ms += 40_000) out.push(ms);
    return out;
  }, []);

  if (segments.length === 0) {
    const shifts = Array.isArray(report.fuel_by_shift) ? report.fuel_by_shift : [];
    const hasShift = shifts.some((v) => Number.isFinite(v) && v > 0);
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <div data-testid="timeline-empty" className="text-sm text-muted-foreground">
          No timeline recorded for this report.
        </div>
        {hasShift ? <ShiftFallback shifts={shifts} /> : null}
      </div>
    );
  }

  // Per-kind running index so test-ids are stable (timeline-seg-<kind>-<i>).
  const indexByKind: Partial<Record<TimelineKind, number>> = {};

  const renderSeg = (seg: TimelineSegment, row: 'top' | 'bottom') => {
    if (rowForKind(seg.kind) !== row) return null;
    const i = (indexByKind[seg.kind] = (indexByKind[seg.kind] ?? -1) + 1);
    const left = fractionOfMatch(seg.startMs);
    const width = (seg.endMs - seg.startMs) / MATCH_MS;
    const active = isActive(seg);
    return (
      <div
        key={`${seg.kind}-${i}`}
        data-testid={`timeline-seg-${seg.kind}-${i}`}
        data-active={active ? 'true' : undefined}
        title={segLabel(seg)}
        className={cn(
          'absolute top-0 h-full rounded-sm opacity-90',
          KIND_BG[seg.kind],
          // Defense/defended overlap each other → translucent so both read.
          row === 'bottom' ? 'opacity-70' : null,
          // Segment under the playhead pops: full opacity + a ring.
          active ? 'opacity-100 ring-2 ring-foreground ring-offset-0' : null,
        )}
        style={{ left: pct(left), width: pct(width), minWidth: 2 }}
      />
    );
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div data-testid="timeline-track" className="relative w-full select-none">
        {/* Synced video playhead, spanning the two activity rows. */}
        {hasPlayhead ? (
          <div
            data-testid="timeline-playhead"
            className="pointer-events-none absolute top-0 z-20 w-0.5 -translate-x-1/2 rounded-full bg-brand shadow-[0_0_6px_rgba(56,189,248,0.7)]"
            // Cover the top row (h-6) + gap + bottom row (h-4) ≈ 2.625rem.
            style={{ left: pct(fractionOfMatch(headMs)), height: '2.625rem' }}
            title={`Now ${secs(headMs)}`}
            aria-hidden
          />
        ) : null}
        {/* Top row: fuel work (shoot / feed). */}
        <div className="relative h-6 w-full overflow-hidden rounded-md bg-muted/40">
          {segments.map((s) => renderSeg(s, 'top'))}
          {/* Auto / teleop divider over the whole stack. */}
          <div
            data-testid="timeline-auto-divider"
            className="pointer-events-none absolute top-0 z-10 h-full w-px bg-foreground/50"
            style={{ left: pct(fractionOfMatch(AUTO_MS)) }}
            title="Auto / teleop"
          />
        </div>
        {/* Bottom row: defense activity (defense / defended), stacked. */}
        <div className="relative mt-0.5 h-4 w-full overflow-hidden rounded-md bg-muted/30">
          {segments.map((s) => renderSeg(s, 'bottom'))}
          <div
            className="pointer-events-none absolute top-0 h-full w-px bg-foreground/50"
            style={{ left: pct(fractionOfMatch(AUTO_MS)) }}
            aria-hidden
          />
        </div>
        {/* Second-tick axis. Inset the end ticks so the 0s / final labels don't
            clip off the track edges on a narrow (390px) phone: align the first
            tick to its left edge and the last to its right edge. */}
        <div className="relative mt-1 h-4 w-full text-sm tabular-nums text-muted-foreground">
          {ticks.map((ms, i) => {
            const isFirst = i === 0;
            const isLast = i === ticks.length - 1;
            return (
              <span
                key={ms}
                className={cn(
                  'absolute top-0',
                  isFirst ? 'translate-x-0' : isLast ? '-translate-x-full' : '-translate-x-1/2',
                )}
                style={{ left: pct(fractionOfMatch(ms)) }}
              >
                {secs(ms)}
              </span>
            );
          })}
        </div>
      </div>
      <Legend />
    </div>
  );
}
