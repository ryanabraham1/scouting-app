// src/dash/PicklistView.tsx
// Cluster PICKLIST (contracts §6 client, §8 export/testids).
// Editable, reorderable picklist backed by the shared staff-RLS'd `picklist`
// table. Loads on mount, edits live in local ordered state, and an explicit
// save upserts the whole list. JSON/CSV export via exportDash. Dark theme,
// shadcn primitives, 44px min touch targets.

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { getPicklist, savePicklist, type PicklistEntry } from '@/dash/picklistClient';
import { downloadText, picklistToCsv } from '@/dash/exportDash';
import { aggregateEvent, type TeamAgg } from '@/dash/aggregate';
import { useEventReports, useEventEpa, useEventMatches, useEventTeams } from '@/dash/useEventData';
import PicklistEpaBoard from '@/dash/PicklistEpaBoard';
import {
  buildPresetRows,
  allianceSheetToCsv,
  picklistToolCsv,
  allianceSheetToHtml,
  fetchTeamMetadata,
} from '@/dash/presetExports';
import { openPrintWindow } from '@/dash/printWindow';
import PicklistSeedDialog from '@/dash/PicklistSeedDialog';

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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [seedOpen, setSeedOpen] = useState(false);

  // Export-preset supporting data. These hooks run on render (cheap, cached by
  // TanStack Query, shared with RankingView's cache keys); only fetchTeamMetadata
  // is lazy/on-click. EPA carries the per-team `sourceByTeam` map (§4.0) for a
  // correct per-row epa_source.
  const reportsQuery = useEventReports(eventKey);
  const aggByTeam = useMemo(
    () => (reportsQuery.data ? aggregateEvent(reportsQuery.data) : new Map<number, TeamAgg>()),
    [reportsQuery.data],
  );
  // EPA over EVERY event team (the Team EPA Board ranks all of them; the picklist
  // teams are a subset, so the export-preset lookup is still fully covered).
  const teamsQuery = useEventTeams(eventKey);
  const allTeams = useMemo(() => teamsQuery.data ?? [], [teamsQuery.data]);
  const teamNumbers = useMemo(() => allTeams.map((t) => t.team_number), [allTeams]);
  const matchesQuery = useEventMatches(eventKey);
  // The third arg is accepted-but-UNUSED (EPA is season-wide); passed only for
  // call-site parity with RankingView/NextMatchView so the shared query key stays
  // consistent.
  const epaQuery = useEventEpa(teamNumbers, eventKey, matchesQuery.data ?? []);

  const epaAvailable = epaQuery.data?.available === true;
  const epaSource = epaQuery.data?.source ?? 'none';
  const epaByTeam = epaQuery.data?.epaByTeam;

  // Every aggregated team (for the seed dialog — distinct from `aggByTeam`,
  // which is keyed for the per-row export lookup). Cheap; reuses the same cache.
  const aggs = useMemo<TeamAgg[]>(() => Array.from(aggByTeam.values()), [aggByTeam]);

  // Teams already on the picklist — drives the EPA board's added/disabled state.
  const inListTeams = useMemo(
    () => new Set(entries.map((e) => e.teamNumber)),
    [entries],
  );

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

  /**
   * Append a team to the picklist with the standard dedupe guard. Single source
   * of the add path so the text-input `addTeam` and the EPA board's one-tap add
   * share identical validation + dedupe (and both land dirty). Returns true when
   * a row was actually added.
   */
  function addTeamNumber(n: number): boolean {
    if (!Number.isInteger(n) || n <= 0) return false; // invalid
    if (entries.some((e) => e.teamNumber === n)) return false; // duplicate
    mutate([...entries, { teamNumber: n, tier: null, note: null }]);
    return true;
  }

  function addTeam(): void {
    addTeamNumber(Number(addValue.trim()));
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

  /** Toggle the per-row DNP / avoid flag (independent of tier). */
  function toggleDnp(teamNumber: number): void {
    mutate(
      entries.map((e) =>
        e.teamNumber === teamNumber ? { ...e, dnp: !(e.dnp ?? false) } : e,
      ),
    );
  }

  /** Cycle the structured pick tier: — → 1st → 2nd → —. */
  function cycleTier(teamNumber: number): void {
    mutate(
      entries.map((e) => {
        if (e.teamNumber !== teamNumber) return e;
        const cur = e.tierType ?? null;
        const next = cur === null ? 'first' : cur === 'first' ? 'second' : null;
        return { ...e, tierType: next };
      }),
    );
  }

  /**
   * Seed from the dialog. Replace swaps the whole list; append keeps the current
   * entries and adds only the seeded teams not already present (preserving the
   * seeded order). Lands dirty (like a manual edit) — the lead reviews + Saves.
   */
  function handleSeed(seeded: PicklistEntry[], mode: 'replace' | 'append'): void {
    if (mode === 'replace') {
      mutate(seeded);
    } else {
      const have = new Set(entries.map((e) => e.teamNumber));
      mutate([...entries, ...seeded.filter((e) => !have.has(e.teamNumber))]);
    }
    setSeedOpen(false);
  }

  async function onSave(): Promise<void> {
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      await savePicklist(eventKey, entries);
      setSaved(true);
    } catch (err) {
      // Without this, a failed save was a silent unhandled rejection — the lead
      // thought the picklist saved when it didn't. Surface it so they can retry.
      setSaveError(err instanceof Error ? err.message : 'Failed to save picklist.');
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

  /**
   * Lazily fetch team identity, build the preset rows from the current in-memory
   * (possibly unsaved) order + cached aggregates/EPA, then hand them to the given
   * emit callback. Degrades gracefully: metadata errors blank the identity
   * columns; the export still proceeds.
   */
  async function runPreset(emit: (rows: ReturnType<typeof buildPresetRows>) => void): Promise<void> {
    if (entries.length === 0) return;
    setExporting(true);
    setExportError(null);
    try {
      const metaByTeam = await fetchTeamMetadata(teamNumbers);
      const rows = buildPresetRows(
        entries,
        aggByTeam,
        epaQuery.data?.epaByTeam ?? new Map(),
        epaAvailable,
        epaSource,
        metaByTeam,
        epaQuery.data?.sourceByTeam,
      );
      emit(rows);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Failed to build export.');
    } finally {
      setExporting(false);
    }
  }

  function onExportAllianceCsv(): void {
    void runPreset((rows) =>
      downloadText(`alliance-sheet-${eventKey}.csv`, 'text/csv', allianceSheetToCsv(rows, eventKey)),
    );
  }

  function onExportToolCsv(): void {
    void runPreset((rows) =>
      downloadText(`picklist-tool-${eventKey}.csv`, 'text/csv', picklistToolCsv(rows)),
    );
  }

  function onExportAlliancePrint(): void {
    void runPreset((rows) => openPrintWindow(allianceSheetToHtml(rows, eventKey, epaSource)));
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
            {saveError ? (
              <span data-testid="pick-save-error" className="text-xs text-destructive">
                {saveError}
              </span>
            ) : null}
            {exportError ? (
              <span data-testid="pick-export-error" className="text-xs text-destructive">
                {exportError}
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              data-testid="pick-seed-open"
              onClick={() => setSeedOpen(true)}
              className={TOUCH}
            >
              Seed
            </Button>
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
            <div data-testid="pick-export-presets" className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                data-testid="pick-export-alliance-csv"
                onClick={onExportAllianceCsv}
                disabled={exporting || entries.length === 0}
                className={TOUCH}
              >
                {exporting ? 'Working…' : 'Alliance Sheet (CSV)'}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-testid="pick-export-alliance-print"
                onClick={onExportAlliancePrint}
                disabled={exporting || entries.length === 0}
                className={TOUCH}
              >
                {exporting ? 'Working…' : 'Alliance Sheet (Print)'}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-testid="pick-export-tool-csv"
                onClick={onExportToolCsv}
                disabled={exporting || entries.length === 0}
                className={TOUCH}
              >
                {exporting ? 'Working…' : 'Picklist Tool (CSV)'}
              </Button>
            </div>
          </div>
        </CardHeader>
        {epaSource !== 'statbotics' ? (
          <div
            data-testid="pick-export-epa-banner"
            className="px-6 pb-2 text-xs text-warning"
          >
            {epaSource === 'local'
              ? 'Statbotics offline — exported EPA shows a local estimate computed from match results.'
              : 'Statbotics & match-result EPA unavailable — exported EPA shows our in-house estimate from scouting data.'}
          </div>
        ) : null}
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
                  <span
                    className={cn(
                      'min-w-0 shrink-0 font-medium tabular-nums sm:w-16',
                      (e.dnp ?? false) && 'line-through opacity-60',
                    )}
                  >
                    {e.teamNumber}
                    {(e.dnp ?? false) ? (
                      <span
                        data-testid={`pick-dnp-badge-${e.teamNumber}`}
                        className="ml-1 inline-flex items-center rounded-full bg-destructive/20 px-1.5 py-0.5 text-[10px] font-medium text-destructive no-underline"
                      >
                        DNP
                      </span>
                    ) : null}
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

                  {/* Coaching flags: structured pick-tier pill + DNP toggle. */}
                  <div className="col-span-2 flex shrink-0 items-center gap-1 sm:col-span-1">
                    <button
                      type="button"
                      data-testid={`pick-tier-type-${e.teamNumber}`}
                      onClick={() => cycleTier(e.teamNumber)}
                      aria-label={`Pick tier for team ${e.teamNumber}`}
                      className={cn(
                        'inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border px-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                        (e.tierType ?? null) === 'first'
                          ? 'border-brand bg-brand/20 text-brand'
                          : (e.tierType ?? null) === 'second'
                            ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                            : 'border-border text-muted-foreground',
                      )}
                    >
                      {(e.tierType ?? null) === 'first'
                        ? '1st'
                        : (e.tierType ?? null) === 'second'
                          ? '2nd'
                          : '—'}
                    </button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      data-testid={`pick-dnp-${e.teamNumber}`}
                      aria-pressed={e.dnp ?? false}
                      aria-label={`DNP for team ${e.teamNumber}`}
                      onClick={() => toggleDnp(e.teamNumber)}
                      className={cn(
                        'h-11 w-11',
                        (e.dnp ?? false) && 'border-destructive bg-destructive/20 text-destructive',
                      )}
                    >
                      ✋
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <PicklistEpaBoard
        teams={allTeams}
        epa={epaQuery.data}
        aggByTeam={aggByTeam}
        inListTeams={inListTeams}
        onAdd={addTeamNumber}
      />

      <PicklistSeedDialog
        open={seedOpen}
        aggs={aggs}
        epaByTeam={epaByTeam}
        epaAvailable={epaAvailable}
        onSeed={handleSeed}
        onClose={() => setSeedOpen(false)}
      />
    </div>
  );
}
