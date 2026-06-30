// src/dash/ScoutHeartbeat.tsx
// Presentational scout-heartbeat tile for the NextMatchView right column. Pure /
// prop-driven (no hooks) — the parent supplies coverage, the global last-report
// stamp, online/pending from useSync(), and a ticking `nowMs` clock. Answers
// "how many scouts synced for this match + when did the last report land", and
// is offline-aware (shows pending + an offline note). Degrades to an empty-roster
// "—" state when scoutsTotal === 0 so a cold-start frame never reads as "3/0".

import { cn } from '@/lib/utils';
import { relativeTime } from '@/dash/relativeTime';
import type { MatchScoutCoverage } from '@/dash/types';
import { COVERAGE_STATION_CAP } from '@/dash/aggregate';

export interface ScoutHeartbeatProps {
  coverage: MatchScoutCoverage;
  /** event-wide freshest report stamp (fallback when this match has none) */
  lastReportAt: string | null;
  online: boolean;
  pending: number;
  nowMs: number;
  /** label of the anchored match, e.g. "Q12" (for the sublabel) */
  heroLabel?: string;
}

type Tone = 'red' | 'amber' | 'green';

function toneFor(scoutsCovered: number, expected: number): Tone {
  if (scoutsCovered === 0) return 'red';
  if (scoutsCovered >= expected) return 'green';
  return 'amber';
}

const TONE_TEXT: Record<Tone, string> = {
  red: 'text-destructive',
  amber: 'text-warning',
  green: 'text-success',
};

export default function ScoutHeartbeat({
  coverage,
  lastReportAt,
  online,
  pending,
  nowMs,
  heroLabel,
}: ScoutHeartbeatProps): JSX.Element {
  const { scoutsCovered, scoutsTotal } = coverage;
  const emptyRoster = scoutsTotal === 0;
  // expected = min(cap, roster size || cap) — fall back the cap when roster empty.
  const expected = Math.min(COVERAGE_STATION_CAP, scoutsTotal || COVERAGE_STATION_CAP);
  const tone = toneFor(scoutsCovered, expected);

  // Per-match stamp when this match has reports, else the global event stamp so a
  // brand-new upcoming match isn't just "no reports yet".
  const onThisMatch = coverage.lastReportAt != null;
  const stampIso = onThisMatch ? coverage.lastReportAt : lastReportAt;
  const stampLabel = onThisMatch ? 'last report on this match' : 'last report anywhere';

  return (
    <div
      data-testid="scout-heartbeat"
      className="rounded-xl border border-border bg-black/40 px-4 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Scout Heartbeat
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              'inline-block h-2.5 w-2.5 rounded-full',
              online ? 'bg-success' : 'bg-warning',
            )}
          />
          {online ? 'online' : 'offline'}
        </span>
      </div>

      <div className="mt-1 flex items-end justify-between gap-3">
        <div className="flex flex-col">
          <span
            data-testid="scout-heartbeat-count"
            className={cn('text-3xl font-black leading-none tabular-nums', TONE_TEXT[tone])}
            title={`${coverage.stationsCovered}/${COVERAGE_STATION_CAP} stations reported`}
          >
            {scoutsCovered}/{emptyRoster ? '—' : scoutsTotal}
          </span>
          <span className="mt-0.5 text-xs text-muted-foreground">
            scouts synced{heroLabel ? ` for ${heroLabel}` : ''}
          </span>
        </div>
        <div className="flex flex-col items-end text-right">
          <span
            data-testid="scout-heartbeat-last"
            className="text-sm font-semibold tabular-nums text-foreground"
          >
            {relativeTime(stampIso, nowMs)}
          </span>
          <span className="mt-0.5 text-[11px] text-muted-foreground">{stampLabel}</span>
        </div>
      </div>

      {pending > 0 || !online ? (
        <div className="mt-2 text-[11px] text-muted-foreground">
          {pending > 0 ? <span>· {pending} pending sync</span> : null}
          {!online ? (
            <span className="ml-1">offline — showing last synced</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
