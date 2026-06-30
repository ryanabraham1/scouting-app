// src/dash/useMatchScoutCoverage.ts
// Scout-heartbeat data hook (dashboard-heartbeat feature). Synthesizes per-match
// + event-wide scout coverage from the ALREADY-CACHED `useEventReports` and
// `useEventScouts` queries — no new query keys, no extra network round-trip. The
// underlying queries are persisted to IndexedDB (PersistQueryClientProvider), so
// this is offline-safe: it computes from whatever last synced and yields a
// zeroed default (never throws) when the cache is cold/empty.

import { useMemo } from 'react';
import { useEventReports, useEventScouts, type ScoutRow } from '@/dash/useEventData';
import { eventScoutCoverage, matchScoutCoverage, COVERAGE_STATION_CAP } from '@/dash/aggregate';
import type { MatchScoutCoverage, ScoutLite } from '@/dash/types';

export interface EventScoutCoverage {
  /** freshest server_received_at across ALL live reports for the event, or null */
  lastReportAt: string | null;
  /** per-match coverage, keyed by match_key (only matches with >=1 report) */
  coverageByMatch: Map<string, MatchScoutCoverage>;
  /** roster size (the X/Y denominator) */
  scoutsTotal: number;
  /** the underlying scouts query is still loading (denominator not yet known) */
  scoutsLoading: boolean;
}

/** A zeroed per-match default for a match with no reports / cold cache. */
export function emptyMatchCoverage(
  matchKey: string,
  scouts: ScoutLite[] = [],
): MatchScoutCoverage {
  return {
    matchKey,
    scoutsCovered: 0,
    scoutsTotal: scouts.length,
    lastReportAt: null,
    reportedScoutIds: [],
    missingScouts: scouts.map((s) => ({ id: s.id, display_name: s.display_name })),
    unattributed: 0,
    stationsCovered: 0,
  };
}

function toLite(scouts: ScoutRow[]): ScoutLite[] {
  return scouts.map((s) => ({ id: s.id, display_name: s.display_name }));
}

/**
 * Event-wide scout coverage for the heartbeat. Reuses the cached reports/scouts
 * queries; memoized so it only recomputes when the underlying data identity
 * changes (realtime / poll invalidation flips the reference).
 */
export function useEventScoutCoverage(eventKey: string | null): EventScoutCoverage {
  const reportsQ = useEventReports(eventKey);
  const scoutsQ = useEventScouts(eventKey);
  const reports = reportsQ.data;
  const scouts = scoutsQ.data;
  return useMemo(() => {
    const lite = scouts ? toLite(scouts) : [];
    const { coverageByMatch, lastReportAt, scoutsTotal } = eventScoutCoverage(
      reports ?? [],
      lite,
    );
    return { coverageByMatch, lastReportAt, scoutsTotal, scoutsLoading: scoutsQ.isLoading };
  }, [reports, scouts, scoutsQ.isLoading]);
}

/**
 * One match's coverage, selected from the event-wide map (or a zeroed default
 * when the match has no reports yet). Convenience wrapper for callers that only
 * care about a single anchored match; recomputes the per-match slice directly
 * from the cached reports/scouts so it stays correct even for a match absent
 * from `coverageByMatch`.
 */
export function useMatchScoutCoverage(
  eventKey: string | null,
  matchKey: string | null,
): MatchScoutCoverage {
  const reportsQ = useEventReports(eventKey);
  const scoutsQ = useEventScouts(eventKey);
  const reports = reportsQ.data;
  const scouts = scoutsQ.data;
  return useMemo(() => {
    const lite = scouts ? toLite(scouts) : [];
    if (!matchKey) return emptyMatchCoverage('', lite);
    return matchScoutCoverage(reports ?? [], lite, matchKey, COVERAGE_STATION_CAP);
  }, [reports, scouts, matchKey]);
}
