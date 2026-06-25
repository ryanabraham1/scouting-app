// src/dash/ScouterView.tsx
// SCOUTERVIEW — staff-facing scouter drill-down. Pick a scouter from the event
// roster, then render their profile: report count, matches/teams covered, avg
// fuel points, reliability flags, and a per-report list. Tap a report row to
// open the FULL per-report detail in a Sheet. Field-Control Console styling.

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  UserCheck,
  ClipboardList,
  Users,
  Flame,
  AlertTriangle,
  Mountain,
  ChevronRight,
  Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatTile } from '@/components/ui/StatTile';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/utils';
import { formatMatchKeyRaw } from '@/lib/formatMatch';
import { useEventScouts, useEventReports } from '@/dash/useEventData';
import { deleteScout } from '@/dash/scoutAdminClient';
import ReportDetail from '@/dash/ReportDetail';
import type { MsrRow } from '@/dash/types';

export interface ScouterViewProps {
  eventKey: string;
}

const CONTROL_MIN_HEIGHT = 56; // px — touch target floor

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function ScouterProfile(props: {
  reports: MsrRow[];
  onOpenReport: (r: MsrRow) => void;
}): JSX.Element {
  const { reports, onOpenReport } = props;
  const n = reports.length;

  const teams = new Set<number>();
  const matches = new Set<string>();
  let sumFuel = 0;
  let noShow = 0;
  let died = 0;
  let tipped = 0;
  for (const r of reports) {
    teams.add(r.target_team_number);
    matches.add(r.match_key);
    sumFuel += r.fuel_points;
    if (r.no_show) noShow += 1;
    if (r.died) died += 1;
    if (r.tipped) tipped += 1;
  }
  const avgFuel = n > 0 ? sumFuel / n : 0;

  const flags: string[] = [];
  if (noShow) flags.push(`no-show ×${noShow}`);
  if (died) flags.push(`died ×${died}`);
  if (tipped) flags.push(`tipped ×${tipped}`);

  return (
    <div data-testid="scouter-profile" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <span data-testid="scouter-report-count" className="contents">
          <StatTile label="Reports" value={n} icon={<ClipboardList />} tone="brand" />
        </span>
        <span data-testid="scouter-matches-covered" className="contents">
          <StatTile label="Matches" value={matches.size} icon={<UserCheck />} tone="success" />
        </span>
        <span data-testid="scouter-teams-covered" className="contents">
          <StatTile label="Teams" value={teams.size} icon={<Users />} tone="brand" />
        </span>
        <span data-testid="scouter-avg-fuel" className="contents">
          <StatTile label="Avg fuel pts" value={fmt(avgFuel)} icon={<Flame />} tone="energy" />
        </span>
      </div>

      <div
        data-testid="scouter-flags"
        className="flex items-center gap-2 rounded-xl border border-border bg-card/60 px-3 py-2 text-sm"
      >
        <AlertTriangle className="size-4 text-warning" />
        <span className="font-semibold uppercase tracking-wide text-muted-foreground">
          Reliability flags:
        </span>
        {flags.length ? (
          <span className="text-warning">{flags.join(' · ')}</span>
        ) : (
          <span className="text-success">none</span>
        )}
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="space-y-0">
          <CardTitle className="text-foreground">Reports ({n})</CardTitle>
        </CardHeader>
        <CardContent>
          {n === 0 ? (
            <div data-testid="scouter-empty" className="text-sm text-muted-foreground">
              This scouter has no reports at this event yet.
            </div>
          ) : (
            <ul data-testid="scouter-report-list" className="flex flex-col gap-2">
              {reports.map((m, i) => {
                const climb = m.climb_success ? `L${m.climb_level}` : 'no climb';
                return (
                  <li key={`${m.match_key}-${m.target_team_number}-${i}`}>
                    <button
                      type="button"
                      data-testid={`scouter-report-${i}`}
                      onClick={() => onOpenReport(m)}
                      style={{ minHeight: CONTROL_MIN_HEIGHT }}
                      className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-left text-sm text-foreground hover:bg-muted/60"
                    >
                      <span className="min-w-0 truncate font-semibold tabular-nums">
                        {formatMatchKeyRaw(m.match_key)} · Team {m.target_team_number}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Flame className="size-4 text-energy" /> {fmt(m.fuel_points)}
                        </span>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1',
                            m.climb_success && 'text-success',
                          )}
                        >
                          <Mountain className="size-4" /> {climb}
                        </span>
                        <ChevronRight className="size-4" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ScouterView(props: ScouterViewProps): JSX.Element {
  const { eventKey } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<MsrRow | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const scoutsQuery = useEventScouts(eventKey);
  const reportsQuery = useEventReports(eventKey);

  async function handleRemove(id: string): Promise<void> {
    setRemoveError(null);
    setDeletingId(id);
    try {
      await deleteScout(id);
      if (selected === id) setSelected(null);
      setConfirmingId(null);
      // Refresh the scouter list AND the reports (the deleted scouter's reports
      // are gone, which also re-aggregates rankings/team views elsewhere).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['scouts', eventKey] }),
        queryClient.invalidateQueries({ queryKey: ['reports', eventKey] }),
      ]);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Failed to remove scouter.');
    } finally {
      setDeletingId(null);
    }
  }

  const loading = scoutsQuery.isLoading || reportsQuery.isLoading;
  const scouts = scoutsQuery.data ?? [];
  const reports = reportsQuery.data ?? [];

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scouts) m.set(s.id, s.display_name ?? '(unnamed)');
    return m;
  }, [scouts]);
  const scoutName = (id: string | null | undefined): string =>
    id ? nameById.get(id) ?? '(unknown)' : 'unassigned';

  // Report count per scout_id (non-deleted; useEventReports already excludes deleted).
  const countByScout = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of reports) {
      if (r.scout_id == null) continue;
      m.set(r.scout_id, (m.get(r.scout_id) ?? 0) + 1);
    }
    return m;
  }, [reports]);

  const selectedReports = useMemo(
    () => (selected != null ? reports.filter((r) => r.scout_id === selected) : []),
    [reports, selected],
  );

  return (
    <div data-testid="dash-scouter" className="flex flex-col gap-4 text-foreground">
      {loading ? (
        <div data-testid="scouter-loading" className="text-sm text-muted-foreground">
          Loading event data…
        </div>
      ) : (
        <>
          <Card className="border-border bg-card">
            <CardHeader className="flex flex-row items-center gap-2 space-y-0">
              <UserCheck className="size-5 text-brand" />
              <CardTitle className="text-foreground">Scouters ({scouts.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {scouts.length === 0 ? (
                <div data-testid="scouter-none" className="text-sm text-muted-foreground">
                  No scouters registered for this event yet.
                </div>
              ) : (
                <ul data-testid="scouter-list" className="flex flex-col gap-2">
                  {scouts.map((s) => {
                    const count = countByScout.get(s.id) ?? 0;
                    const isSel = selected === s.id;
                    const isConfirming = confirmingId === s.id;
                    const isDeleting = deletingId === s.id;
                    return (
                      <li key={s.id} className="flex flex-col items-stretch gap-2 sm:flex-row">
                        <button
                          type="button"
                          data-testid={`scouter-item-${s.id}`}
                          onClick={() => setSelected(s.id)}
                          style={{ minHeight: CONTROL_MIN_HEIGHT }}
                          className={cn(
                            'flex flex-1 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-base',
                            isSel
                              ? 'border-foreground/40 bg-accent text-foreground'
                              : 'border-border bg-muted/30 text-foreground hover:bg-muted/60',
                          )}
                        >
                          <span className="min-w-0 truncate font-semibold">
                            {s.display_name ?? '(unnamed)'}
                          </span>
                          <span
                            className={cn(
                              'shrink-0 tabular-nums',
                              count > 0 ? 'text-brand' : 'text-warning',
                            )}
                          >
                            {count} report{count === 1 ? '' : 's'}
                          </span>
                        </button>
                        {isConfirming ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              data-testid={`scouter-remove-confirm-${s.id}`}
                              onClick={() => void handleRemove(s.id)}
                              disabled={isDeleting}
                              style={{ minHeight: CONTROL_MIN_HEIGHT }}
                              className="shrink-0 rounded-xl border border-destructive bg-destructive/15 px-3 text-sm font-semibold text-destructive hover:bg-destructive/25 disabled:opacity-50"
                            >
                              {isDeleting ? 'Removing…' : 'Delete'}
                            </button>
                            <button
                              type="button"
                              data-testid={`scouter-remove-cancel-${s.id}`}
                              onClick={() => setConfirmingId(null)}
                              disabled={isDeleting}
                              style={{ minHeight: CONTROL_MIN_HEIGHT }}
                              className="shrink-0 rounded-xl border border-border bg-muted/30 px-3 text-sm text-muted-foreground hover:bg-muted/60 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            data-testid={`scouter-remove-${s.id}`}
                            onClick={() => {
                              setRemoveError(null);
                              setConfirmingId(s.id);
                            }}
                            aria-label={`Remove scouter ${s.display_name ?? ''}`.trim()}
                            style={{ minHeight: CONTROL_MIN_HEIGHT }}
                            className="flex min-w-[3.5rem] shrink-0 items-center justify-center rounded-xl border border-border bg-muted/30 px-3 text-muted-foreground hover:border-destructive hover:bg-destructive/15 hover:text-destructive"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {removeError ? (
                <div
                  data-testid="scouter-remove-error"
                  className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {removeError}
                </div>
              ) : null}
              {scouts.length > 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Removing a scouter permanently deletes them and all of their submitted reports.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {selected != null ? (
            <ScouterProfile reports={selectedReports} onOpenReport={setOpenReport} />
          ) : (
            <div data-testid="scouter-prompt" className="text-sm text-muted-foreground">
              Pick a scouter to see their submitted reports.
            </div>
          )}
        </>
      )}

      <Sheet
        open={openReport != null}
        onClose={() => setOpenReport(null)}
        side="right"
        title={
          openReport
            ? `${formatMatchKeyRaw(openReport.match_key)} · Team ${openReport.target_team_number}`
            : ''
        }
        data-testid="scouter-report-sheet"
      >
        {openReport ? (
          <ReportDetail report={openReport} scoutName={scoutName(openReport.scout_id)} />
        ) : null}
      </Sheet>
    </div>
  );
}
