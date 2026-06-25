// src/dash/PicklistView.tsx
// Cluster PICKLIST (contracts §6 client, §8 export/testids).
// Editable, reorderable picklist backed by the shared staff-RLS'd `picklist`
// table. Loads on mount, edits live in local ordered state, and an explicit
// save upserts the whole list. JSON/CSV export via exportDash. Dark theme,
// shadcn primitives, 44px min touch targets.

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { getPicklist, savePicklist, type PicklistEntry } from '@/dash/picklistClient';
import { downloadText, picklistToCsv } from '@/dash/exportDash';

export interface PicklistViewProps {
  eventKey: string;
}

const TOUCH = 'min-h-[44px] min-w-[44px]';

export default function PicklistView(props: PicklistViewProps): JSX.Element {
  const { eventKey } = props;

  const [entries, setEntries] = useState<PicklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addValue, setAddValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load the picklist on mount / event change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPicklist(eventKey)
      .then((loaded) => {
        if (!cancelled) setEntries(loaded);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventKey]);

  // Any edit invalidates the "saved" indicator.
  function mutate(next: PicklistEntry[]): void {
    setEntries(next);
    setSaved(false);
  }

  function addTeam(): void {
    const n = Number(addValue.trim());
    if (!Number.isInteger(n) || n <= 0) return; // invalid
    if (entries.some((e) => e.teamNumber === n)) {
      setAddValue('');
      return; // duplicate
    }
    mutate([...entries, { teamNumber: n, tier: null, note: null }]);
    setAddValue('');
  }

  function removeTeam(teamNumber: number): void {
    mutate(entries.filter((e) => e.teamNumber !== teamNumber));
  }

  function move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    const next = [...entries];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    mutate(next);
  }

  function updateField(teamNumber: number, field: 'tier' | 'note', value: string): void {
    mutate(
      entries.map((e) =>
        e.teamNumber === teamNumber ? { ...e, [field]: value === '' ? null : value } : e,
      ),
    );
  }

  async function onSave(): Promise<void> {
    setSaving(true);
    setSaved(false);
    try {
      await savePicklist(eventKey, entries);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  function onExportJson(): void {
    downloadText(
      `picklist-${eventKey}.json`,
      'application/json',
      JSON.stringify(entries, null, 2),
    );
  }

  function onExportCsv(): void {
    downloadText(`picklist-${eventKey}.csv`, 'text/csv', picklistToCsv(entries));
  }

  // --- render ---------------------------------------------------------------
  if (loading) {
    return (
      <div data-testid="dash-picklist" className="text-foreground">
        <Card className="bg-card">
          <CardContent className="p-6">
            <div data-testid="pick-loading" className="text-sm text-muted-foreground">
              Loading picklist…
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div data-testid="dash-picklist" className="space-y-4 text-foreground">
      <Card className="bg-card">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle>Picklist</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {saved ? (
              <span data-testid="pick-saved" className="text-xs text-success">
                Saved
              </span>
            ) : null}
            <Button
              type="button"
              data-testid="pick-save"
              onClick={() => void onSave()}
              disabled={saving}
              className={TOUCH}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="pick-export-json"
              onClick={onExportJson}
              className={TOUCH}
            >
              Export JSON
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="pick-export-csv"
              onClick={onExportCsv}
              className={TOUCH}
            >
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Add a team */}
          <div className="flex items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              data-testid="pick-add-input"
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTeam();
                }
              }}
              placeholder="Team #"
              aria-label="Team number to add"
              className="h-11 max-w-[8rem]"
            />
            <Button type="button" data-testid="pick-add" onClick={addTeam} className={TOUCH}>
              Add
            </Button>
          </div>

          {entries.length === 0 ? (
            <div data-testid="pick-empty" className="py-6 text-sm text-muted-foreground">
              No teams in the picklist yet. Add one above.
            </div>
          ) : (
            <ul className="space-y-2">
              {entries.map((e, i) => (
                <li
                  key={e.teamNumber}
                  data-testid={`pick-row-${e.teamNumber}`}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg border border-border/60 bg-background/40 p-2 sm:flex sm:flex-nowrap"
                >
                  <span
                    className={cn(
                      'w-6 shrink-0 text-right tabular-nums',
                      i < 3 ? 'font-semibold text-brand' : 'text-muted-foreground',
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 shrink-0 font-medium tabular-nums sm:w-16">
                    {e.teamNumber}
                  </span>

                  {/* Move / remove controls: a contained group so on mobile they
                      sit together on their own grid row instead of wrapping the
                      destructive ✕ off on its own line. */}
                  <div className="col-start-3 row-span-2 flex shrink-0 items-center gap-1 sm:row-span-1 sm:contents">
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        data-testid={`pick-up-${e.teamNumber}`}
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        aria-label={`Move team ${e.teamNumber} up`}
                        className="h-11 w-11"
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        data-testid={`pick-down-${e.teamNumber}`}
                        onClick={() => move(i, 1)}
                        disabled={i === entries.length - 1}
                        aria-label={`Move team ${e.teamNumber} down`}
                        className="h-11 w-11"
                      >
                        ↓
                      </Button>
                    </div>
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon"
                      data-testid={`pick-remove-${e.teamNumber}`}
                      onClick={() => removeTeam(e.teamNumber)}
                      aria-label={`Remove team ${e.teamNumber}`}
                      className="h-11 w-11 shrink-0 sm:order-last"
                    >
                      ✕
                    </Button>
                  </div>

                  <Input
                    type="text"
                    data-testid={`pick-tier-${e.teamNumber}`}
                    value={e.tier ?? ''}
                    onChange={(ev) => updateField(e.teamNumber, 'tier', ev.target.value)}
                    placeholder="Tier"
                    aria-label={`Tier for team ${e.teamNumber}`}
                    className="col-span-2 h-11 w-full sm:w-20"
                  />
                  <Input
                    type="text"
                    data-testid={`pick-note-${e.teamNumber}`}
                    value={e.note ?? ''}
                    onChange={(ev) => updateField(e.teamNumber, 'note', ev.target.value)}
                    placeholder="Note"
                    aria-label={`Note for team ${e.teamNumber}`}
                    className="col-span-2 h-11 w-full min-w-0 sm:flex-1"
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
