// src/sync/SyncStatusScreen.tsx
//
// Lead-facing server-coverage view. Queries the active event's assignment grid
// (expected coverage) and the reports that have actually landed on the server,
// then groups by match to show received/expected, flag missing assigned
// reports, and surface the latest server_received_at.
//
// The data fetch is isolated in `fetchCoverage` (which only touches the
// supabase client) so tests can drive it by mocking `@/lib/supabase`.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useActiveEvent } from '@/dash/useActiveEvent';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BackLink } from '@/components/ui/BackLink';
import { Button } from '@/components/ui/button';
import { getSyncQueue, listDeadLetters, requeueReport, deleteReport } from '@/db/localStore';
import {
  getMatchupSyncQueue,
  getStrategyCanvasSyncQueue,
} from '@/db/localStore';
import {
  getPitSyncQueue,
  listPitDeadLetters,
  requeuePitReport,
  deletePitReport,
} from '@/pit/pitStore';
import { formatMatchKeyRaw } from '@/lib/formatMatch';
import {
  discardLocalRecovery,
  listLocalRecoveryRecords,
  loadRecoveryVersions,
  resolveLocalRecovery,
  retryLocalRecovery,
  type LocalRecoveryRecord,
  type RecoveryResolution,
  type RecoveryVersions,
} from '@/sync/localRecovery';

interface LocalDeadLetter {
  id: string;
  label: string;
  error: string | null;
  kind: 'match' | 'pit';
}

/**
 * This device's local outbox: how many reports are queued and which ones have
 * DEAD-LETTERED (stuck), with their error and a Retry. The server-coverage card
 * below only shows what reached the server — without this, a stuck report was
 * invisible here even though the header badge counted it.
 */
/** True when a dead-letter can NEVER sync because its event no longer exists
 *  (the scout-row provisioning trips the event FK). Retry/Fix can't help — the
 *  only recovery is to discard it. */
function isDeletedEventError(error: string | null): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  // Require the EVENT-key FK specifically: a bare `includes('event')` also
  // matched match-key/team FK messages whose constraint names embed "event",
  // which mislabeled fixable dead-letters as "event no longer exists" (hiding
  // the Fix & re-save path that could actually recover them).
  return e.includes('scout_event_key_fkey') || (e.includes('event_key') && e.includes('foreign key'));
}

function LocalOutbox(): JSX.Element {
  const [queued, setQueued] = useState(0);
  const [dead, setDead] = useState<LocalDeadLetter[]>([]);
  const [collaborativeDead, setCollaborativeDead] = useState<LocalRecoveryRecord[]>([]);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [versions, setVersions] = useState<RecoveryVersions | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Key (`${kind}:${id}`) of the dead-letter whose discard is armed for confirm.
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [mq, pq, nq, cq, md, pd, collaborative] = await Promise.all([
      getSyncQueue(),
      getPitSyncQueue(),
      getMatchupSyncQueue(),
      getStrategyCanvasSyncQueue(),
      listDeadLetters(),
      listPitDeadLetters(),
      listLocalRecoveryRecords(),
    ]);
    setQueued(mq.length + pq.length + nq.length + cq.length);
    setDead([
      ...md.map((r) => ({
        id: r.id,
        label: `${formatMatchKeyRaw(r.matchKey)} · Team ${r.targetTeamNumber}`,
        error: r.lastSyncError ?? null,
        kind: 'match' as const,
      })),
      ...pd.map((r) => ({
        id: r.draftKey,
        label: `Pit · Team ${r.teamNumber}`,
        error: r.lastSyncError ?? null,
        kind: 'pit' as const,
      })),
    ]);
    setCollaborativeDead(collaborative);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const retryAll = useCallback(async () => {
    setRetrying(true);
    try {
      for (const d of dead) {
        if (d.kind === 'match') await requeueReport(d.id);
        else await requeuePitReport(d.id);
      }
      for (const record of collaborativeDead) await retryLocalRecovery(record);
      // Nudge the sync engine (useSync listens for this) to drain immediately.
      window.dispatchEvent(new Event('scout-sync-changed'));
      await refresh();
    } finally {
      setRetrying(false);
    }
  }, [collaborativeDead, dead, refresh]);

  const inspectRecovery = useCallback(async (record: LocalRecoveryRecord) => {
    const key = `${record.kind}:${record.key}`;
    if (inspecting === key) {
      setInspecting(null);
      setVersions(null);
      setRecoveryError(null);
      return;
    }
    setInspecting(key);
    setVersions(null);
    setRecoveryError(null);
    try {
      setVersions(await loadRecoveryVersions(record));
    } catch (error) {
      setRecoveryError(
        error instanceof Error
          ? `Local copy is safe, but the server version could not be loaded: ${error.message}`
          : 'Local copy is safe, but the server version could not be loaded.',
      );
    }
  }, [inspecting]);

  const resolveRecovery = useCallback(async (
    record: LocalRecoveryRecord,
    resolution: RecoveryResolution,
  ) => {
    if (!versions) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    try {
      await resolveLocalRecovery(record, versions, resolution);
      setInspecting(null);
      setVersions(null);
      await refresh();
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : 'Recovery failed.');
    } finally {
      setRecoveryBusy(false);
    }
  }, [refresh, versions]);

  const discard = useCallback(
    async (d: LocalDeadLetter) => {
      if (d.kind === 'match') await deleteReport(d.id);
      else await deletePitReport(d.id);
      setConfirmDiscard(null);
      // Update the header badge immediately.
      window.dispatchEvent(new Event('scout-sync-changed'));
      await refresh();
    },
    [refresh],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl text-brand">This device — local outbox</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p data-testid="local-outbox-queued" className="text-sm text-muted-foreground">
          {queued} queued to upload · {dead.length + collaborativeDead.length} failed
        </p>
        {dead.length + collaborativeDead.length > 0 ? (
          <>
            <ul className="flex flex-col gap-2">
              {dead.map((d) => {
                const key = `${d.kind}:${d.id}`;
                const deletedEvent = isDeletedEventError(d.error);
                const armed = confirmDiscard === key;
                return (
                  <li
                    key={key}
                    data-testid="local-outbox-deadletter"
                    className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-semibold">{d.label}</div>
                      <div className="flex shrink-0 items-center gap-2">
                        {/* A pure "Retry all" just re-runs the identical broken
                            payload and re-dead-letters (BUG-3). The real fix for a
                            match report is to CORRECT the bad match/team and
                            re-save — but that's pointless when the whole EVENT is
                            gone, so hide Fix in that case and lead with Discard. */}
                        {!deletedEvent ? (
                          <Link
                            data-testid="local-outbox-fix"
                            to={
                              d.kind === 'match'
                                ? `/scout?edit=${d.id}`
                                : `/scout?mode=pit&pitTeam=${encodeURIComponent(d.id.split(':').at(-1) ?? '')}`
                            }
                            className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
                          >
                            Fix &amp; re-save
                          </Link>
                        ) : null}
                        {armed ? (
                          <>
                            <button
                              type="button"
                              data-testid="local-outbox-discard-confirm"
                              onClick={() => void discard(d)}
                              className="rounded-md border border-destructive bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground"
                            >
                              Discard
                            </button>
                            <button
                              type="button"
                              data-testid="local-outbox-discard-cancel"
                              onClick={() => setConfirmDiscard(null)}
                              className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            data-testid="local-outbox-discard"
                            onClick={() => setConfirmDiscard(key)}
                            className="rounded-md border border-destructive/50 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/20"
                          >
                            Discard
                          </button>
                        )}
                      </div>
                    </div>
                    {/* Armed discard on a still-fixable report: spell out that
                        this deletes the ONLY copy of unsynced data — history is
                        full of dead-letters later rescued by server fixes. */}
                    {armed && !deletedEvent ? (
                      <div className="mt-1 text-xs font-medium text-destructive">
                        This permanently deletes the only copy of this report — a
                        future fix could still recover it. Consider Fix &amp;
                        re-save or Retry first.
                      </div>
                    ) : null}
                    {/* Friendly explanation for the un-fixable case; else the raw
                        server error for debugging. */}
                    {deletedEvent ? (
                      <div className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        This report is for an event that no longer exists, so it can’t be
                        uploaded. Discard it to clear the warning.
                      </div>
                    ) : d.error ? (
                      <div className="mt-0.5 text-xs text-destructive [overflow-wrap:anywhere]">
                        {d.error}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {collaborativeDead.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {collaborativeDead.map((record) => {
                  const key = `${record.kind}:${record.key}`;
                  const open = inspecting === key;
                  const issue = record.local.recoveryIssue;
                  return (
                    <li
                      key={key}
                      data-testid="local-recovery-deadletter"
                      className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="font-semibold">
                            {record.kind === 'matchup-note'
                              ? `Strategy note · Team ${record.local.oppTeam}`
                              : `Strategy canvas · ${formatMatchKeyRaw(record.local.matchKey)} · ${record.local.phase ?? 'auto'}`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {issue?.kind === 'conflict'
                              ? 'Conflict — the local copy is not being shown as the shared version.'
                              : 'Upload failed — the local copy is held for recovery.'}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void inspectRecovery(record)}
                          >
                            {open ? 'Close' : 'Inspect'}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void retryLocalRecovery(record).then(refresh)}
                          >
                            Retry
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => void discardLocalRecovery(record).then(refresh)}
                          >
                            Discard
                          </Button>
                        </div>
                      </div>
                      {record.local.lastSyncError ? (
                        <p className="mt-2 text-xs text-destructive [overflow-wrap:anywhere]">
                          {record.local.lastSyncError}
                        </p>
                      ) : null}
                      {open ? (
                        <div
                          data-testid="local-recovery-inspector"
                          className="mt-3 flex flex-col gap-3 border-t border-warning/30 pt-3"
                        >
                          {record.kind === 'matchup-note' ? (
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div>
                                <p className="mb-1 text-xs font-semibold">Local recovery copy</p>
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 text-xs">
                                  {record.local.note || '(empty)'}
                                </pre>
                              </div>
                              <div>
                                <p className="mb-1 text-xs font-semibold">Server version</p>
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 text-xs">
                                  {versions?.kind === 'matchup-note'
                                    ? versions.server ?? '(none)'
                                    : 'Loading…'}
                                </pre>
                              </div>
                            </div>
                          ) : (
                            <div className="grid gap-2 text-xs sm:grid-cols-2">
                              <p className="rounded-md bg-background/70 p-2">
                                Local recovery copy: {record.local.strokes.length} strokes,{' '}
                                {record.local.deletedIds.length} erasures.
                              </p>
                              <p className="rounded-md bg-background/70 p-2">
                                Server version:{' '}
                                {versions?.kind === 'strategy-canvas'
                                  ? versions.server
                                    ? `${versions.server.strokes.length} strokes, ${versions.server.deletedIds.length} erasures`
                                    : 'none'
                                  : 'Loading…'}
                              </p>
                            </div>
                          )}
                          {recoveryError ? (
                            <p role="alert" className="text-xs text-destructive">
                              {recoveryError}
                            </p>
                          ) : null}
                          {versions ? (
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={recoveryBusy || versions.server == null}
                                onClick={() => void resolveRecovery(record, 'server')}
                              >
                                Use server
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={recoveryBusy}
                                onClick={() => void resolveRecovery(record, 'local')}
                              >
                                Use local &amp; retry
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={recoveryBusy || versions.server == null}
                                onClick={() => void resolveRecovery(record, 'merge')}
                              >
                                Merge &amp; retry
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <Button
              data-testid="local-outbox-retry"
              variant="outline"
              className="self-start"
              disabled={retrying}
              onClick={() => void retryAll()}
            >
              {retrying ? 'Retrying…' : 'Retry all failed'}
            </Button>
          </>
        ) : (
          <p className="text-sm text-success">No failed reports on this device.</p>
        )}
      </CardContent>
    </Card>
  );
}

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
  const { eventKey } = useActiveEvent();
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
    <main data-testid="sync-status" className="mx-auto flex max-w-3xl flex-col gap-4 px-safe py-safe sm:p-6">
      <div className="flex items-center gap-3">
        <BackLink to="/" label="Home" icon="home" />
        <h1 className="text-2xl font-bold">Sync status</h1>
      </div>
      <LocalOutbox />
      <Card>
        <CardHeader>
          <CardTitle className="text-xl text-brand">Server coverage</CardTitle>
        </CardHeader>
        <CardContent>
          {noActiveEvent ? (
            <p className="text-sm text-warning">No active event.</p>
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
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-semibold">{formatMatchKeyRaw(m.matchKey)}</span>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-xs tabular-nums ${
                          complete
                            ? 'border-success/40 bg-success/15 text-success'
                            : 'border-warning/40 bg-warning/15 text-warning'
                        }`}
                      >
                        {m.received}/{m.expected}
                      </span>
                      <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
                        {m.latestReceivedAt
                          ? new Date(m.latestReceivedAt).toLocaleString()
                          : 'none received'}
                      </span>
                    </div>
                    {m.missing.length > 0 ? (
                      <div className="text-xs font-medium text-destructive [overflow-wrap:anywhere]">
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
