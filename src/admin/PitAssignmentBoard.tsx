import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ensureEventScoutsFromRoster } from './ensureEventScoutsClient';
import {
  autoAssignPits,
  loadPitAssignmentSnapshot,
  publishPitAssignments,
} from './pitAssignmentsClient';
import type { AssignScout, AssignTeam, PitAssignment } from './types';
import {
  getCachedPitAssignmentsForEvent,
  replaceCachedPitAssignmentsForEvent,
} from '@/db/preloadClient';
import type { CachedPitAssignment } from '@/db/types';

export interface PitAssignmentBoardProps {
  eventKey: string;
  teams: AssignTeam[];
  scouts: AssignScout[];
}

type AssignmentSource = 'manual' | 'auto';

function assignmentKey(teamNumber: number, scoutId: string): string {
  return `${teamNumber}:${scoutId}`;
}

export function PitAssignmentBoard({
  eventKey,
  teams,
  scouts,
}: PitAssignmentBoardProps): JSX.Element {
  const queryClient = useQueryClient();
  const [publishedRows, setPublishedRows] = useState<PitAssignment[]>([]);
  const [batchRevision, setBatchRevision] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(true);
  const [authorityIssue, setAuthorityIssue] = useState<string | null>(null);
  const [verificationIssue, setVerificationIssue] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [pool, setPool] = useState(scouts);
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [sources, setSources] = useState<Record<string, AssignmentSource>>({});
  const [crewSize, setCrewSize] = useState(1);
  const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorEventKey, setEditorEventKey] = useState(eventKey);
  const currentEventKey = useRef(eventKey);
  currentEventKey.current = eventKey;

  useEffect(() => setPool(scouts), [eventKey, scouts]);
  useEffect(() => {
    // Generated/manual crews contain event-scoped scout ids. Never carry them
    // across an active-event switch, even for the single render before the new
    // roster query settles.
    setEditorEventKey(eventKey);
    setPicks({});
    setSources({});
    setGenerated(false);
    setBusy(false);
    setMessage(null);
    setError(null);
    setPublishedRows([]);
    setBatchRevision(null);
    setBatchLoading(true);
    setAuthorityIssue(null);
    setVerificationIssue(null);
    setConfirmClearAll(false);
  }, [eventKey]);
  const updatePublishedCaches = useCallback(
    (key: string, rows: PitAssignment[]): void => {
      queryClient.setQueryData(
        ['pit-assignments', key],
        rows.map((row) => ({
          event_key: key,
          team_number: row.teamNumber,
          scout_id: row.scoutId,
          source: row.source,
        })),
      );
      const cached: CachedPitAssignment[] = rows.map((row) => ({
        id: `${key}:${row.teamNumber}:${row.scoutId}`,
        event_key: key,
        team_number: row.teamNumber,
        scout_id: row.scoutId,
        source: row.source,
      }));
      void replaceCachedPitAssignmentsForEvent(key, cached).catch(() => {
        // Keep the authoritative in-memory/query snapshot if IndexedDB is
        // unavailable; a later preload can repair the offline cache.
      });
    },
    [queryClient],
  );

  const loadFallbackRows = useCallback(
    async (key: string): Promise<PitAssignment[]> => {
      type QueryPitAssignment = {
        event_key?: string;
        team_number: number;
        scout_id: string;
        source: 'manual' | 'auto';
      };
      const queryRows = queryClient.getQueryData<QueryPitAssignment[]>([
        'pit-assignments',
        key,
      ]);
      if (queryRows !== undefined) {
        return queryRows
          .filter(
            (row) =>
              (!row.event_key || row.event_key === key) &&
              Number.isSafeInteger(row.team_number) &&
              typeof row.scout_id === 'string' &&
              (row.source === 'manual' || row.source === 'auto'),
          )
          .map((row) => ({
            teamNumber: row.team_number,
            scoutId: row.scout_id,
            source: row.source,
          }));
      }
      const cached = await getCachedPitAssignmentsForEvent(key);
      return cached.map((row) => ({
        teamNumber: row.team_number,
        scoutId: row.scout_id,
        source: row.source,
      }));
    },
    [queryClient],
  );

  const refreshAuthoritativeSnapshot = useCallback(
    async (useFallback: boolean): Promise<boolean> => {
      const requestEventKey = eventKey;
      setBatchLoading(true);
      setAuthorityIssue(null);
      try {
        const snapshot = await loadPitAssignmentSnapshot(requestEventKey);
        if (currentEventKey.current !== requestEventKey) return false;
        setPublishedRows(snapshot.assignments);
        setBatchRevision(snapshot.state.revision);
        setVerificationIssue(null);
        updatePublishedCaches(requestEventKey, snapshot.assignments);
        return true;
      } catch {
        if (currentEventKey.current !== requestEventKey) return false;
        setBatchRevision(null);
        if (useFallback) {
          const fallback = await loadFallbackRows(requestEventKey).catch(() => []);
          if (currentEventKey.current !== requestEventKey) return false;
          setPublishedRows(fallback);
        }
        setAuthorityIssue(
          'Server revision unavailable. You can keep editing the last saved crews; Publish and Clear all stay locked until the server check succeeds.',
        );
        return false;
      } finally {
        if (currentEventKey.current === requestEventKey) setBatchLoading(false);
      }
    },
    [eventKey, loadFallbackRows, updatePublishedCaches],
  );

  useEffect(() => {
    void refreshAuthoritativeSnapshot(true);
  }, [refreshAuthoritativeSnapshot]);
  useEffect(() => {
    let cancelled = false;
    void ensureEventScoutsFromRoster(eventKey)
      .then((seeded) => {
        if (!cancelled && currentEventKey.current === eventKey && seeded.length) setPool(seeded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [eventKey]);

  const editorReady = editorEventKey === eventKey && !batchLoading;
  const publishReady = editorReady && batchRevision !== null;

  const sortedTeams = useMemo(
    () => [...teams].sort((a, b) => a.teamNumber - b.teamNumber),
    [teams],
  );
  const load = useMemo(() => {
    const counts = new Map<string, number>();
    for (const members of Object.values(picks)) {
      for (const scoutId of members) {
        counts.set(scoutId, (counts.get(scoutId) ?? 0) + 1);
      }
    }
    return counts;
  }, [picks]);

  async function ensurePool(): Promise<AssignScout[]> {
    if (pool.length) return pool;
    const requestEventKey = eventKey;
    const seeded = await ensureEventScoutsFromRoster(requestEventKey);
    if (currentEventKey.current !== requestEventKey) return [];
    setPool(seeded);
    return seeded;
  }

  async function autoGenerate(): Promise<void> {
    if (!editorReady) return;
    const requestEventKey = eventKey;
    setError(null);
    setMessage(null);
    try {
      const activePool = await ensurePool();
      if (currentEventKey.current !== requestEventKey) return;
      if (!activePool.length) {
        setError('No scouters on the roster yet. Add scouters in the Roster tab first.');
        return;
      }
      const next: Record<number, string[]> = {};
      const nextSources: Record<string, AssignmentSource> = {};
      for (const assignment of autoAssignPits(sortedTeams, activePool, crewSize)) {
        next[assignment.teamNumber] = [
          ...(next[assignment.teamNumber] ?? []),
          assignment.scoutId,
        ];
        nextSources[assignmentKey(assignment.teamNumber, assignment.scoutId)] = 'auto';
      }
      setPicks(next);
      setSources(nextSources);
      setGenerated(true);
      setConfirmClearAll(false);
    } catch (err) {
      if (currentEventKey.current !== requestEventKey) return;
      setError(err instanceof Error ? err.message : 'Could not load scouters.');
    }
  }

  async function startManual(): Promise<void> {
    if (!editorReady) return;
    const requestEventKey = eventKey;
    setError(null);
    setMessage(null);
    try {
      const activePool = await ensurePool();
      if (currentEventKey.current !== requestEventKey) return;
      if (!activePool.length) {
        setError('No scouters on the roster yet. Add scouters in the Roster tab first.');
        return;
      }
      const next: Record<number, string[]> = {};
      const nextSources: Record<string, AssignmentSource> = {};
      for (const row of publishedRows) {
        const members = next[row.teamNumber] ?? [];
        if (!members.includes(row.scoutId)) {
          next[row.teamNumber] = [...members, row.scoutId];
        }
        nextSources[assignmentKey(row.teamNumber, row.scoutId)] = row.source;
      }
      setPicks(next);
      setSources(nextSources);
      setGenerated(true);
      setConfirmClearAll(false);
    } catch (err) {
      if (currentEventKey.current !== requestEventKey) return;
      setError(err instanceof Error ? err.message : 'Could not load scouters.');
    }
  }

  async function publishDraft(
    assignments: PitAssignment[],
    clearingAll = false,
  ): Promise<void> {
    const hasDraftAssignments = Object.values(picks).some((members) => members.length > 0);
    if (
      busy ||
      !publishReady ||
      batchRevision === null ||
      (!clearingAll && !hasDraftAssignments)
    ) {
      return;
    }
    const publishEventKey = eventKey;
    const publishBaseRevision = batchRevision;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await publishPitAssignments(
        publishEventKey,
        assignments,
        publishBaseRevision,
      );
      if (currentEventKey.current !== publishEventKey) return;
      if (result.status === 'conflict') {
        setBatchRevision(null);
        await refreshAuthoritativeSnapshot(false);
        if (currentEventKey.current !== publishEventKey) return;
        if (clearingAll) setConfirmClearAll(false);
        setError(
          'Another lead changed pit assignments. Your draft was kept; review the refreshed live crews before publishing again.',
        );
        return;
      }

      setPublishedRows(assignments);
      setBatchRevision(result.revision);
      updatePublishedCaches(publishEventKey, assignments);
      setMessage(
        clearingAll
          ? 'Cleared all pit crew assignments.'
          : `Published ${result.count} pit crew assignment${result.count === 1 ? '' : 's'}.`,
      );
      if (clearingAll) {
        setPicks({});
        setSources({});
        setGenerated(false);
      }
      setConfirmClearAll(false);

      try {
        const snapshot = await loadPitAssignmentSnapshot(publishEventKey);
        if (currentEventKey.current !== publishEventKey) return;
        setPublishedRows(snapshot.assignments);
        setBatchRevision(snapshot.state.revision);
        updatePublishedCaches(publishEventKey, snapshot.assignments);
        if (snapshot.state.revision !== result.revision) {
          setVerificationIssue(
            'Publish succeeded, but live pit crews changed again before verification finished. The latest server snapshot is shown.',
          );
        } else {
          setVerificationIssue(null);
        }
      } catch {
        if (currentEventKey.current !== publishEventKey) return;
        setVerificationIssue(
          'Publish succeeded, but the follow-up server refresh failed. The confirmed published crews are shown; retry the server check when connectivity returns.',
        );
      }
      void queryClient
        .invalidateQueries({ queryKey: ['pit-assignments', publishEventKey] })
        .catch(() => undefined);
    } catch (err) {
      if (currentEventKey.current !== publishEventKey) return;
      if (clearingAll) setConfirmClearAll(false);
      setError(err instanceof Error ? err.message : 'Publish failed.');
    } finally {
      if (currentEventKey.current === publishEventKey) setBusy(false);
    }
  }

  async function publish(): Promise<void> {
    const assignments: PitAssignment[] = sortedTeams.flatMap((team) =>
      (picks[team.teamNumber] ?? []).map((scoutId) => ({
        teamNumber: team.teamNumber,
        scoutId,
        source: sources[assignmentKey(team.teamNumber, scoutId)] ?? 'manual',
      })),
    );
    await publishDraft(assignments);
  }

  async function clearAll(): Promise<void> {
    if (!confirmClearAll) {
      setConfirmClearAll(true);
      setError(null);
      return;
    }
    await publishDraft([], true);
  }

  const publishedCount = publishedRows.length;
  const assignedCount = generated
    ? sortedTeams.filter((team) => (picks[team.teamNumber]?.length ?? 0) > 0).length
    : new Set(publishedRows.map((row) => row.teamNumber)).size;
  const crewMemberCount = generated
    ? Object.values(picks).reduce((sum, members) => sum + members.length, 0)
    : publishedCount;

  function addMember(teamNumber: number, scoutId: string): void {
    if (!scoutId) return;
    setPicks((current) => {
      const members = current[teamNumber] ?? [];
      if (members.includes(scoutId)) return current;
      return { ...current, [teamNumber]: [...members, scoutId] };
    });
    setSources((current) => ({
      ...current,
      [assignmentKey(teamNumber, scoutId)]: 'manual',
    }));
    setConfirmClearAll(false);
  }

  function removeMember(teamNumber: number, scoutId: string): void {
    setPicks((current) => ({
      ...current,
      [teamNumber]: (current[teamNumber] ?? []).filter((id) => id !== scoutId),
    }));
    setSources((current) => {
      const next = { ...current };
      delete next[assignmentKey(teamNumber, scoutId)];
      return next;
    });
    setConfirmClearAll(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Pit assignments</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Crew size
            <select
              data-testid="pit-crew-size"
              aria-label="Scouts per pit crew"
              value={crewSize}
              disabled={busy || !editorReady}
              onChange={(event) => setCrewSize(Number(event.target.value))}
              className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
            >
              {[1, 2, 3, 4].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            data-testid="pit-auto-generate"
            disabled={sortedTeams.length === 0 || busy || !editorReady}
            onClick={() => void autoGenerate()}
          >
            {generated ? 'Re-balance' : 'Auto-balance'}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="pit-assign-manually"
            disabled={sortedTeams.length === 0 || busy || !editorReady}
            onClick={() => void startManual()}
          >
            Assign manually
          </Button>
          <Button
            type="button"
            variant="brand"
            className="ml-auto"
            data-testid="publish-pit-assignments"
            disabled={
              !generated ||
              busy ||
              !publishReady ||
              crewMemberCount === 0
            }
            onClick={() => void publish()}
          >
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
          {publishedRows.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              data-testid="clear-all-pit-assignments"
              disabled={busy || !publishReady}
              onClick={() => void clearAll()}
              className={confirmClearAll ? 'border-destructive text-destructive' : undefined}
            >
              {confirmClearAll ? 'Confirm clear all' : 'Clear all'}
            </Button>
          ) : null}
        </div>

        <p className="mt-3 text-sm text-muted-foreground">
          {assignedCount} / {sortedTeams.length} teams assigned
          {crewMemberCount > 0 ? ` · ${crewMemberCount} crew spots` : ''}
          {!generated && publishedCount > 0 ? ' · live for scouts' : ''}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Auto-balance builds crews of the selected size. Add or remove members on any team
          before publishing.
        </p>
        {message ? <p className="mt-2 text-sm text-success">{message}</p> : null}
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
        {authorityIssue || verificationIssue ? (
          <div
            data-testid="pit-assignments-authority-status"
            className="mt-3 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-warning sm:flex-row sm:items-center sm:justify-between"
          >
            <p>{authorityIssue ?? verificationIssue}</p>
            <Button
              type="button"
              variant="outline"
              className="h-10 shrink-0"
              disabled={batchLoading}
              onClick={() => void refreshAuthoritativeSnapshot(false)}
            >
              {batchLoading ? 'Checking…' : 'Retry server check'}
            </Button>
          </div>
        ) : null}
        {batchLoading ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Loading authoritative pit assignment revision…
          </p>
        ) : null}

        {generated ? (
          <>
            <div className="mt-4 flex flex-wrap gap-1.5 text-xs">
              {pool.map((scout) => (
                <span key={scout.id} className="rounded-full border border-border px-2 py-0.5">
                  {scout.displayName} · {load.get(scout.id) ?? 0}
                </span>
              ))}
            </div>
            <div
              data-testid="pit-assignment-grid"
              className="mt-3 grid max-h-[60vh] gap-2 overflow-y-auto pr-1 sm:grid-cols-2"
            >
              {sortedTeams.map((team) => {
                const members = picks[team.teamNumber] ?? [];
                return (
                  <article
                    key={team.teamNumber}
                    data-testid={`pit-team-crew-${team.teamNumber}`}
                    className="flex min-h-24 flex-col gap-2 rounded-lg border border-border p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 font-mono font-semibold text-brand">
                        {team.teamNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {team.nickname ?? ''}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {members.length} {members.length === 1 ? 'scout' : 'scouts'}
                      </span>
                    </div>
                    <div className="flex min-h-7 flex-wrap gap-1.5">
                      {members.map((scoutId) => {
                        const scout = pool.find((candidate) => candidate.id === scoutId);
                        const displayName = scout?.displayName ?? 'Unknown scout';
                        return (
                          <span
                            key={scoutId}
                            data-testid={`pit-member-${team.teamNumber}-${scoutId}`}
                            className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand/5 py-0.5 pl-2 pr-1 text-xs"
                          >
                            {displayName}
                            <button
                              type="button"
                              aria-label={`Remove ${displayName} from team ${team.teamNumber}`}
                              disabled={busy || !editorReady}
                              onClick={() => removeMember(team.teamNumber, scoutId)}
                              className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                      {members.length === 0 ? (
                        <span className="text-xs text-muted-foreground">No crew assigned</span>
                      ) : null}
                    </div>
                    <select
                      aria-label={`Add pit scout to team ${team.teamNumber}`}
                      data-testid={`pit-add-member-${team.teamNumber}`}
                      value=""
                      disabled={busy || !editorReady || members.length >= pool.length}
                      onChange={(event) => addMember(team.teamNumber, event.target.value)}
                      className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="">
                        {members.length >= pool.length
                          ? 'Every scout is assigned'
                          : 'Add crew member…'}
                      </option>
                      {pool
                        .filter((scout) => !members.includes(scout.id))
                        .map((scout) => (
                          <option key={scout.id} value={scout.id}>
                            {scout.displayName}
                          </option>
                        ))}
                    </select>
                  </article>
                );
              })}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
