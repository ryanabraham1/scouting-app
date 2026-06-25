// src/dash/ScoutersTab.tsx — the single, unified Scouters panel.
//
// This used to be two stacked, redundant sections — a persistent "Roster"
// (team-scoped name list) and an event-scoped "Performance" drill-down — which
// drifted out of sync: adding a roster name didn't surface it in performance,
// and deleting in performance left the name on the roster (and in the picker).
//
// Now it's ONE list keyed by name, merging the persistent roster with the
// active event's `scout` rows. For each scouter you get their report count and
// a tap-through profile, plus three team-wide actions:
//   • Add    — add a name to the roster.
//   • Hide   — keep all reports but drop the name from the "Who are you?" picker
//              and from new assignment seeding (reversible).
//   • Delete — permanently remove the name and ALL their reports, everywhere.
// Roster management works with no active event; report counts/profiles appear
// once an event is set.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Trash2,
  Plus,
  Users,
  UserCheck,
  ClipboardList,
  Flame,
  AlertTriangle,
  Mountain,
  ChevronRight,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  listRoster,
  addScouter,
  setScouterHidden,
  deleteRosterScouter,
} from '@/roster/rosterClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatTile } from '@/components/ui/StatTile';
import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/lib/utils';
import { formatMatchKeyRaw } from '@/lib/formatMatch';
import { useEventScouts, useEventReports } from '@/dash/useEventData';
import ReportDetail from '@/dash/ReportDetail';
import type { MsrRow } from '@/dash/types';

export interface ScoutersTabProps {
  /** Active event key, or null when no event is set. */
  eventKey: string | null;
}

const CONTROL_MIN_HEIGHT = 56; // px — touch target floor

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/**
 * One merged scouter. A scouter may exist on the roster only (no reports yet),
 * as an event `scout` row only (e.g. a device that checked in but isn't on the
 * roster), or both. `key` is the case-insensitive name used to merge the two.
 */
interface UnifiedScouter {
  key: string; // lower(name) — merge key
  name: string; // display name
  onRoster: boolean;
  hidden: boolean;
  scoutIds: string[]; // event `scout` rows that map to this name
  reportCount: number;
}

/** Profile drill-down for a selected scouter's reports (event-scoped). */
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

export default function ScoutersTab(props: ScoutersTabProps): JSX.Element {
  const { eventKey } = props;
  const queryClient = useQueryClient();

  // Persistent roster (includes hidden so the panel can manage them).
  const [roster, setRoster] = useState<{ name: string; hidden: boolean }[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null); // name acting on, or '__add__'
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null); // merge key
  const [openReport, setOpenReport] = useState<MsrRow | null>(null);

  const refreshRoster = useCallback(async () => {
    try {
      const rows = await listRoster({ includeHidden: true });
      setRoster(rows.map((r) => ({ name: r.name, hidden: r.hidden })));
      setRosterError(null);
    } catch (err) {
      setRosterError(err instanceof Error ? err.message : 'Failed to load roster.');
    }
  }, []);

  useEffect(() => {
    void refreshRoster();
  }, [refreshRoster]);

  // Event-scoped data (only fetched when an event is active — the hooks no-op on null).
  const scoutsQuery = useEventScouts(eventKey);
  const reportsQuery = useEventReports(eventKey);
  const scouts = scoutsQuery.data ?? [];
  const reports = reportsQuery.data ?? [];
  const eventLoading = !!eventKey && (scoutsQuery.isLoading || reportsQuery.isLoading);

  // Report count per scout_id (useEventReports already excludes deleted).
  const countByScout = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of reports) {
      if (r.scout_id == null) continue;
      m.set(r.scout_id, (m.get(r.scout_id) ?? 0) + 1);
    }
    return m;
  }, [reports]);

  // Merge roster + event scouts into one list keyed by lower(name).
  const unified = useMemo<UnifiedScouter[]>(() => {
    const by = new Map<string, UnifiedScouter>();
    const ensure = (display: string): UnifiedScouter => {
      const key = display.trim().toLowerCase();
      let entry = by.get(key);
      if (!entry) {
        entry = { key, name: display, onRoster: false, hidden: false, scoutIds: [], reportCount: 0 };
        by.set(key, entry);
      }
      return entry;
    };
    for (const r of roster) {
      const e = ensure(r.name);
      e.onRoster = true;
      e.hidden = r.hidden;
      e.name = r.name; // prefer the roster's casing
    }
    for (const s of scouts) {
      const display = s.display_name ?? '(unnamed)';
      const e = ensure(display);
      e.scoutIds.push(s.id);
      e.reportCount += countByScout.get(s.id) ?? 0;
    }
    return Array.from(by.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [roster, scouts, countByScout]);

  const selectedEntry = unified.find((u) => u.key === selected) ?? null;
  const selectedReports = useMemo(() => {
    if (!selectedEntry) return [];
    const ids = new Set(selectedEntry.scoutIds);
    return reports.filter((r) => r.scout_id != null && ids.has(r.scout_id));
  }, [selectedEntry, reports]);

  // Scout name lookup for the report-detail sheet.
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scouts) m.set(s.id, s.display_name ?? '(unnamed)');
    return m;
  }, [scouts]);
  const scoutName = (id: string | null | undefined): string =>
    id ? nameById.get(id) ?? '(unknown)' : 'unassigned';

  async function onAdd(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    const trimmed = name.trim();
    if (busyKey || trimmed.length === 0) return;
    setBusyKey('__add__');
    setActionError(null);
    try {
      await addScouter(trimmed);
      setName('');
      await refreshRoster();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add scouter.');
    } finally {
      setBusyKey(null);
    }
  }

  async function invalidateEvent(): Promise<void> {
    if (!eventKey) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['scouts', eventKey] }),
      queryClient.invalidateQueries({ queryKey: ['reports', eventKey] }),
    ]);
  }

  async function onToggleHidden(u: UnifiedScouter): Promise<void> {
    if (busyKey) return;
    setBusyKey(u.key);
    setActionError(null);
    try {
      await setScouterHidden(u.name, !u.hidden);
      await refreshRoster();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update scouter.');
    } finally {
      setBusyKey(null);
    }
  }

  async function onDelete(u: UnifiedScouter): Promise<void> {
    if (busyKey) return;
    setBusyKey(u.key);
    setActionError(null);
    try {
      await deleteRosterScouter(u.name);
      if (selected === u.key) setSelected(null);
      setConfirmingKey(null);
      await refreshRoster();
      await invalidateEvent();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove scouter.');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div data-testid="dash-scouters" className="flex flex-col gap-4 text-foreground">
      <Card data-testid="roster-tab" className="border-border bg-card">
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <Users className="size-5 text-brand" />
          <CardTitle className="text-foreground">Scouters ({unified.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="flex flex-wrap items-center gap-3" onSubmit={(e) => void onAdd(e)}>
            <Input
              data-testid="roster-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Scouter name"
              autoComplete="off"
              className="h-14 flex-1 min-w-[12rem] text-lg"
            />
            <Button
              type="submit"
              size="big"
              data-testid="roster-add-btn"
              disabled={busyKey != null || name.trim().length === 0}
              className="w-full sm:w-auto"
            >
              <Plus /> Add
            </Button>
          </form>

          {rosterError ? (
            <p data-testid="roster-error" className="text-sm text-destructive">
              {rosterError}
            </p>
          ) : null}
          {actionError ? (
            <p data-testid="scouter-action-error" className="text-sm text-destructive">
              {actionError}
            </p>
          ) : null}

          {eventLoading ? (
            <div data-testid="scouter-loading" className="text-sm text-muted-foreground">
              Loading event data…
            </div>
          ) : (
            <ul data-testid="roster-list" className="flex flex-col gap-2">
              {unified.length === 0 ? (
                <li data-testid="scouters-empty" className="text-sm text-muted-foreground">
                  No scouters yet. Add the names your team picks from on each device.
                </li>
              ) : (
                unified.map((u) => {
                  const isSel = selected === u.key;
                  const isConfirming = confirmingKey === u.key;
                  const isBusy = busyKey === u.key;
                  const hasReports = u.scoutIds.length > 0;
                  return (
                    <li
                      key={u.key}
                      data-testid={`scouter-item-${u.name}`}
                      className={cn(
                        'flex flex-col gap-2 rounded-xl border p-2',
                        isSel ? 'border-foreground/40 bg-accent' : 'border-border bg-muted/30',
                        u.hidden && 'opacity-70',
                      )}
                    >
                      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                        <button
                          type="button"
                          data-testid={`scouter-open-${u.name}`}
                          onClick={() => setSelected(isSel ? null : u.key)}
                          disabled={!eventKey}
                          style={{ minHeight: CONTROL_MIN_HEIGHT }}
                          className="flex flex-1 items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-base hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 truncate font-semibold text-foreground">
                              {u.name}
                            </span>
                            {u.hidden ? (
                              <span
                                data-testid={`scouter-hidden-badge-${u.name}`}
                                className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground"
                              >
                                Hidden
                              </span>
                            ) : null}
                          </span>
                          {eventKey ? (
                            <span
                              className={cn(
                                'shrink-0 tabular-nums',
                                u.reportCount > 0 ? 'text-brand' : 'text-warning',
                              )}
                            >
                              {u.reportCount} report{u.reportCount === 1 ? '' : 's'}
                            </span>
                          ) : null}
                        </button>

                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            data-testid={`scouter-hide-${u.name}`}
                            onClick={() => void onToggleHidden(u)}
                            disabled={isBusy}
                            aria-label={`${u.hidden ? 'Unhide' : 'Hide'} ${u.name}`}
                            title={
                              u.hidden
                                ? 'Show in the scouter picker again'
                                : 'Keep reports but hide from the scouter picker'
                            }
                            style={{ minHeight: CONTROL_MIN_HEIGHT }}
                            className="flex min-w-[3rem] items-center justify-center rounded-xl border border-border bg-muted/30 px-3 text-muted-foreground hover:bg-muted/60 disabled:opacity-50"
                          >
                            {u.hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                          </button>

                          {isConfirming ? (
                            <>
                              <button
                                type="button"
                                data-testid={`scouter-remove-confirm-${u.name}`}
                                onClick={() => void onDelete(u)}
                                disabled={isBusy}
                                style={{ minHeight: CONTROL_MIN_HEIGHT }}
                                className="rounded-xl border border-destructive bg-destructive/15 px-3 text-sm font-semibold text-destructive hover:bg-destructive/25 disabled:opacity-50"
                              >
                                {isBusy ? 'Deleting…' : 'Delete'}
                              </button>
                              <button
                                type="button"
                                data-testid={`scouter-remove-cancel-${u.name}`}
                                onClick={() => setConfirmingKey(null)}
                                disabled={isBusy}
                                style={{ minHeight: CONTROL_MIN_HEIGHT }}
                                className="rounded-xl border border-border bg-muted/30 px-3 text-sm text-muted-foreground hover:bg-muted/60 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              data-testid={`scouter-remove-${u.name}`}
                              onClick={() => {
                                setActionError(null);
                                setConfirmingKey(u.key);
                              }}
                              aria-label={`Delete ${u.name}`}
                              style={{ minHeight: CONTROL_MIN_HEIGHT }}
                              className="flex min-w-[3rem] items-center justify-center rounded-xl border border-border bg-muted/30 px-3 text-muted-foreground hover:border-destructive hover:bg-destructive/15 hover:text-destructive"
                            >
                              <Trash2 className="size-4" />
                            </button>
                          )}
                        </div>
                      </div>

                      {isSel && eventKey ? (
                        hasReports || u.reportCount > 0 ? (
                          <ScouterProfile reports={selectedReports} onOpenReport={setOpenReport} />
                        ) : (
                          <p
                            data-testid="scouter-empty"
                            className="px-2 pb-1 text-sm text-muted-foreground"
                          >
                            This scouter has no reports at this event yet.
                          </p>
                        )
                      ) : null}
                    </li>
                  );
                })
              )}
            </ul>
          )}

          <p className="text-xs text-muted-foreground">
            <strong>Hide</strong> keeps a scouter's reports but removes them from the
            scouter picker and from new assignments. <strong>Delete</strong> permanently
            removes the scouter and every report they submitted, across all events.
          </p>

          {!eventKey ? (
            <p
              data-testid="scouters-no-event"
              className="rounded-xl border border-border bg-card/60 px-3 py-3 text-sm text-muted-foreground"
            >
              Set an active event in Setup to see each scouter's report counts and reliability.
            </p>
          ) : null}
        </CardContent>
      </Card>

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
