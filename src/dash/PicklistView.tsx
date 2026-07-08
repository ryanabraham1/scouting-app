// src/dash/PicklistView.tsx
// Cluster PICKLIST (contracts §6 client, §8 export/testids).
// Editable, reorderable picklist backed by the shared staff-RLS'd `picklist`
// table. Loads on mount, edits live in local ordered state, and AUTOSAVE
// debounce-upserts the whole list after any change (no manual Save button).
// Rows reorder by drag-and-drop (grip handle) or the ↑/↓ buttons. JSON/CSV
// export via exportDash. Dark theme, shadcn primitives, 44px min touch targets.

import { useEffect, useMemo, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
  /** Open a team on the dashboard's Team tab (same deep-link as Ranking/Draft). */
  onSelectTeam?: (teamNumber: number) => void;
}

const TOUCH = 'min-h-[44px] min-w-[44px]';

/** Result of validating a typed team number against the event team list. */
export type AddTeamValidation =
  | { ok: true; teamNumber: number }
  | { ok: false; reason: string };

/**
 * Pure validation for the "add team" input (BUG-11). Rejects non-positive /
 * non-integer values, teams already on the picklist, and — crucially — any team
 * not present in the event's team list (`eventTeams`), which previously let a
 * bogus number like 99999 onto the picklist with no name. When `eventTeams` is
 * empty (team list still loading / unavailable) we DON'T gate on membership, so
 * the picklist stays usable offline rather than rejecting everything.
 */
export function validateAddTeam(
  raw: string,
  existing: ReadonlySet<number>,
  eventTeams: ReadonlySet<number>,
): AddTeamValidation {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, reason: 'Enter a valid team number.' };
  }
  if (existing.has(n)) {
    return { ok: false, reason: `Team ${n} is already on the picklist.` };
  }
  if (eventTeams.size > 0 && !eventTeams.has(n)) {
    return { ok: false, reason: `Team ${n} is not competing at this event.` };
  }
  return { ok: true, teamNumber: n };
}

interface PickRowProps {
  entry: PicklistEntry;
  index: number;
  total: number;
  onMove: (index: number, delta: number) => void;
  onRemove: (teamNumber: number) => void;
  onUpdateField: (teamNumber: number, field: 'tier' | 'note', value: string) => void;
  onCycleTier: (teamNumber: number) => void;
  onSelectTeam?: (teamNumber: number) => void;
}

/**
 * One picklist row, made sortable via dnd-kit (`useSortable`). The grip is the
 * drag activator (pointer + keyboard); the row translates with the live
 * transform so reordering is smooth. The ↑/↓ buttons remain as a non-drag
 * fallback. Pure presentational + the passed-in mutators.
 */
function SortablePickRow(props: PickRowProps): JSX.Element {
  const { entry: e, index: i, total, onMove, onRemove, onUpdateField, onCycleTier, onSelectTeam } =
    props;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: e.teamNumber });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`pick-row-${e.teamNumber}`}
      className={cn(
        'grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg border border-border/60 bg-background/40 p-2 sm:flex sm:flex-nowrap',
        isDragging && 'relative z-10 opacity-90 shadow-lg ring-1 ring-brand/50',
      )}
    >
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          data-testid={`pick-drag-${e.teamNumber}`}
          aria-label={`Drag team ${e.teamNumber} to reorder`}
          className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <GripVertical className="size-4" />
        </button>
        <span
          className={cn(
            'w-6 text-right tabular-nums',
            i < 3 ? 'font-semibold text-brand' : 'text-muted-foreground',
          )}
        >
          {i + 1}
        </span>
      </span>
      {onSelectTeam ? (
        <button
          type="button"
          data-testid={`pick-team-${e.teamNumber}`}
          onClick={() => onSelectTeam(e.teamNumber)}
          aria-label={`Open team ${e.teamNumber}`}
          className="inline-flex min-h-[44px] min-w-0 shrink-0 items-center rounded font-medium tabular-nums text-brand hover:text-brand/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:w-16"
        >
          {e.teamNumber}
        </button>
      ) : (
        <span className="min-w-0 shrink-0 font-medium tabular-nums sm:w-16">{e.teamNumber}</span>
      )}

      {/* Move / remove controls: a contained group so on mobile they sit together
          on their own grid row instead of wrapping the destructive ✕ off alone. */}
      <div className="col-start-3 row-span-2 flex shrink-0 items-center gap-1 sm:row-span-1 sm:contents">
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            data-testid={`pick-up-${e.teamNumber}`}
            onClick={() => onMove(i, -1)}
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
            onClick={() => onMove(i, 1)}
            disabled={i === total - 1}
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
          onClick={() => onRemove(e.teamNumber)}
          aria-label={`Remove team ${e.teamNumber}`}
          className="h-11 w-11 shrink-0 sm:order-last"
        >
          ✕
        </Button>
      </div>

      <Input
        type="text"
        data-testid={`pick-note-${e.teamNumber}`}
        value={e.note ?? ''}
        onChange={(ev) => onUpdateField(e.teamNumber, 'note', ev.target.value)}
        placeholder="Note"
        aria-label={`Note for team ${e.teamNumber}`}
        className="col-span-2 h-11 w-full min-w-0 sm:flex-1"
      />

      {/* Structured pick tier: 1st / 2nd / —. */}
      <div className="col-span-2 flex shrink-0 items-center gap-1 sm:col-span-1">
        <button
          type="button"
          data-testid={`pick-tier-type-${e.teamNumber}`}
          onClick={() => onCycleTier(e.teamNumber)}
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
      </div>
    </li>
  );
}

export default function PicklistView(props: PicklistViewProps): JSX.Element {
  const { eventKey, onSelectTeam } = props;

  const [entries, setEntries] = useState<PicklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addValue, setAddValue] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  // Autosave status (no manual Save button): the list persists itself ~debounced
  // after any edit. `idle` until the first change lands.
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [seedOpen, setSeedOpen] = useState(false);
  // JSON of the last-persisted (or freshly-loaded) entries, so the autosave
  // effect skips the post-load run and no-op re-saves.
  const lastSavedRef = useRef<string | null>(null);

  // dnd-kit sensors: pointer drag with a small activation distance (so taps on
  // the row's inputs/buttons still register), plus keyboard reordering for a11y.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
  // Membership set + nickname lookup for the add-team validation (BUG-11).
  const eventTeamSet = useMemo(() => new Set(teamNumbers), [teamNumbers]);
  const nameByTeam = useMemo(
    () => new Map(allTeams.map((t) => [t.team_number, t.nickname ?? null])),
    [allTeams],
  );
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

  // Split the entries: real ORDERED picks (the list you reorder) vs do-not-pick
  // markers. DNP teams aren't picks, so they're kept out of the ordered list and
  // appended on persist; they surface only as flags on the EPA board + draft.
  const picks = useMemo(() => entries.filter((e) => !(e.dnp ?? false)), [entries]);
  const dnpEntries = useMemo(() => entries.filter((e) => e.dnp ?? false), [entries]);
  // Teams already PICKED (drives the EPA board's added/disabled state).
  const inListTeams = useMemo(() => new Set(picks.map((e) => e.teamNumber)), [picks]);
  // Teams flagged do-not-pick (drives the EPA board's DNP toggle state).
  const dnpTeams = useMemo(() => new Set(dnpEntries.map((e) => e.teamNumber)), [dnpEntries]);

  // Live identity preview: the nickname of a valid, not-yet-added event team the
  // lead is currently typing (BUG-11: confirm the team exists before adding).
  const addPreviewName = useMemo(() => {
    const result = validateAddTeam(addValue, inListTeams, eventTeamSet);
    if (!result.ok) return null;
    return nameByTeam.get(result.teamNumber) ?? `Team ${result.teamNumber}`;
  }, [addValue, inListTeams, eventTeamSet, nameByTeam]);

  // Load the picklist on mount / event change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPicklist(eventKey)
      .then((loaded) => {
        if (cancelled) return;
        setEntries(loaded);
        // Baseline for autosave: the freshly-loaded list must NOT trigger a save.
        lastSavedRef.current = JSON.stringify(loaded);
        setSaveStatus('idle');
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        lastSavedRef.current = JSON.stringify([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventKey]);

  // Autosave: debounce-persist whenever the list changes from the last saved
  // snapshot. No manual Save button — edits land on their own. Skips while
  // loading and skips no-op re-saves (json === last saved).
  useEffect(() => {
    if (loading) return;
    const json = JSON.stringify(entries);
    if (json === lastSavedRef.current) return;
    const timer = setTimeout(() => {
      setSaveStatus('saving');
      setSaveError(null);
      savePicklist(eventKey, entries)
        .then(() => {
          lastSavedRef.current = json;
          setSaveStatus('saved');
        })
        .catch((err: unknown) => {
          setSaveError(err instanceof Error ? err.message : 'Failed to save picklist.');
          setSaveStatus('error');
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [entries, eventKey, loading]);

  // Edit entry point — autosave reacts to the resulting state change.
  function mutate(next: PicklistEntry[]): void {
    setEntries(next);
  }

  /**
   * Append a team to the picklist with the standard dedupe guard. Single source
   * of the add path so the text-input `addTeam` and the EPA board's one-tap add
   * share identical validation + dedupe (and both land dirty). Returns true when
   * a row was actually added.
   */
  function addTeamNumber(n: number): boolean {
    if (!Number.isInteger(n) || n <= 0) return false; // invalid
    const existing = entries.find((e) => e.teamNumber === n);
    if (existing && !(existing.dnp ?? false)) return false; // already a pick
    // A do-not-pick team being explicitly added flips to a pick (clears DNP).
    if (existing?.dnp) {
      mutate(entries.map((e) => (e.teamNumber === n ? { ...e, dnp: false } : e)));
      return true;
    }
    mutate([...entries, { teamNumber: n, tier: null, note: null }]);
    return true;
  }

  function addTeam(): void {
    const result = validateAddTeam(addValue, inListTeams, eventTeamSet);
    if (!result.ok) {
      setAddError(result.reason);
      return; // keep the typed value so the lead can correct it
    }
    addTeamNumber(result.teamNumber);
    setAddError(null);
    setAddValue('');
  }

  function removeTeam(teamNumber: number): void {
    mutate(entries.filter((e) => e.teamNumber !== teamNumber));
  }

  /**
   * Reorder within the ORDERED picks (`from`/`to` are indices into `picks`), then
   * persist picks + the untouched DNP markers appended. Shared by ↑/↓ and DnD.
   */
  function reorder(from: number, to: number): void {
    if (from === to) return;
    if (from < 0 || to < 0 || from >= picks.length || to >= picks.length) return;
    const next = [...picks];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    mutate([...next, ...dnpEntries]);
  }

  function move(index: number, delta: number): void {
    reorder(index, index + delta);
  }

  /** dnd-kit drop: reorder by the dragged/over team-number ids (within picks). */
  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = picks.findIndex((e) => e.teamNumber === active.id);
    const to = picks.findIndex((e) => e.teamNumber === over.id);
    if (from !== -1 && to !== -1) reorder(from, to);
  }

  function updateField(teamNumber: number, field: 'tier' | 'note', value: string): void {
    mutate(
      entries.map((e) =>
        e.teamNumber === teamNumber ? { ...e, [field]: value === '' ? null : value } : e,
      ),
    );
  }

  /**
   * Toggle a team's do-not-pick flag from the EPA board. A team not yet tracked
   * gets a DNP-only entry; clearing DNP removes that entry entirely (so it never
   * lingers as a phantom pick). A real pick is never DNP'd from the board (the
   * board hides the DNP control for picked teams), but the defensive branch keeps
   * the flag coherent if it ever is.
   */
  function toggleDnp(teamNumber: number): void {
    setEntries((prev) => {
      const existing = prev.find((e) => e.teamNumber === teamNumber);
      if (existing?.dnp) return prev.filter((e) => e.teamNumber !== teamNumber);
      if (existing) return prev.map((e) => (e.teamNumber === teamNumber ? { ...e, dnp: true } : e));
      return [...prev, { teamNumber, tier: null, note: null, tierType: null, dnp: true }];
    });
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
            {/* Autosave status — the list persists itself; no Save button. */}
            {saveStatus === 'saving' ? (
              <span data-testid="pick-saving" className="text-xs text-muted-foreground">
                Saving…
              </span>
            ) : saveStatus === 'saved' ? (
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
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              data-testid="pick-add-input"
              value={addValue}
              onChange={(e) => {
                setAddValue(e.target.value);
                if (addError) setAddError(null);
              }}
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
            {/* Live identity preview for a valid, not-yet-added event team. */}
            {addPreviewName ? (
              <span data-testid="pick-add-preview" className="text-sm text-muted-foreground">
                {addPreviewName}
              </span>
            ) : null}
            {addError ? (
              <span data-testid="pick-add-error" className="text-sm text-destructive">
                {addError}
              </span>
            ) : null}
          </div>

          {picks.length === 0 ? (
            <div data-testid="pick-empty" className="py-6 text-sm text-muted-foreground">
              No teams in the picklist yet. Add one above.
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={picks.map((e) => e.teamNumber)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="space-y-2">
                  {picks.map((e, i) => (
                    <SortablePickRow
                      key={e.teamNumber}
                      entry={e}
                      index={i}
                      total={picks.length}
                      onMove={move}
                      onRemove={removeTeam}
                      onUpdateField={updateField}
                      onCycleTier={cycleTier}
                      onSelectTeam={onSelectTeam}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </CardContent>
      </Card>

      <PicklistEpaBoard
        teams={allTeams}
        epa={epaQuery.data}
        aggByTeam={aggByTeam}
        inListTeams={inListTeams}
        onAdd={addTeamNumber}
        dnpTeams={dnpTeams}
        onToggleDnp={toggleDnp}
        onSelectTeam={onSelectTeam}
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
