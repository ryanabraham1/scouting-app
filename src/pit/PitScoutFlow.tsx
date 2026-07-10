// src/pit/PitScoutFlow.tsx — the inline pit-scouting flow (team picker → form),
// shared by the /scout?mode=pit toggle (ScoutHome) and the legacy PitRoute.
// It takes an already-resolved scout identity + active event, so the user never
// re-picks their name when switching into pit mode.
import { useEffect, useState } from 'react';
import {
  ClipboardCheck,
  FileDown,
  Hash,
  History,
  ShieldAlert,
  Trash2,
  Wrench,
} from 'lucide-react';
import PitScoutScreen from './PitScoutScreen';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { getCachedPitAssignmentsForEvent, getCachedTeams } from '@/db/preloadClient';
import { supabase } from '@/lib/supabase';
import {
  deletePitQuarantine,
  PIT_NUMERIC_LIMITS,
  listPitDraftsForEvent,
  listPitQuarantine,
  listPitReportsForEvent,
  type PitDraft,
  type PitQuarantinedRecord,
} from './pitStore';

export interface PitScoutFlowProps {
  eventKey: string;
  scoutId: string;
  initialTeamNumber?: number | null;
}

interface TeamOption {
  team_number: number;
  nickname: string | null;
}

/**
 * Load this event's team list for the pit-picker autocomplete. Local-first: the
 * offline preload cache answers instantly (and works with no network); when it's
 * empty (never preloaded) we fall back to the same `event_team → team` query the
 * dashboard uses. Best-effort — a failure just leaves the numeric input working
 * without suggestions.
 */
function useEventTeamOptions(eventKey: string): TeamOption[] {
  const [teams, setTeams] = useState<TeamOption[]>([]);
  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;
    void (async () => {
      // The cache read gets its own try: on devices where IndexedDB is broken
      // (Safari private mode etc.) it can throw, and it must fall THROUGH to
      // the network query rather than reject the whole IIFE unhandled —
      // those degraded devices are exactly who the fallback exists for.
      try {
        const cached = await getCachedTeams(eventKey);
        if (!cancelled && cached.length) {
          setTeams(cached.map((t) => ({ team_number: t.team_number, nickname: t.nickname })));
          return;
        }
      } catch {
        /* cache unavailable — fall through to the network */
      }
      try {
        const res = await supabase
          .from('event_team')
          .select('team:team(team_number,nickname)')
          .eq('event_key', eventKey);
        const nested =
          (res.data as unknown as Array<{ team: TeamOption | null }> | null) ?? [];
        const rows = nested
          .map((r) => r.team)
          .filter((t): t is TeamOption => t != null)
          .sort((a, b) => a.team_number - b.team_number);
        if (!cancelled) setTeams(rows);
      } catch {
        /* offline / no data — numeric input still works without suggestions */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventKey]);
  return teams;
}

interface PitCrewRow {
  teamNumber: number;
  scoutId: string;
  scoutName: string | null;
}

interface MyPitAssignment {
  teamNumber: number;
  crewSize: number;
  partnerNames: string[];
}

function assignmentsForScout(rows: PitCrewRow[], scoutId: string): MyPitAssignment[] {
  const assignedTeams = new Set(
    rows.filter((row) => row.scoutId === scoutId).map((row) => row.teamNumber),
  );
  return [...assignedTeams]
    .sort((a, b) => a - b)
    .map((teamNumber) => {
      const crew = rows.filter((row) => row.teamNumber === teamNumber);
      return {
        teamNumber,
        crewSize: crew.length,
        partnerNames: [
          ...new Set(
            crew
              .filter((row) => row.scoutId !== scoutId && row.scoutName)
              .map((row) => row.scoutName as string),
          ),
        ],
      };
    });
}

function useMyPitAssignments(eventKey: string, scoutId: string): MyPitAssignment[] {
  const [assignments, setAssignments] = useState<MyPitAssignment[]>([]);
  useEffect(() => {
    if (!eventKey || !scoutId) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const cached = await getCachedPitAssignmentsForEvent(eventKey);
        const eventRows = cached.map((row) => ({
          teamNumber: row.team_number,
          scoutId: row.scout_id,
          scoutName: row.scout_name ?? null,
        }));
        if (!cancelled && eventRows.length) {
          setAssignments(assignmentsForScout(eventRows, scoutId));
        }
      } catch {
        /* cache unavailable — continue to network */
      }
      try {
        const { data, error } = await supabase
          .from('pit_assignment')
          .select('team_number,scout_id,scout:scout(display_name)')
          .eq('event_key', eventKey)
          .order('team_number', { ascending: true });
        if (error) throw error;
        if (!cancelled) {
          const rows = ((data ?? []) as unknown as Array<{
            team_number: number;
            scout_id: string;
            scout: { display_name: string | null } | null;
          }>).map((row) => ({
            teamNumber: row.team_number,
            scoutId: row.scout_id,
            scoutName: row.scout?.display_name ?? null,
          }));
          setAssignments(assignmentsForScout(rows, scoutId));
        }
      } catch {
        /* keep cached assignments while offline */
      }
    };
    void refresh();
    const refreshVisible = (): void => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    const interval = window.setInterval(refreshVisible, 30_000);
    window.addEventListener('focus', refreshVisible);
    window.addEventListener('preload-cache-changed', refreshVisible);
    const realtimeClient = supabase as typeof supabase & {
      channel?: (name: string) => {
        on: (...args: unknown[]) => { subscribe: () => unknown };
        subscribe: () => unknown;
      };
      removeChannel?: (channel: unknown) => Promise<unknown>;
    };
    const realtime = realtimeClient.channel?.(`pit-assignments:${eventKey}:${scoutId}`);
    realtime
      ?.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pit_assignment', filter: `event_key=eq.${eventKey}` },
        refreshVisible,
      )
      .subscribe();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisible);
      window.removeEventListener('preload-cache-changed', refreshVisible);
      if (realtime) void realtimeClient.removeChannel?.(realtime);
    };
  }, [eventKey, scoutId]);
  return assignments;
}

type PitTeamStatus = 'assigned' | 'draft' | 'queued' | 'submitted' | 'error';

function usePitTeamStatuses(eventKey: string): Map<number, PitTeamStatus> {
  const [statuses, setStatuses] = useState<Map<number, PitTeamStatus>>(new Map());
  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;
    const refresh = async () => {
      const next = new Map<number, PitTeamStatus>();
      try {
        const { data } = await supabase
          .from('pit_scouting_report')
          .select('team_number')
          .eq('event_key', eventKey)
          .eq('deleted', false);
        for (const row of (data ?? []) as Array<{ team_number: number }>) {
          next.set(row.team_number, 'submitted');
        }
      } catch {
        /* local state below is sufficient while offline */
      }
      try {
        const [drafts, reports] = await Promise.all([
          listPitDraftsForEvent(eventKey),
          listPitReportsForEvent(eventKey),
        ]);
        for (const draft of drafts) next.set(draft.teamNumber, 'draft');
        for (const report of reports) {
          next.set(
            report.teamNumber,
            report.syncState === 'synced'
              ? 'submitted'
              : report.syncState === 'error'
                ? 'error'
                : 'queued',
          );
        }
      } catch {
        /* IndexedDB unavailable */
      }
      if (!cancelled) setStatuses(next);
    };
    void refresh();
    window.addEventListener('scout-sync-changed', refresh);
    window.addEventListener('pit-local-changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('scout-sync-changed', refresh);
      window.removeEventListener('pit-local-changed', refresh);
    };
  }, [eventKey]);
  return statuses;
}

function usePitRecoveryRecords(eventKey: string): {
  drafts: PitDraft[];
  quarantined: PitQuarantinedRecord[];
} {
  const [drafts, setDrafts] = useState<PitDraft[]>([]);
  const [quarantined, setQuarantined] = useState<PitQuarantinedRecord[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        // Listing drafts performs validation and moves malformed rows into the
        // quarantine table before we list that table.
        const nextDrafts = await listPitDraftsForEvent(eventKey);
        const nextQuarantined = await listPitQuarantine(eventKey);
        if (!cancelled) {
          setDrafts(nextDrafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
          setQuarantined(nextQuarantined);
        }
      } catch {
        // The pit screen itself surfaces storage failures when opened.
      }
    };
    void refresh();
    window.addEventListener('pit-local-changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('pit-local-changed', refresh);
    };
  }, [eventKey]);
  return { drafts, quarantined };
}

/**
 * Pit-scouting flow with a single implementation. Renders a big team-number
 * picker; once a valid team is chosen it mounts <PitScoutScreen> for that team.
 * A "change team" affordance lets the scout return to the picker for the next
 * robot without leaving pit mode.
 */
export default function PitScoutFlow({
  eventKey,
  scoutId,
  initialTeamNumber = null,
}: PitScoutFlowProps): JSX.Element {
  const [teamInput, setTeamInput] = useState('');
  const [team, setTeam] = useState<number | null>(initialTeamNumber);
  // Whether the autocomplete list is open (input focused). Selecting a team or
  // blurring closes it.
  const [open, setOpen] = useState(false);
  const [activeOption, setActiveOption] = useState(-1);
  const [storageProtected, setStorageProtected] = useState(false);
  const teamOptions = useEventTeamOptions(eventKey);
  const assignedTeams = useMyPitAssignments(eventKey, scoutId);
  const teamStatuses = usePitTeamStatuses(eventKey);
  const recovery = usePitRecoveryRecords(eventKey);

  const exportQuarantine = (record: PitQuarantinedRecord): void => {
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `pit-recovery-${record.originalKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (initialTeamNumber != null && initialTeamNumber > 0) setTeam(initialTeamNumber);
  }, [initialTeamNumber]);
  useEffect(() => {
    setTeam(initialTeamNumber != null && initialTeamNumber > 0 ? initialTeamNumber : null);
    setTeamInput('');
    setOpen(false);
    setActiveOption(-1);
  }, [eventKey]);

  if (!eventKey) {
    return (
      <section
        data-testid="pit-flow"
        className="mx-auto flex w-full max-w-5xl flex-col gap-3"
      >
        <p data-testid="pit-no-event" className="text-muted-foreground">
          No active event yet. Ask your scouting lead to set the active event.
        </p>
      </section>
    );
  }

  if (team === null) {
    const trimmed = teamInput.trim();
    const parsedTeam = Number(trimmed);
    const valid =
      /^\d+$/.test(trimmed) &&
      Number.isSafeInteger(parsedTeam) &&
      parsedTeam > 0 &&
      parsedTeam <= PIT_NUMERIC_LIMITS.teamNumber;
    const q = trimmed.toLowerCase();
    // Live suggestions: filter as soon as the scout starts typing. A digit query
    // matches team numbers by PREFIX (typing "2" → 254, 2643, 2854…); any query
    // also matches nicknames by substring. Empty + focused shows the roster to
    // browse. Capped so a big event's list stays snappy.
    const suggestions = (
      q === ''
        ? teamOptions
        : teamOptions.filter(
            (t) =>
              String(t.team_number).startsWith(q) ||
              (t.nickname ?? '').toLowerCase().includes(q),
          )
    ).slice(0, 8);
    const matched = valid
      ? teamOptions.find((t) => t.team_number === parsedTeam)
      : undefined;
    const canStart = valid && (teamOptions.length === 0 || Boolean(matched));
    const choose = (n: number): void => {
      setTeamInput(String(n));
      setOpen(false);
    };
    return (
      <section
        data-testid="pit-flow"
        className="mx-auto flex w-full max-w-5xl flex-col gap-5"
      >
        <div className="flex items-center gap-2">
          <Wrench className="size-6 text-brand" />
          <h2 className="text-xl font-semibold">Pit scouting</h2>
        </div>
        {recovery.quarantined.length > 0 ? (
          <section
            data-testid="pit-quarantine"
            className="flex flex-col gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 p-4"
          >
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-5 shrink-0 text-destructive" />
              <h3 className="font-semibold">Saved pit data needs recovery</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Malformed saved data was isolated instead of being overwritten. Export a copy
              before deleting it.
            </p>
            {recovery.quarantined.map((record) => (
              <div
                key={record.id}
                className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">
                    {record.teamNumber ? `Team ${record.teamNumber}` : record.originalKey}
                  </p>
                  <p className="text-xs text-destructive [overflow-wrap:anywhere]">
                    {record.reason}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => exportQuarantine(record)}>
                    <FileDown className="size-4" /> Export
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => {
                      void deletePitQuarantine(record.id).then(() => {
                        window.dispatchEvent(new Event('pit-local-changed'));
                      });
                    }}
                  >
                    <Trash2 className="size-4" /> Delete
                  </Button>
                </div>
              </div>
            ))}
          </section>
        ) : null}
        {recovery.drafts.length > 0 ? (
          <section
            data-testid="pit-saved-drafts"
            className="flex flex-col gap-2 rounded-2xl border border-warning/40 bg-warning/5 p-4"
          >
            <div className="flex items-center gap-2">
              <History className="size-5 text-warning" />
              <h3 className="font-semibold">Continue saved pit drafts</h3>
              <span className="ml-auto rounded-full bg-warning/15 px-2 py-0.5 font-mono text-xs text-warning">
                {recovery.drafts.length}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {recovery.drafts.map((draft) => (
                <button
                  key={draft.draftKey}
                  type="button"
                  data-testid={`pit-draft-${draft.teamNumber}`}
                  onClick={() => setTeam(draft.teamNumber)}
                  className="flex min-h-12 items-center justify-between rounded-xl border border-border bg-card px-3 text-left hover:border-warning/50 hover:bg-accent"
                >
                  <span className="font-mono text-lg font-semibold text-warning">
                    Team {draft.teamNumber}
                  </span>
                  <span className="text-xs font-medium text-warning">Continue</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        <div
          data-testid="pit-start-layout"
          className={
            assignedTeams.length > 0
              ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.48fr)] lg:items-start'
              : ''
          }
        >
          {assignedTeams.length > 0 ? (
            <div
              data-testid="my-pit-assignments"
              className="flex flex-col gap-2 rounded-2xl border border-brand/30 bg-brand/5 p-4"
            >
              <div className="flex items-center gap-2">
                <ClipboardCheck className="size-5 text-brand" />
                <h3 className="font-semibold">Your pit assignments</h3>
                <span className="ml-auto rounded-full bg-brand/15 px-2 py-0.5 font-mono text-xs text-brand">
                  {assignedTeams.length}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {assignedTeams.map((assignment) => {
                  const { teamNumber } = assignment;
                  const option = teamOptions.find((item) => item.team_number === teamNumber);
                  const assignmentStatus = teamStatuses.get(teamNumber) ?? 'assigned';
                  const statusLabel =
                    assignmentStatus === 'assigned'
                      ? 'Start'
                      : assignmentStatus === 'draft'
                        ? 'Continue'
                        : assignmentStatus === 'queued'
                          ? 'Queued'
                          : assignmentStatus === 'error'
                            ? 'Fix'
                            : 'Edit';
                  return (
                    <button
                      key={teamNumber}
                      type="button"
                      data-testid={`pit-assignment-${teamNumber}`}
                      onClick={() => setTeam(teamNumber)}
                      className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-card px-3 text-left hover:border-brand/50 hover:bg-accent"
                    >
                      <span className="font-mono text-lg font-semibold text-brand">{teamNumber}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-muted-foreground">
                          {option?.nickname ?? `Team ${teamNumber}`}
                        </span>
                        {assignment.crewSize > 1 ? (
                          <span className="block truncate text-xs text-brand">
                            {assignment.partnerNames.length > 0
                              ? `With ${assignment.partnerNames.join(' + ')}`
                              : `${assignment.crewSize}-person shared crew`}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs font-medium text-brand">{statusLabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div
            data-testid="pit-team-start-card"
            className={`mx-auto flex w-full max-w-xl flex-col gap-2 rounded-2xl border border-border bg-card p-4 ${
              assignedTeams.length > 0 ? 'lg:max-w-none' : ''
            }`}
          >
            <Label htmlFor="pit-team-input" className="flex items-center gap-1.5 text-base">
              <Hash className="size-5 text-brand" />
              {assignedTeams.length > 0 ? 'Scout another team' : 'Team number'}
            </Label>
            {/* Custom autocomplete (the native <datalist> only filters on the full
                value and its popup is unreliable). Suggestions render IN-FLOW
                below the input — pushing the hint + Start button down rather than
                overlaying them, so a tap aimed at Start can never land on a
                suggestion and silently swap the typed team number. */}
            <div>
              <Input
                id="pit-team-input"
                data-testid="pit-team-input"
                inputMode="numeric"
                type="number"
                min={1}
                max={PIT_NUMERIC_LIMITS.teamNumber}
                role="combobox"
                aria-expanded={open && suggestions.length > 0}
                aria-controls="pit-team-options"
                aria-autocomplete="list"
                aria-activedescendant={
                  open && suggestions[activeOption]
                    ? `pit-team-option-${suggestions[activeOption].team_number}`
                    : undefined
                }
                value={teamInput}
                onChange={(e) => {
                  setTeamInput(e.target.value);
                  setOpen(true);
                  setActiveOption(-1);
                }}
                onFocus={() => {
                  setOpen(true);
                  setActiveOption(-1);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setOpen(false);
                    return;
                  }
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    if (!suggestions.length) return;
                    event.preventDefault();
                    setOpen(true);
                    setActiveOption((current) => {
                      if (current < 0) {
                        return event.key === 'ArrowDown' ? 0 : suggestions.length - 1;
                      }
                      const delta = event.key === 'ArrowDown' ? 1 : -1;
                      return (current + delta + suggestions.length) % suggestions.length;
                    });
                    return;
                  }
                  if (event.key === 'Enter' && open && suggestions[activeOption]) {
                    event.preventDefault();
                    choose(suggestions[activeOption].team_number);
                  }
                }}
                // Delay close so a click/tap on an option registers first.
                onBlur={() => window.setTimeout(() => setOpen(false), 120)}
                placeholder="Start typing a team number…"
                className="h-14 font-mono text-lg tabular-nums"
                autoComplete="off"
              />
              {open && suggestions.length > 0 && (
                <ul
                  id="pit-team-options"
                  role="listbox"
                  aria-label="Matching teams"
                  data-testid="pit-team-options"
                  className="mt-1 max-h-72 w-full overflow-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
                >
                  {suggestions.map((t, index) => (
                    <li
                      key={t.team_number}
                      id={`pit-team-option-${t.team_number}`}
                      role="option"
                      aria-selected={index === activeOption}
                      data-testid={`pit-team-option-${t.team_number}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(t.team_number)}
                      className={`flex min-h-[44px] w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left hover:bg-accent ${
                        index === activeOption ? 'bg-accent' : ''
                      }`}
                    >
                        <span className="w-14 shrink-0 font-mono text-base font-semibold tabular-nums text-brand">
                          {t.team_number}
                        </span>
                        <span className="truncate text-sm text-muted-foreground">
                          {t.nickname ?? ''}
                        </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p
              data-testid="pit-team-match"
              className="min-h-[1.25rem] text-sm text-muted-foreground"
            >
              {matched ? (
                <span className="text-brand">
                  {matched.nickname ?? `Team ${matched.team_number}`}
                </span>
              ) : valid && teamOptions.length > 0 ? (
                'Not on this event’s roster — double-check the number.'
              ) : (
                ''
              )}
            </p>
            <Button
              data-testid="pit-team-go"
              variant="brand"
              size="xl"
              className="w-full gap-2"
              disabled={!canStart}
              onClick={() => setTeam(parsedTeam)}
            >
              <Wrench className="size-5" />
              Start pit scouting
            </Button>
          </div>
        </div>
      </section>
    );
  }

  const backToPicker = (): void => {
    if (storageProtected) return;
    setTeam(null);
    setTeamInput('');
    window.dispatchEvent(new Event('pit-local-changed'));
  };

  return (
    <section
      data-testid="pit-flow"
      className="mx-auto flex w-full max-w-5xl flex-col gap-3"
    >
      <Button
        data-testid="pit-change-team"
        variant="outline"
        size="big"
        className="w-full gap-2 sm:w-auto sm:self-start"
        disabled={storageProtected}
        onClick={backToPicker}
      >
        <Hash className="size-5" />
        Change team (Team {team})
      </Button>
      {storageProtected ? (
        <p role="alert" className="text-sm text-destructive">
          Finish or retry the device save below before changing teams.
        </p>
      ) : null}
      <PitScoutScreen
        key={`${eventKey}:${team}`}
        eventKey={eventKey}
        teamNumber={team}
        scoutId={scoutId}
        onDone={backToPicker}
        onStorageProtectionChange={setStorageProtected}
      />
    </section>
  );
}
