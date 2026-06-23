// src/sync/SyncStatusScreen.tsx
//
// Lead-facing server-coverage view. Queries the active event's assignment grid
// (expected coverage) and the reports that have actually landed on the server,
// then groups by match to show received/expected, flag missing assigned
// reports, and surface the latest server_received_at.
//
// The data fetch is isolated in `fetchCoverage` (which only touches the
// supabase client) so tests can drive it by mocking `@/lib/supabase`.
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/auth/useSession';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface CoverageAssignment {
  match_key: string;
  target_team_number: number;
  scout_id: string;
}

export interface CoverageReport {
  match_key: string;
  target_team_number: number;
  scout_id: string;
  server_received_at: string;
}

export interface CoverageData {
  eventKey: string | null;
  assignments: CoverageAssignment[];
  reports: CoverageReport[];
}

// Thin, mockable data layer: resolve the lead's active event, then fetch the
// RLS-scoped assignment grid + arrived reports for it.
export async function fetchCoverage(eventKey: string | null): Promise<CoverageData> {
  if (!eventKey) return { eventKey: null, assignments: [], reports: [] };

  const [assignRes, reportRes] = await Promise.all([
    supabase
      .from('assignment')
      .select('match_key,target_team_number,scout_id')
      .eq('event_key', eventKey),
    supabase
      .from('match_scouting_report')
      .select('match_key,target_team_number,scout_id,server_received_at')
      .eq('event_key', eventKey),
  ]);

  return {
    eventKey,
    assignments: (assignRes.data as CoverageAssignment[] | null) ?? [],
    reports: (reportRes.data as CoverageReport[] | null) ?? [],
  };
}

interface MatchCoverage {
  matchKey: string;
  expected: number;
  received: number;
  missing: { targetTeamNumber: number; scoutId: string }[];
  latestReceivedAt: string | null;
}

function reportKey(r: { target_team_number: number; scout_id: string }): string {
  return `${r.target_team_number}:${r.scout_id}`;
}

// Group by match_key and match each assigned (target_team_number, scout_id) to
// an arrived report. Reports without a matching assignment still count toward
// "received" and toward the latest-received timestamp.
export function computeCoverage(data: CoverageData): MatchCoverage[] {
  const byMatch = new Map<string, MatchCoverage>();

  const ensure = (matchKey: string): MatchCoverage => {
    let m = byMatch.get(matchKey);
    if (!m) {
      m = { matchKey, expected: 0, received: 0, missing: [], latestReceivedAt: null };
      byMatch.set(matchKey, m);
    }
    return m;
  };

  // Index arrived reports per match for fast membership + recency.
  const arrived = new Map<string, Set<string>>();
  for (const r of data.reports) {
    const m = ensure(r.match_key);
    if (!arrived.has(r.match_key)) arrived.set(r.match_key, new Set());
    arrived.get(r.match_key)!.add(reportKey(r));
    if (!m.latestReceivedAt || r.server_received_at > m.latestReceivedAt) {
      m.latestReceivedAt = r.server_received_at;
    }
  }

  for (const a of data.assignments) {
    const m = ensure(a.match_key);
    m.expected += 1;
    const here = arrived.get(a.match_key);
    if (here && here.has(reportKey(a))) {
      m.received += 1;
    } else {
      m.missing.push({ targetTeamNumber: a.target_team_number, scoutId: a.scout_id });
    }
  }

  return [...byMatch.values()].sort((x, y) => x.matchKey.localeCompare(y.matchKey));
}

export default function SyncStatusScreen(): JSX.Element {
  const { scout } = useSession();
  const eventKey = (scout as { event_key?: string } | null)?.event_key ?? null;
  const [data, setData] = useState<CoverageData | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const next = await fetchCoverage(eventKey);
      if (active) setData(next);
    })();
    return () => {
      active = false;
    };
  }, [eventKey]);

  const rows = data ? computeCoverage(data) : [];
  const noActiveEvent = data !== null && !data.eventKey;

  return (
    <main data-testid="sync-status" className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <h1 className="text-2xl font-bold">Sync status</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Server coverage</CardTitle>
        </CardHeader>
        <CardContent>
          {noActiveEvent ? (
            <p className="text-sm text-muted-foreground">No active event.</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No assignments or reports yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((m) => {
                const complete = m.expected > 0 && m.received >= m.expected;
                return (
                  <li
                    key={m.matchKey}
                    data-testid={`sync-match-${m.matchKey}`}
                    className="flex flex-col gap-1 rounded-lg border p-3 text-sm"
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-16 shrink-0 font-mono font-semibold">{m.matchKey}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono ${
                          complete ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'
                        }`}
                      >
                        {m.received}/{m.expected}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {m.latestReceivedAt
                          ? new Date(m.latestReceivedAt).toLocaleString()
                          : 'none received'}
                      </span>
                    </div>
                    {m.missing.length > 0 ? (
                      <div className="text-xs text-destructive">
                        Missing:{' '}
                        {m.missing
                          .map((x) => `#${x.targetTeamNumber}`)
                          .join(', ')}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
