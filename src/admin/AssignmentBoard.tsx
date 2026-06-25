import { useEffect, useMemo, useState } from 'react';
import { autoAssign } from './autoAssign';
import { publishAssignments } from './setAssignmentsClient';
import { ensureEventScoutsFromRoster } from './ensureEventScoutsClient';
import type { AssignMatch, AssignScout, Assignment, AllianceColor } from './types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';

interface Slot {
  matchKey: string;
  allianceColor: AllianceColor;
  station: 1 | 2 | 3;
  targetTeamNumber: number;
}

export interface AssignmentBoardProps {
  eventKey: string;
  matches: AssignMatch[];
  scouts: AssignScout[];
}

function slotKey(s: { matchKey: string; allianceColor: AllianceColor; station: number }): string {
  return `${s.matchKey}:${s.allianceColor}:${s.station}`;
}

export function AssignmentBoard({ eventKey, matches, scouts }: AssignmentBoardProps): JSX.Element {
  // The base/own team is never scouted (you don't scout yourself), so its slots
  // are excluded. Configurable in Setup; defaults to 3256.
  const ownTeam = getStoredBaseTeam();
  // scoutId per slotKey ('' === unassigned)
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const slots = useMemo<Slot[]>(() => {
    const out: Slot[] = [];
    for (const m of matches) {
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
  }, [matches, ownTeam]);

  function generateFrom(activePool: AssignScout[]): void {
    const result = autoAssign(matches, activePool, {
      ownTeam,
      breakEveryN: 6,
      rotatePositions: true,
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

  function setSlot(key: string, scoutId: string): void {
    setPicks((prev) => ({ ...prev, [key]: scoutId }));
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed.');
    } finally {
      setBusy(false);
    }
  }

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of pool) map.set(s.id, s.displayName);
    return map;
  }, [pool]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Assignments</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            data-testid="auto-generate-btn"
            onClick={() => void onAutoGenerate()}
            disabled={matches.length === 0 || seeding}
            variant="outline"
            className="h-11"
          >
            {seeding ? 'Loading scouters…' : 'Auto-generate'}
          </Button>
          <Button
            type="button"
            data-testid="publish-assignments-btn"
            onClick={() => void onPublish()}
            disabled={busy || !generated}
            variant="brand"
            className="h-11"
          >
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
        </div>

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

        {generated ? (
          <div data-testid="assignment-grid" className="mt-4 flex flex-col gap-2">
            {slots.map((s) => {
              const key = slotKey(s);
              const current = picks[key] ?? '';
              return (
                <div
                  key={key}
                  className="flex flex-col gap-2 rounded-lg border p-2 text-sm sm:flex-row sm:flex-wrap sm:items-center"
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {s.matchKey.replace(`${eventKey}_`, '')}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 font-mono ${
                      s.allianceColor === 'red'
                        ? 'bg-red-500/15 text-red-400'
                        : 'bg-blue-500/15 text-blue-400'
                    }`}
                  >
                    {s.targetTeamNumber} ({s.allianceColor[0].toUpperCase()}
                    {s.station})
                  </span>
                  <select
                    data-testid="slot-select"
                    value={current}
                    onChange={(e) => setSlot(key, e.target.value)}
                    className="h-11 w-full rounded-md border bg-background px-2 text-sm sm:ml-auto sm:w-auto sm:max-w-[12rem]"
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
        ) : null}
      </CardContent>
    </Card>
  );
}

export default AssignmentBoard;
