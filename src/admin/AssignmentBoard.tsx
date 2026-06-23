import { useMemo, useState } from 'react';
import { autoAssign } from './autoAssign';
import { publishAssignments } from './setAssignmentsClient';
import type { AssignMatch, AssignScout, Assignment, AllianceColor } from './types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const OWN_TEAM = 3256;

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
  // scoutId per slotKey ('' === unassigned)
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const slots = useMemo<Slot[]>(() => {
    const out: Slot[] = [];
    for (const m of matches) {
      const teams: { color: AllianceColor; nums: [number, number, number] }[] = [
        { color: 'red', nums: m.redTeams },
        { color: 'blue', nums: m.blueTeams },
      ];
      for (const a of teams) {
        a.nums.forEach((team, i) => {
          if (team === OWN_TEAM) return;
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
  }, [matches]);

  function onAutoGenerate(): void {
    const result = autoAssign(matches, scouts, {
      ownTeam: OWN_TEAM,
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
    for (const s of scouts) map.set(s.id, s.displayName);
    return map;
  }, [scouts]);

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
            onClick={onAutoGenerate}
            disabled={matches.length === 0 || scouts.length === 0}
            className="h-11"
          >
            Auto-generate
          </Button>
          <Button
            type="button"
            data-testid="publish-assignments-btn"
            onClick={() => void onPublish()}
            disabled={busy || !generated}
            variant="secondary"
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
          <p data-testid="assignments-published" className="mt-4 text-sm text-emerald-400">
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
                  className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm"
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {s.matchKey.replace(`${eventKey}_`, '')}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono ${
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
                    className="ml-auto h-11 min-w-[8rem] rounded-md border bg-background px-2 text-sm"
                    aria-label={`Scout for ${s.targetTeamNumber}`}
                  >
                    <option value="">— Unassigned —</option>
                    {scouts.map((sc) => (
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
