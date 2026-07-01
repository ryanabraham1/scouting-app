import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { autoAssign } from './autoAssign';
import { publishAssignments } from './setAssignmentsClient';
import { ensureEventScoutsFromRoster } from './ensureEventScoutsClient';
import type { AssignMatch, AssignScout, Assignment, AllianceColor } from './types';
import {
  computeCoverage,
  computeCoverageFromAssignments,
  slotKey,
  type Seat,
} from './coverage';
import { CoverageGapPanel } from './CoverageGapPanel';
import { useEventAssignments } from '@/dash/useEventData';
import { isQualMatchKey } from '@/lib/formatMatch';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Settings2, ChevronDown } from 'lucide-react';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';

type Slot = Seat;

export interface AssignmentBoardProps {
  eventKey: string;
  matches: AssignMatch[];
  scouts: AssignScout[];
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

  // Auto-generate tuning — surfaced to the lead so they control HOW seats get
  // filled, not just that they do.
  const [restEveryN, setRestEveryN] = useState(6);
  const [restLength, setRestLength] = useState(1);
  const [rotatePositions, setRotatePositions] = useState(true);
  const [avoidBackToBack, setAvoidBackToBack] = useState(true);
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
  }, [scouts]);

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
        if (!cancelled && seeded.length) setPool(seeded);
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

  // Published coverage — what scouts actually pull right now. The hook swallows
  // offline errors and returns [], so `rows` is always an array (never undefined).
  const { data: publishedRows } = useEventAssignments(eventKey);
  const publishedMapped = useMemo(
    () =>
      (publishedRows ?? []).map((r) => ({
        matchKey: r.match_key,
        allianceColor: r.alliance_color as AllianceColor,
        station: r.station,
        scoutId: r.scout_id,
      })),
    [publishedRows],
  );
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
    const result = autoAssign(qualMatches, activePool, {
      ownTeam,
      breakEveryN: restEveryN,
      breakLength: restLength,
      rotatePositions,
      avoidBackToBack,
    });
    const next: Record<string, string> = {};
    for (const a of result) {
      next[slotKey(a)] = a.scoutId;
    }
    setPicks(next);
    setGenerated(true);
    setPublished(null);
    setError(null);
  }

  async function onAutoGenerate(): Promise<void> {
    setError(null);
    // No per-event scouts checked in yet: seed the pool from the persistent
    // roster so the lead can assign before anyone has picked their name.
    if (pool.length === 0) {
      if (seeding) return;
      setSeeding(true);
      try {
        const seeded = await ensureEventScoutsFromRoster(eventKey);
        setPool(seeded);
        if (seeded.length === 0) {
          setError('No scouters on the roster yet. Add scouters in the Roster tab first.');
          return;
        }
        generateFrom(seeded);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load scouters.');
      } finally {
        setSeeding(false);
      }
      return;
    }
    generateFrom(pool);
  }

  // Open the board for hand-assignment WITHOUT auto-filling. Seeds from whatever
  // is already published so the lead keeps live assignments and edits from there;
  // starts blank if nothing is published yet.
  async function onStartManual(): Promise<void> {
    setError(null);
    if (pool.length === 0 && !seeding) {
      setSeeding(true);
      try {
        const seeded = await ensureEventScoutsFromRoster(eventKey);
        setPool(seeded);
        if (seeded.length === 0) {
          setError('No scouters on the roster yet. Add scouters in the Roster tab first.');
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load scouters.');
        return;
      } finally {
        setSeeding(false);
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
  }

  function setSlot(key: string, scoutId: string): void {
    setPicks((prev) => ({ ...prev, [key]: scoutId }));
  }

  // Clear every seat of one match in a single tap (manual-authoring aid).
  function clearMatch(matchKey: string): void {
    setPicks((prev) => {
      const next = { ...prev };
      for (const s of slots) {
        if (s.matchKey === matchKey) next[slotKey(s)] = '';
      }
      return next;
    });
  }

  async function onPublish(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPublished(null);
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
    try {
      const count = await publishAssignments(eventKey, assignments);
      setPublished(count);
      // Refresh the published panel + diverged flag immediately — otherwise they
      // keep showing pre-publish rows for the full staleTime window, leaving a
      // false "unpublished changes" note right after the lead JUST published.
      void queryClient.invalidateQueries({ queryKey: ['assignments', eventKey] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed.');
    } finally {
      setBusy(false);
    }
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
            disabled={qualMatches.length === 0 || seeding}
            variant="outline"
            className="h-11"
          >
            {seeding ? 'Loading scouters…' : generated ? 'Re-generate' : 'Auto-generate'}
          </Button>
          <Button
            type="button"
            data-testid="assign-manually-btn"
            onClick={() => void onStartManual()}
            disabled={qualMatches.length === 0 || seeding}
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
            disabled={busy || !generated}
            variant="brand"
            className="ml-auto h-11"
          >
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="min-w-[9rem]">Give each scouter a break</span>
              <label className="inline-flex items-center gap-1.5">
                every
                <Input
                  data-testid="opt-rest-every"
                  type="number"
                  min={0}
                  max={99}
                  value={restEveryN}
                  onChange={(e) => setRestEveryN(Math.max(0, Number(e.target.value) || 0))}
                  className="h-9 w-16 text-center font-mono"
                  aria-label="Break cadence (matches between breaks)"
                />
                matches,
              </label>
              <label className="inline-flex items-center gap-1.5">
                lasting
                <Input
                  data-testid="opt-rest-length"
                  type="number"
                  min={1}
                  max={99}
                  value={restLength}
                  onChange={(e) => setRestLength(Math.max(1, Number(e.target.value) || 1))}
                  disabled={restEveryN === 0}
                  className="h-9 w-16 text-center font-mono disabled:opacity-40"
                  aria-label="Break length (matches of rest)"
                />
                {restLength === 1 ? 'match' : 'matches'}
              </label>
              <span className="text-xs text-muted-foreground">(0 cadence = never rest)</span>
            </div>
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
                      <span className="font-semibold text-brand">{matchLabel(m.matchKey)}</span>
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
