import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { autoAssignPlan } from './autoAssign';
import { applyDaysOff, loadDaysOff, matchDays, saveDaysOff, type ScoutDaysOff } from './matchDays';
import {
  loadMatchAssignmentSnapshot,
  publishAssignments,
} from './setAssignmentsClient';
import { ensureEventScoutsFromRoster } from './ensureEventScoutsClient';
import type { AssignMatch, AssignScout, Assignment, AllianceColor } from './types';
import {
  computeCoverage,
  computeCoverageFromAssignments,
  slotKey,
  type Seat,
} from './coverage';
import { CoverageGapPanel } from './CoverageGapPanel';
import { isQualMatchKey } from '@/lib/formatMatch';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Settings2, ChevronDown } from 'lucide-react';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';
import {
  getCachedAssignmentsForEvent,
  replaceCachedAssignmentsForEvent,
} from '@/db/preloadClient';
import type { CachedAssignment } from '@/db/types';

type Slot = Seat;

export interface AssignmentBoardProps {
  eventKey: string;
  matches: AssignMatch[];
  scouts: AssignScout[];
}

/**
 * One sentence on how evenly a partial-coverage plan treats teams: the
 * min–max count of scouted matches per team (own team excluded).
 */
function describeTeamCoverage(
  quals: readonly AssignMatch[],
  skippedMatchKeys: readonly string[],
  ownTeam: number,
): string {
  const skipped = new Set(skippedMatchKeys);
  const played = new Map<number, number>();
  const scouted = new Map<number, number>();
  for (const m of quals) {
    for (const t of new Set([...m.redTeams, ...m.blueTeams])) {
      if (t === ownTeam || t == null || !Number.isFinite(t)) continue;
      played.set(t, (played.get(t) ?? 0) + 1);
      if (!skipped.has(m.matchKey)) scouted.set(t, (scouted.get(t) ?? 0) + 1);
    }
  }
  if (played.size === 0) return '';
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of played.keys()) {
    const n = scouted.get(t) ?? 0;
    lo = Math.min(lo, n);
    hi = Math.max(hi, n);
  }
  const range = lo === hi ? `${lo}` : `${lo}–${hi}`;
  return `Every team is scouted in ${range} of its matches.`;
}

export function AssignmentBoard({ eventKey, matches, scouts }: AssignmentBoardProps): JSX.Element {
  // The base/own team is never scouted (you don't scout yourself), so its slots
  // are excluded. Configurable in Setup; defaults to 3256.
  const ownTeam = getStoredBaseTeam();
  const queryClient = useQueryClient();
  // scoutId per slotKey ('' === unassigned)
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishedRows, setPublishedRows] = useState<Assignment[]>([]);
  const [batchRevision, setBatchRevision] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(true);
  const [authorityIssue, setAuthorityIssue] = useState<string | null>(null);
  const [verificationIssue, setVerificationIssue] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [editorEventKey, setEditorEventKey] = useState(eventKey);
  const currentEventKey = useRef(eventKey);
  currentEventKey.current = eventKey;

  // Auto-generate tuning — surfaced to the lead so they control HOW seats get
  // filled, not just that they do.
  const [scheduleMode, setScheduleMode] = useState<'balanced' | 'blocked'>('balanced');
  const [blockAssignments, setBlockAssignments] = useState(2);
  const [spacingMatches, setSpacingMatches] = useState(1);
  const [restLength, setRestLength] = useState(3);
  const [rotatePositions, setRotatePositions] = useState(true);
  const [avoidBackToBack, setAvoidBackToBack] = useState(true);
  // Share of qual matches the generator fills; the rest are left empty on
  // purpose (small crews scouting every other match, etc.).
  const [coveragePercent, setCoveragePercent] = useState(100);
  // Per-scouter days off (e.g. Saturday-only scouters). Persisted per event on
  // the lead's device so a regenerate after reload keeps the same plan.
  const [daysOff, setDaysOff] = useState<ScoutDaysOff>(() => loadDaysOff(eventKey));
  const [generationWarning, setGenerationWarning] = useState<string | null>(null);
  const [generationNote, setGenerationNote] = useState<string | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  // Manual authoring aid: hide fully-covered matches so the lead can fill holes.
  const [onlyGaps, setOnlyGaps] = useState(false);

  // Effective scout pool. Starts from the per-event `scout` rows passed in, but
  // freshly imported events have none (those rows are created when a scouter
  // picks their name on their device). In that case the lead can seed the pool
  // from the persistent roster on demand, so auto-generate works for any event.
  const [pool, setPool] = useState<AssignScout[]>(scouts);
  const [seeding, setSeeding] = useState(false);
  useEffect(() => {
    setPool(scouts);
  }, [eventKey, scouts]);

  useEffect(() => {
    // Slot keys and scout ids are event-scoped. Reset synchronously after any
    // event change and keep publish locked for the intervening render.
    setEditorEventKey(eventKey);
    setPicks({});
    setGenerated(false);
    setBusy(false);
    setPublished(null);
    setError(null);
    setSeeding(false);
    setPublishedRows([]);
    setBatchRevision(null);
    setBatchLoading(true);
    setAuthorityIssue(null);
    setVerificationIssue(null);
    setGenerationWarning(null);
    setConfirmClearAll(false);
    setDaysOff(loadDaysOff(eventKey));
  }, [eventKey]);

  const updatePublishedCaches = useCallback(
    (key: string, rows: Assignment[]): void => {
      queryClient.setQueryData(
        ['assignments', key],
        rows.map((row) => ({
          event_key: key,
          match_key: row.matchKey,
          scout_id: row.scoutId,
          alliance_color: row.allianceColor,
          station: row.station,
          target_team_number: row.targetTeamNumber,
        })),
      );
      const cached: CachedAssignment[] = rows.map((row) => ({
        id: `${key}:${row.matchKey}:${row.allianceColor}:${row.station}`,
        event_key: key,
        scout_id: row.scoutId,
        match_key: row.matchKey,
        alliance_color: row.allianceColor,
        station: row.station,
        target_team_number: row.targetTeamNumber,
      }));
      void replaceCachedAssignmentsForEvent(key, cached).catch(() => {
        // The authoritative in-memory/query snapshot remains usable if IndexedDB
        // is unavailable (private mode/quota). A later preload can repair Dexie.
      });
    },
    [queryClient],
  );

  const loadFallbackRows = useCallback(
    async (key: string): Promise<Assignment[]> => {
      type QueryAssignment = {
        event_key?: string;
        match_key: string;
        scout_id: string | null;
        alliance_color: string;
        station: number;
        target_team_number: number | null;
      };
      const queryRows = queryClient.getQueryData<QueryAssignment[]>(['assignments', key]);
      if (queryRows !== undefined) {
        return queryRows
          .filter(
            (row) =>
              (!row.event_key || row.event_key === key) &&
              typeof row.scout_id === 'string' &&
              (row.alliance_color === 'red' || row.alliance_color === 'blue') &&
              (row.station === 1 || row.station === 2 || row.station === 3) &&
              typeof row.target_team_number === 'number',
          )
          .map((row) => ({
            matchKey: row.match_key,
            scoutId: row.scout_id as string,
            allianceColor: row.alliance_color as AllianceColor,
            station: row.station as 1 | 2 | 3,
            targetTeamNumber: row.target_team_number as number,
          }));
      }
      const cached = await getCachedAssignmentsForEvent(key);
      return cached.map((row) => ({
        matchKey: row.match_key,
        scoutId: row.scout_id,
        allianceColor: row.alliance_color,
        station: row.station,
        targetTeamNumber: row.target_team_number,
      }));
    },
    [queryClient],
  );

  const refreshAuthoritativeSnapshot = useCallback(
    async (useFallback: boolean): Promise<boolean> => {
      if (!eventKey) return false;
      const requestEventKey = eventKey;
      setBatchLoading(true);
      setAuthorityIssue(null);
      try {
        const snapshot = await loadMatchAssignmentSnapshot(requestEventKey);
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
          'Server revision unavailable. You can keep editing the last saved snapshot; Publish and Clear all stay locked until the server check succeeds.',
        );
        return false;
      } finally {
        if (currentEventKey.current === requestEventKey) setBatchLoading(false);
      }
    },
    [eventKey, loadFallbackRows, updatePublishedCaches],
  );

  useEffect(() => {
    if (!eventKey) return;
    void refreshAuthoritativeSnapshot(true);
  }, [eventKey, refreshAuthoritativeSnapshot]);

  // Always seed the (non-hidden) roster into the event scout pool on mount, so
  // EVERY scouter is assignable — not just whoever has already picked their name
  // on a device. Previously the dropdown read only the `scout` table, so a fresh
  // event showed just the lone device that had checked in (e.g. "E2E Capture").
  // Seeding is idempotent server-side and excludes hidden scouters (migration
  // 0020). Offline / empty-roster failures are non-fatal: we keep the props pool.
  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const seeded = await ensureEventScoutsFromRoster(eventKey);
        if (!cancelled && currentEventKey.current === eventKey && seeded.length) setPool(seeded);
      } catch {
        /* offline or no roster yet — keep the scouts passed in via props */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventKey]);

  // Scouting assignments are created ONLY for qualification matches — playoffs
  // are intentionally never assigned (alliances pick their own scouting focus).
  // The board's whole universe (slots + auto-assign input) is quals-only; the
  // separate ScheduleView still shows every match.
  const qualMatches = useMemo(
    () => matches.filter((m) => isQualMatchKey(m.matchKey)),
    [matches],
  );

  // Calendar days of the qual schedule (needs TBA scheduled times). With only
  // one day there is nothing to restrict, so the availability grid stays hidden.
  const days = useMemo(() => matchDays(qualMatches), [qualMatches]);
  const dayByMatch = useMemo(() => {
    const map = new Map<string, { key: string; weekday: string }>();
    for (const d of days) for (const k of d.matchKeys) map.set(k, { key: d.key, weekday: d.weekday });
    return map;
  }, [days]);
  const isOffForMatch = (scoutId: string, matchKey: string): boolean => {
    const day = dayByMatch.get(matchKey);
    return day != null && (daysOff[scoutId] ?? []).includes(day.key);
  };

  function toggleDayOff(scoutId: string, dayKey: string, available: boolean): void {
    setDaysOff((prev) => {
      const current = prev[scoutId] ?? [];
      const nextList = available
        ? current.filter((k) => k !== dayKey)
        : current.includes(dayKey)
          ? current
          : [...current, dayKey];
      const next = { ...prev, [scoutId]: nextList };
      saveDaysOff(eventKey, next);
      return next;
    });
  }

  const slots = useMemo<Slot[]>(() => {
    const out: Slot[] = [];
    for (const m of qualMatches) {
      const teams: { color: AllianceColor; nums: [number, number, number] }[] = [
        { color: 'red', nums: m.redTeams },
        { color: 'blue', nums: m.blueTeams },
      ];
      for (const a of teams) {
        a.nums.forEach((team, i) => {
          if (team === ownTeam) return;
          if (team == null || !Number.isFinite(team)) return; // empty alliance slot
          out.push({
            matchKey: m.matchKey,
            allianceColor: a.color,
            station: (i + 1) as 1 | 2 | 3,
            targetTeamNumber: team,
          });
        });
      }
    }
    return out;
  }, [qualMatches, ownTeam]);

  // Draft coverage — 100% local, recomputes on every pick edit. Surfaces which
  // eligible seats still have no scout BEFORE the lead queues matches.
  const draftSummary = useMemo(
    () => computeCoverage(slots, (k) => picks[k] ?? ''),
    [slots, picks],
  );

  // The rows and revision come from one stable before/after snapshot. A cached
  // row query cannot safely be paired with a separately loaded CAS revision.
  // Cached rows ARE still safe for local authoring; only publish/CAS needs the
  // authoritative revision.
  const publishedMapped = publishedRows;
  const editorReady = editorEventKey === eventKey && !batchLoading;
  const publishReady = editorReady && batchRevision !== null;
  const publishedSummary = useMemo(
    () => computeCoverageFromAssignments(slots, publishedMapped),
    [slots, publishedMapped],
  );

  // Divergence: draft slot→scout map differs from the published one. Only after
  // the board is generated (otherwise the published panel stands alone).
  const diverged = useMemo(() => {
    if (!generated) return false;
    const draftMap = new Map<string, string>();
    for (const s of slots) {
      const v = picks[slotKey(s)] ?? '';
      if (v !== '') draftMap.set(slotKey(s), v);
    }
    const publishedMap = new Map<string, string>();
    for (const a of publishedMapped) {
      const v = (a.scoutId ?? '').trim();
      if (v !== '') publishedMap.set(slotKey(a), v);
    }
    if (draftMap.size !== publishedMap.size) return true;
    for (const [k, v] of draftMap) {
      if (publishedMap.get(k) !== v) return true;
    }
    return false;
  }, [generated, slots, picks, publishedMapped]);

  function generateFrom(activePool: AssignScout[]): void {
    const plan = autoAssignPlan(qualMatches, applyDaysOff(activePool, days, daysOff), {
      ownTeam,
      scheduleMode,
      blockAssignments,
      spacingMatches,
      breakLength: restLength,
      rotatePositions,
      avoidBackToBack,
      coveragePercent,
    });
    const next: Record<string, string> = {};
    for (const a of plan.assignments) {
      next[slotKey(a)] = a.scoutId;
    }
    setGenerationWarning(
      plan.relaxedMatchKeys.length > 0
        ? `Full coverage required relaxing the blocked schedule in ${plan.relaxedMatchKeys.length} match${plan.relaxedMatchKeys.length === 1 ? '' : 'es'}. Add more available scouters or reduce the spacing or break length to honor it exactly.`
        : null,
    );
    const skipped = plan.skippedMatchKeys.length;
    const coveredCount = qualMatches.length - skipped;
    setGenerationNote(
      skipped > 0
        ? `Covering ${coveredCount} of ${qualMatches.length} qualification matches (${coveragePercent}%). ${describeTeamCoverage(qualMatches, plan.skippedMatchKeys, ownTeam)} The other ${skipped} ${skipped === 1 ? 'match is' : 'matches are'} intentionally left open and will show as gaps in Coverage.`
        : null,
    );
    setPicks(next);
    setGenerated(true);
    setPublished(null);
    setError(null);
    setConfirmClearAll(false);
  }

  async function onAutoGenerate(): Promise<void> {
    if (!editorReady) return;
    const requestEventKey = eventKey;
    setError(null);
    setGenerationWarning(null);
    setGenerationNote(null);
    // No per-event scouts checked in yet: seed the pool from the persistent
    // roster so the lead can assign before anyone has picked their name.
    if (pool.length === 0) {
      if (seeding) return;
      setSeeding(true);
      try {
        const seeded = await ensureEventScoutsFromRoster(eventKey);
        if (currentEventKey.current !== requestEventKey) return;
        setPool(seeded);
        if (seeded.length === 0) {
          setError('No scouters on the roster yet. Add scouters in the Roster tab first.');
          return;
        }
        generateFrom(seeded);
      } catch (err) {
        if (currentEventKey.current !== requestEventKey) return;
        setError(err instanceof Error ? err.message : 'Could not load scouters.');
      } finally {
        if (currentEventKey.current === requestEventKey) setSeeding(false);
      }
      return;
    }
    generateFrom(pool);
  }

  // Open the board for hand-assignment WITHOUT auto-filling. Seeds from whatever
  // is already published so the lead keeps live assignments and edits from there;
  // starts blank if nothing is published yet.
  async function onStartManual(): Promise<void> {
    if (!editorReady) return;
    const requestEventKey = eventKey;
    setError(null);
    setGenerationWarning(null);
    if (pool.length === 0 && !seeding) {
      setSeeding(true);
      try {
        const seeded = await ensureEventScoutsFromRoster(eventKey);
        if (currentEventKey.current !== requestEventKey) return;
        setPool(seeded);
        if (seeded.length === 0) {
          setError('No scouters on the roster yet. Add scouters in the Roster tab first.');
          return;
        }
      } catch (err) {
        if (currentEventKey.current !== requestEventKey) return;
        setError(err instanceof Error ? err.message : 'Could not load scouters.');
        return;
      } finally {
        if (currentEventKey.current === requestEventKey) setSeeding(false);
      }
    }
    const next: Record<string, string> = {};
    for (const a of publishedMapped) {
      const v = (a.scoutId ?? '').trim();
      if (v) next[slotKey(a)] = v;
    }
    setPicks(next);
    setGenerated(true);
    setPublished(null);
    setConfirmClearAll(false);
  }

  function setSlot(key: string, scoutId: string): void {
    setPicks((prev) => ({ ...prev, [key]: scoutId }));
    setConfirmClearAll(false);
  }

  // Clear every seat of one match in a single tap (manual-authoring aid).
  function clearMatch(matchKey: string): void {
    setConfirmClearAll(false);
    setPicks((prev) => {
      const next = { ...prev };
      for (const s of slots) {
        if (s.matchKey === matchKey) next[slotKey(s)] = '';
      }
      return next;
    });
  }

  async function publishDraft(assignments: Assignment[], clearingAll = false): Promise<void> {
    if (
      busy ||
      !publishReady ||
      batchRevision === null ||
      (!clearingAll && draftSummary.coveredSeats === 0)
    ) {
      return;
    }
    const publishEventKey = eventKey;
    const publishBaseRevision = batchRevision;
    setBusy(true);
    setError(null);
    setPublished(null);
    try {
      const result = await publishAssignments(
        publishEventKey,
        assignments,
        publishBaseRevision,
      );
      if (currentEventKey.current !== publishEventKey) return;
      if (result.status === 'conflict') {
        // The conflict result has an authoritative revision/count but no rows.
        // Do not pair it with our stale published rows; lock server actions until
        // a coherent snapshot is loaded, while leaving the local draft editable.
        setBatchRevision(null);
        await refreshAuthoritativeSnapshot(false);
        if (currentEventKey.current !== publishEventKey) return;
        if (clearingAll) setConfirmClearAll(false);
        setError(
          'Another lead changed match assignments. Your draft was kept; review the refreshed live coverage before publishing again.',
        );
        return;
      }

      // Applied/idempotent is an atomic server confirmation. The submitted rows
      // and returned revision/count are therefore the authoritative post-RPC
      // snapshot even if the optional read-back below cannot reach the server.
      setPublishedRows(assignments);
      setBatchRevision(result.revision);
      setPublished(result.count);
      updatePublishedCaches(publishEventKey, assignments);
      if (clearingAll) {
        setPicks({});
        setGenerated(false);
      }
      setConfirmClearAll(false);

      try {
        const snapshot = await loadMatchAssignmentSnapshot(publishEventKey);
        if (currentEventKey.current !== publishEventKey) return;
        setPublishedRows(snapshot.assignments);
        setBatchRevision(snapshot.state.revision);
        updatePublishedCaches(publishEventKey, snapshot.assignments);
        if (snapshot.state.revision !== result.revision) {
          setVerificationIssue(
            'Publish succeeded, but live assignments changed again before verification finished. The latest server snapshot is shown.',
          );
        } else {
          setVerificationIssue(null);
        }
      } catch {
        if (currentEventKey.current !== publishEventKey) return;
        // Keep the result revision, never the pre-publish base revision.
        setVerificationIssue(
          'Publish succeeded, but the follow-up server refresh failed. The confirmed published rows are shown; retry the server check when connectivity returns.',
        );
      }

      // The cache was already updated synchronously above. Refetching is a
      // best-effort background verification and cannot turn a confirmed publish
      // into an error.
      void queryClient
        .invalidateQueries({ queryKey: ['assignments', publishEventKey] })
        .catch(() => undefined);
    } catch (err) {
      if (currentEventKey.current !== publishEventKey) return;
      if (clearingAll) setConfirmClearAll(false);
      setError(err instanceof Error ? err.message : 'Publish failed.');
    } finally {
      if (currentEventKey.current === publishEventKey) setBusy(false);
    }
  }

  async function onPublish(): Promise<void> {
    const assignments: Assignment[] = slots
      .map((s) => ({ ...s, scoutId: picks[slotKey(s)] ?? '' }))
      .filter((s) => s.scoutId !== '')
      .map((s) => ({
        matchKey: s.matchKey,
        scoutId: s.scoutId,
        allianceColor: s.allianceColor,
        station: s.station,
        targetTeamNumber: s.targetTeamNumber,
      }));
    await publishDraft(assignments);
  }

  async function onClearAll(): Promise<void> {
    if (!confirmClearAll) {
      setConfirmClearAll(true);
      setError(null);
      return;
    }
    await publishDraft([], true);
  }

  // One-line published/live-for-scouts status shown under the single coverage
  // headline — replaces the old second, stacked "Published" panel.
  const publishedLiveNote = useMemo(() => {
    if (publishedMapped.length === 0) return 'Not published yet — scouts have no assignments.';
    return `Live for scouts: ${publishedSummary.coveredSeats} / ${publishedSummary.totalSeats} seats${
      diverged ? '' : ' · up to date'
    }`;
  }, [publishedMapped.length, publishedSummary, diverged]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of pool) map.set(s.id, s.displayName);
    return map;
  }, [pool]);

  // Seats grouped by match, preserving slot order (red 1-3 then blue 1-3, own
  // team + empty seats already dropped). Drives the one-row-per-match manual grid.
  const slotsByMatch = useMemo(() => {
    const order: string[] = [];
    const byMatch = new Map<string, Slot[]>();
    for (const s of slots) {
      let bucket = byMatch.get(s.matchKey);
      if (!bucket) {
        bucket = [];
        byMatch.set(s.matchKey, bucket);
        order.push(s.matchKey);
      }
      bucket.push(s);
    }
    return order.map((matchKey) => {
      const seats = byMatch.get(matchKey) as Slot[];
      const gaps = seats.filter((s) => (picks[slotKey(s)] ?? '') === '').length;
      return { matchKey, seats, gaps };
    });
  }, [slots, picks]);

  // Per-scout assignment load in the current draft — a live balance aid so the
  // lead can see who's overloaded or idle while hand-assigning.
  const loadByScout = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of slots) {
      const v = picks[slotKey(s)] ?? '';
      if (v) map.set(v, (map.get(v) ?? 0) + 1);
    }
    return map;
  }, [slots, picks]);

  const shortMatch = (matchKey: string): string => matchKey.replace(`${eventKey}_`, '');
  const matchLabel = (matchKey: string): string =>
    shortMatch(matchKey).replace(/^qm/i, 'Q').toUpperCase();

  const visibleMatches = onlyGaps ? slotsByMatch.filter((m) => m.gaps > 0) : slotsByMatch;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Assignments</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            data-testid="auto-generate-btn"
            onClick={() => void onAutoGenerate()}
            disabled={
              qualMatches.length === 0 ||
              seeding ||
              !editorReady
            }
            variant="outline"
            className="h-11"
          >
            {seeding ? 'Loading scouters…' : generated ? 'Re-generate' : 'Auto-generate'}
          </Button>
          <Button
            type="button"
            data-testid="assign-manually-btn"
            onClick={() => void onStartManual()}
            disabled={
              qualMatches.length === 0 ||
              seeding ||
              !editorReady
            }
            variant="outline"
            className="h-11"
          >
            Assign manually
          </Button>
          <button
            type="button"
            data-testid="auto-generate-options-toggle"
            onClick={() => setShowOptions((v) => !v)}
            disabled={qualMatches.length === 0}
            aria-expanded={showOptions}
            className="inline-flex h-11 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <Settings2 className="size-4" />
            Options
            <ChevronDown
              className={`size-4 transition-transform ${showOptions ? 'rotate-180' : ''}`}
            />
          </button>
          <Button
            type="button"
            data-testid="publish-assignments-btn"
            onClick={() => void onPublish()}
            disabled={
              busy ||
              !generated ||
              !publishReady ||
              draftSummary.coveredSeats === 0
            }
            variant="brand"
            className="ml-auto h-11"
          >
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
          {publishedRows.length > 0 ? (
            <Button
              type="button"
              data-testid="clear-all-assignments-btn"
              onClick={() => void onClearAll()}
              disabled={busy || !publishReady}
              variant="outline"
              className={confirmClearAll ? 'h-11 border-destructive text-destructive' : 'h-11'}
            >
              {confirmClearAll ? 'Confirm clear all' : 'Clear all'}
            </Button>
          ) : null}
        </div>

        {showOptions ? (
          <div
            data-testid="auto-generate-options"
            className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm"
          >
            <p className="text-xs text-muted-foreground">
              Tune how <span className="font-medium text-foreground">Auto-generate</span> fills
              seats. Changes apply the next time you generate.
            </p>
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Assignment pattern</legend>
              <label
                className={`cursor-pointer rounded-md border p-3 ${scheduleMode === 'balanced' ? 'border-brand bg-brand/10 text-foreground' : 'border-border bg-background/40 text-muted-foreground'}`}
              >
                <span className="flex items-center gap-2 font-medium">
                  <input
                    data-testid="opt-mode-balanced"
                    type="radio"
                    name="assignment-pattern"
                    value="balanced"
                    checked={scheduleMode === 'balanced'}
                    onChange={() => setScheduleMode('balanced')}
                    className="size-4 accent-brand"
                  />
                  Balanced rotation
                </span>
                <span className="mt-1 block pl-6 text-xs text-muted-foreground">
                  Spread work evenly across the full schedule.
                </span>
              </label>
              <label
                className={`cursor-pointer rounded-md border p-3 ${scheduleMode === 'blocked' ? 'border-brand bg-brand/10 text-foreground' : 'border-border bg-background/40 text-muted-foreground'}`}
              >
                <span className="flex items-center gap-2 font-medium">
                  <input
                    data-testid="opt-mode-blocked"
                    type="radio"
                    name="assignment-pattern"
                    value="blocked"
                    checked={scheduleMode === 'blocked'}
                    onChange={() => setScheduleMode('blocked')}
                    className="size-4 accent-brand"
                  />
                  Work/rest blocks
                </span>
                <span className="mt-1 block pl-6 text-xs text-muted-foreground">
                  Give each scouter a defined work pattern, then a longer break.
                </span>
              </label>
            </fieldset>
            {scheduleMode === 'blocked' ? (
              <div className="rounded-md border border-border bg-background/40 p-3">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Block pattern
                </p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-2 leading-9">
                  <span>Work</span>
                  <Input
                    data-testid="opt-block-assignments"
                    type="number"
                    min={1}
                    max={99}
                    value={blockAssignments}
                    onChange={(e) =>
                      setBlockAssignments(Math.max(1, Number(e.target.value) || 1))
                    }
                    className="h-9 w-16 text-center font-mono"
                    aria-label="Assignments per work block"
                  />
                  <span>{blockAssignments === 1 ? 'assignment' : 'assignments'}, with</span>
                  <Input
                    data-testid="opt-spacing-matches"
                    type="number"
                    min={0}
                    max={99}
                    value={spacingMatches}
                    onChange={(e) => setSpacingMatches(Math.max(0, Number(e.target.value) || 0))}
                    className="h-9 w-16 text-center font-mono"
                    aria-label="Matches between assignments"
                  />
                  <span>
                    {spacingMatches === 1 ? 'match' : 'matches'} between each, then rest
                  </span>
                  <Input
                    data-testid="opt-rest-length"
                    type="number"
                    min={0}
                    max={99}
                    value={restLength}
                    onChange={(e) => setRestLength(Math.max(0, Number(e.target.value) || 0))}
                    className="h-9 w-16 text-center font-mono"
                    aria-label="Break length in matches"
                  />
                  <span>{restLength === 1 ? 'match' : 'matches'}.</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Spacing 0 allows consecutive matches; 1 means every other match; 2 means every
                  third match.
                </p>
              </div>
            ) : null}
            <label className="flex cursor-pointer items-center gap-2">
              <input
                data-testid="opt-rotate"
                type="checkbox"
                checked={rotatePositions}
                onChange={(e) => setRotatePositions(e.target.checked)}
                className="size-4 accent-brand"
              />
              <span>Rotate stations &amp; alliance colors across a scouter's matches</span>
            </label>
            {scheduleMode === 'balanced' ? (
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  data-testid="opt-avoid-b2b"
                  type="checkbox"
                  checked={avoidBackToBack}
                  onChange={(e) => setAvoidBackToBack(e.target.checked)}
                  className="size-4 accent-brand"
                />
                <span>Avoid back-to-back matches when there are enough scouters</span>
              </label>
            ) : null}
            <div className="rounded-md border border-border bg-background/40 p-3">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Match coverage
              </p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-2 leading-9">
                <span>Assign</span>
                <Input
                  data-testid="opt-coverage-percent"
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  value={coveragePercent}
                  onChange={(e) =>
                    setCoveragePercent(
                      Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))),
                    )
                  }
                  className="h-9 w-20 text-center font-mono"
                  aria-label="Percent of qualification matches to assign"
                />
                <span>% of qualification matches</span>
                {qualMatches.length > 0 ? (
                  <span data-testid="opt-coverage-preview" className="text-xs text-muted-foreground">
                    ({Math.round((qualMatches.length * coveragePercent) / 100)} of{' '}
                    {qualMatches.length})
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Below 100%, matches are picked so every team keeps the same share of its own
                matches scouted; the rest are left with every seat open.
              </p>
            </div>
            {days.length > 1 ? (
              <div
                data-testid="scouter-days"
                className="rounded-md border border-border bg-background/40 p-3"
              >
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Scouter days
                </p>
                <p className="mb-3 text-xs text-muted-foreground">
                  Uncheck a day to keep that scouter off every match scheduled for it.
                </p>
                {pool.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Scouters appear here once the pool is seeded from the roster.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground">
                          <th scope="col" className="pb-2 pr-3 text-left font-medium">
                            Scouter
                          </th>
                          {days.map((d) => (
                            <th
                              key={d.key}
                              scope="col"
                              className="pb-2 px-2 text-center font-medium"
                            >
                              {d.weekday}
                              <span className="block font-normal">
                                {d.date} · {d.matchKeys.length}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pool.map((sc) => {
                          const off = daysOff[sc.id] ?? [];
                          return (
                            <tr key={sc.id} className="border-t border-border/60">
                              <td className="py-1.5 pr-3">{sc.displayName}</td>
                              {days.map((d) => (
                                <td key={d.key} className="px-2 py-1.5 text-center">
                                  <input
                                    type="checkbox"
                                    data-testid="scouter-day-toggle"
                                    checked={!off.includes(d.key)}
                                    onChange={(e) => toggleDayOff(sc.id, d.key, e.target.checked)}
                                    className="size-4 accent-brand"
                                    aria-label={`${sc.displayName} available ${d.weekday}`}
                                  />
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        <p data-testid="assignments-quals-only-note" className="mt-3 text-xs text-muted-foreground">
          Assignments cover qualification matches only — playoff matches are not assigned.
        </p>
        {matches.length > 0 && qualMatches.length === 0 ? (
          <p data-testid="assignments-no-quals" className="mt-2 text-sm text-muted-foreground">
            No qualification matches in this event yet. Assignments are created only for quals.
          </p>
        ) : null}

        {error ? (
          <p data-testid="assignments-publish-error" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {generationWarning ? (
          <p
            data-testid="assignments-generation-warning"
            className="mt-4 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-warning"
          >
            {generationWarning}
          </p>
        ) : null}
        {generationNote ? (
          <p
            data-testid="assignments-generation-note"
            className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
          >
            {generationNote}
          </p>
        ) : null}
        {authorityIssue || verificationIssue ? (
          <div
            data-testid="assignments-authority-status"
            className="mt-4 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-warning sm:flex-row sm:items-center sm:justify-between"
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
          <p className="mt-4 text-sm text-muted-foreground">
            Loading authoritative assignment revision…
          </p>
        ) : null}
        {published !== null ? (
          <p data-testid="assignments-published" className="mt-4 text-sm text-success">
            Published {published} assignment{published === 1 ? '' : 's'}.
          </p>
        ) : null}

        {/* A SINGLE coverage panel. While a draft exists it's the source of
            truth (with the live-for-scouts state as a one-line note); before any
            draft it shows what scouts currently have. Previously two stacked
            panels showed the same seat count twice. */}
        {generated ? (
          <CoverageGapPanel
            summary={draftSummary}
            eventKey={eventKey}
            title="Coverage"
            diverged={diverged}
            liveNote={publishedLiveNote}
          />
        ) : (
          <CoverageGapPanel
            summary={publishedSummary}
            eventKey={eventKey}
            title="Coverage"
            empty={publishedMapped.length === 0}
          />
        )}

        {generated ? (
          <>
            {/* Scouter load — a live tally so the lead can balance by eye while
                hand-assigning. Idle scouters (0 matches) read muted. */}
            {pool.length > 0 ? (
              <div
                data-testid="scout-load"
                className="mt-4 flex flex-wrap items-center gap-1.5 text-xs"
              >
                <span className="mr-1 font-medium uppercase tracking-wide text-muted-foreground">
                  Load
                </span>
                {pool.map((sc) => {
                  const n = loadByScout.get(sc.id) ?? 0;
                  return (
                    <span
                      key={sc.id}
                      className={`rounded-full border px-2 py-0.5 ${
                        n === 0
                          ? 'border-border text-muted-foreground'
                          : 'border-brand/40 bg-brand/10 text-foreground'
                      }`}
                    >
                      {sc.displayName} · <span className="font-mono tabular-nums">{n}</span>
                    </span>
                  );
                })}
              </div>
            ) : null}

            <div className="mt-3 flex items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <input
                  data-testid="only-gaps-toggle"
                  type="checkbox"
                  checked={onlyGaps}
                  onChange={(e) => setOnlyGaps(e.target.checked)}
                  className="size-4 accent-brand"
                />
                Only matches with gaps
              </label>
              <span className="text-xs text-muted-foreground">
                {visibleMatches.length} match{visibleMatches.length === 1 ? '' : 'es'}
              </span>
            </div>

            <div
              data-testid="assignment-grid"
              className="relative mt-2 flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1"
            >
              {visibleMatches.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No matches with gaps — every seat is assigned.
                </p>
              ) : (
                visibleMatches.map((m) => (
                  <div
                    key={m.matchKey}
                    data-testid="match-assign-row"
                    data-coverage={m.gaps > 0 ? 'gap' : undefined}
                    className={`rounded-lg border p-3 ${
                      m.gaps > 0 ? 'border-l-4 border-l-amber-500/60' : ''
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="flex items-baseline gap-2">
                        <span className="font-semibold text-brand">{matchLabel(m.matchKey)}</span>
                        {days.length > 1 && dayByMatch.has(m.matchKey) ? (
                          <span className="text-xs text-muted-foreground">
                            {dayByMatch.get(m.matchKey)?.weekday}
                          </span>
                        ) : null}
                      </span>
                      <div className="flex items-center gap-2">
                        {m.gaps > 0 ? (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
                            {m.gaps} open
                          </span>
                        ) : (
                          <span className="text-xs font-medium text-success">covered</span>
                        )}
                        <button
                          type="button"
                          data-testid="clear-match-btn"
                          onClick={() => clearMatch(m.matchKey)}
                          className="text-xs text-muted-foreground hover:text-destructive"
                          aria-label={`Clear all seats for ${matchLabel(m.matchKey)}`}
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {m.seats.map((s) => {
                        const key = slotKey(s);
                        const current = picks[key] ?? '';
                        const isGap = current === '';
                        return (
                          <div
                            key={key}
                            className="flex items-center gap-2 text-sm"
                          >
                            <span
                              className={`w-20 shrink-0 rounded px-1.5 py-0.5 text-center font-mono ${
                                s.allianceColor === 'red'
                                  ? 'bg-red-500/15 text-red-400'
                                  : 'bg-blue-500/15 text-blue-400'
                              }`}
                            >
                              {s.targetTeamNumber}
                            </span>
                            <span className="w-7 shrink-0 font-mono text-xs text-muted-foreground">
                              {s.allianceColor[0].toUpperCase()}
                              {s.station}
                            </span>
                            <select
                              data-testid="slot-select"
                              value={current}
                              onChange={(e) => setSlot(key, e.target.value)}
                              className={`h-11 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm ${
                                isGap ? 'border-amber-500/50 text-muted-foreground' : ''
                              }`}
                              aria-label={`Scout for ${s.targetTeamNumber}`}
                            >
                              <option value="">— Unassigned —</option>
                              {pool.map((sc) => (
                                <option key={sc.id} value={sc.id}>
                                  {sc.displayName}
                                  {isOffForMatch(sc.id, m.matchKey) ? ' (off this day)' : ''}
                                </option>
                              ))}
                            </select>
                            {current ? (
                              <span className="sr-only">{nameById.get(current) ?? current}</span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default AssignmentBoard;
