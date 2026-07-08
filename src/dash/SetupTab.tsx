// src/dash/SetupTab.tsx — lead event setup: import an event (which becomes the
// ACTIVE event and persists across sessions), set the BASE team the dashboard is
// built around, and assign scouters. Folds the old /admin page in.
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Users,
  ArrowLeftRight,
  Trash2,
  Sparkles,
  ChevronDown,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EventSetup } from '@/admin/EventSetup';
import { MatchPlanner } from '@/admin/MatchPlanner';
import type { AssignMatch, AssignScout } from '@/admin/types';
import { useActiveEvent } from '@/dash/useActiveEvent';
import { setActiveEvent } from '@/dash/setActiveEvent';
import { deleteEvent } from '@/dash/deleteEvent';
import { isDemoEvent, enableDemoMode, disableDemoMode } from '@/dash/demoEvent';
import {
  getStoredBaseTeam,
  setStoredBaseTeam,
  DEFAULT_BASE_TEAM,
} from '@/dash/baseTeamStore';

interface MatchRow {
  match_key: string;
  match_number: number;
  red1: number;
  red2: number;
  red3: number;
  blue1: number;
  blue2: number;
  blue3: number;
}

interface ScoutRow {
  id: string;
  display_name: string;
}

interface EventOption {
  event_key: string;
  name: string | null;
  is_active: boolean;
}

/** localStorage key remembering the Events & settings disclosure state. */
const CONFIG_OPEN_KEY = 'setup-config-open';

export default function SetupTab(): JSX.Element {
  const queryClient = useQueryClient();
  const { eventKey: activeEvent } = useActiveEvent();
  const [matches, setMatches] = useState<AssignMatch[]>([]);
  const [scouts, setScouts] = useState<AssignScout[]>([]);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Two-step delete: first click arms the confirm for one event_key, second
  // click runs it. `deletingKey` disables the row while the RPC is in flight.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  // Demo mode: a one-tap simulated event (fake teams + scouting data) for
  // exploring every dashboard feature without a live event. `demoBusy` covers the
  // in-flight seed/teardown; `confirmingDemoRemove` arms the one-tap remove guard.
  const [demoBusy, setDemoBusy] = useState(false);
  const [confirmingDemoRemove, setConfirmingDemoRemove] = useState(false);
  // Event/config management (demo, event switching, base team) folds into a
  // disclosure so it doesn't push the match schedule + assignments — the daily
  // work — far down the page. Opens by default only when nothing is set up yet.
  // Open by default; remembers an explicit collapse across visits (leads found
  // re-opening it every time annoying).
  const [configOpen, setConfigOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(CONFIG_OPEN_KEY);
      if (stored != null) return stored === 'true';
    } catch {
      /* no storage — default open */
    }
    return true;
  });

  // Base team: the team the whole dashboard pivots on (next match, live data,
  // rankings). Defaults to 3256; configurable here so a lead can point the app at
  // any team's event for testing. Stored locally; takes effect on next render.
  const [baseTeamInput, setBaseTeamInput] = useState(() => String(getStoredBaseTeam()));
  const [baseTeam, setBaseTeam] = useState(() => getStoredBaseTeam());

  const saveBaseTeam = useCallback(() => {
    const n = Number(baseTeamInput.trim());
    if (!Number.isInteger(n) || n <= 0) {
      setError('Base team must be a positive team number.');
      return;
    }
    setError(null);
    setStoredBaseTeam(n);
    setBaseTeam(getStoredBaseTeam());
    // Refresh views that key off the base team (Next Match prediction/EPA, etc.).
    void queryClient.invalidateQueries();
  }, [baseTeamInput, queryClient]);

  const resetBaseTeam = useCallback(() => {
    setStoredBaseTeam(null);
    setBaseTeamInput(String(DEFAULT_BASE_TEAM));
    setBaseTeam(DEFAULT_BASE_TEAM);
    setError(null);
    void queryClient.invalidateQueries();
  }, [queryClient]);

  const loadEventData = useCallback(async (key: string) => {
    const [matchRes, scoutRes] = await Promise.all([
      supabase
        .from('match')
        .select('match_key,match_number,red1,red2,red3,blue1,blue2,blue3')
        .eq('event_key', key)
        .order('match_number', { ascending: true }),
      supabase.from('scout').select('id,display_name').eq('event_key', key),
    ]);
    const matchRows = (matchRes.data as MatchRow[] | null) ?? [];
    setMatches(
      matchRows.map((m) => ({
        matchKey: m.match_key,
        redTeams: [m.red1, m.red2, m.red3],
        blueTeams: [m.blue1, m.blue2, m.blue3],
      })),
    );
    const scoutRows = (scoutRes.data as ScoutRow[] | null) ?? [];
    setScouts(scoutRows.map((s) => ({ id: s.id, displayName: s.display_name })));
  }, []);

  useEffect(() => {
    if (activeEvent) void loadEventData(activeEvent);
  }, [activeEvent, loadEventData]);

  // All already-imported events, so the lead can switch the active one WITHOUT
  // re-importing: switching only flips is_active, which the open
  // `event_update_open` RLS policy permits for anon.
  const loadEvents = useCallback(async () => {
    const { data } = await supabase
      .from('event')
      .select('event_key,name,is_active')
      .order('event_key', { ascending: true });
    setEvents((data as EventOption[] | null) ?? []);
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents, activeEvent]);

  const makeActive = useCallback(
    async (key: string) => {
      setError(null);
      try {
        await setActiveEvent(key, queryClient);
        await loadEvents();
      } catch (err) {
        // Supabase/Postgrest errors are plain objects (not Error instances), so
        // read `.message` off any object before falling back to the generic text.
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === 'object' && err && 'message' in err
              ? String((err as { message: unknown }).message)
              : null;
        setError(msg || 'Failed to set active event.');
      }
    },
    [queryClient, loadEvents],
  );

  // Permanently remove an imported event and all of its data. `deleteEvent`
  // clears the active-event pointer for us if this was the active one; we then
  // refresh the list and invalidate dependent views.
  const handleDelete = useCallback(
    async (key: string) => {
      setError(null);
      setDeletingKey(key);
      try {
        await deleteEvent(key, queryClient);
        setConfirmingDelete(null);
        await loadEvents();
        void queryClient.invalidateQueries();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete event.');
      } finally {
        setDeletingKey(null);
      }
    },
    [queryClient, loadEvents],
  );

  // Whether the demo event exists at all (imported/seeded) and whether it's the
  // active one. Drives the demo card between its "enable" and "active" states.
  const demoPresent = events.some((ev) => isDemoEvent(ev.event_key));
  const demoActive = isDemoEvent(activeEvent ?? null);

  const handleEnableDemo = useCallback(async () => {
    setError(null);
    setDemoBusy(true);
    try {
      await enableDemoMode(queryClient);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set up demo mode.');
    } finally {
      setDemoBusy(false);
    }
  }, [queryClient, loadEvents]);

  const handleDisableDemo = useCallback(async () => {
    setError(null);
    setDemoBusy(true);
    try {
      await disableDemoMode(queryClient);
      setConfirmingDemoRemove(false);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove demo event.');
    } finally {
      setDemoBusy(false);
    }
  }, [queryClient, loadEvents]);

  return (
    <div data-testid="setup-tab" className="flex flex-col gap-4">
      {/* Event & config management folds into a disclosure so the daily work —
          the match schedule + assignments below — isn't buried under setup that
          rarely changes. The active event stays visible in the summary. */}
      <details
        open={configOpen}
        onToggle={(e) => {
          const open = e.currentTarget.open;
          setConfigOpen(open);
          try {
            localStorage.setItem(CONFIG_OPEN_KEY, String(open));
          } catch {
            /* no storage */
          }
        }}
        className="group rounded-lg border border-border"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 [&::-webkit-details-marker]:hidden">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Active event</span>
            <span data-testid="setup-active-event" className="font-mono text-lg font-semibold">
              {activeEvent ?? '— none —'}
            </span>
            {activeEvent ? <CheckCircle2 className="size-5 text-success" /> : null}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
            Events &amp; settings
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </span>
        </summary>

        <div className="flex flex-col gap-4 border-t border-border p-3">
      {/* Demo mode — a one-tap simulated event so the whole dashboard (rankings,
          picklist, next-match prediction, team profiles, scouter performance) can
          be explored without a live event. Tinted brand/energy so it reads as a
          special mode. */}
      <div
        data-testid="setup-demo"
        className="flex flex-col gap-3 rounded-lg border border-brand/40 bg-brand/5 p-3"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-brand" />
          <span className="text-sm font-medium">Demo mode</span>
          <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
            Demo
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Explore the full dashboard on a simulated copy of a real event — no live
          event needed.
        </p>

        {demoPresent ? (
          <>
            <p
              data-testid="setup-demo-status"
              className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-brand"
            >
              <CheckCircle2 className="size-4" />
              {demoActive
                ? 'Demo mode is on — the dashboard is showing simulated data.'
                : 'Demo event is loaded. Make it active to explore it.'}
            </p>
            {confirmingDemoRemove ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  data-testid="setup-demo-disable"
                  variant="outline"
                  className="h-11 border-destructive bg-destructive/15 px-3 text-destructive hover:bg-destructive/25"
                  disabled={demoBusy}
                  onClick={() => void handleDisableDemo()}
                >
                  {demoBusy ? 'Removing…' : 'Remove demo event'}
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 px-3"
                  disabled={demoBusy}
                  onClick={() => setConfirmingDemoRemove(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                data-testid="setup-demo-disable-arm"
                variant="outline"
                className="h-11 self-start px-3 text-muted-foreground hover:border-destructive hover:bg-destructive/15 hover:text-destructive"
                disabled={demoBusy}
                onClick={() => {
                  setError(null);
                  setConfirmingDemoRemove(true);
                }}
              >
                {demoActive ? 'Exit demo mode' : 'Remove demo event'}
              </Button>
            )}
          </>
        ) : (
          <Button
            data-testid="setup-demo-enable"
            variant="default"
            className="h-11 self-start px-4"
            disabled={demoBusy}
            onClick={() => void handleEnableDemo()}
          >
            <Sparkles className="size-4" />
            {demoBusy ? 'Setting up demo…' : 'Enable demo mode'}
          </Button>
        )}
      </div>

      {/* Events — switch the active event among already-imported ones (no
          re-import), delete one you no longer need, or import a new one. Combines
          the old "Switch event" + "Event Setup" blocks into a single section. */}
      <div
        data-testid="setup-events"
        className="flex flex-col gap-3 rounded-lg border border-border p-3"
      >
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="size-4 text-brand" />
          <span className="text-sm font-medium">Events</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Pick an imported event to make it active, delete one you no longer need,
          or import a new one below.
        </p>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events imported yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {events.map((ev) => {
              const isActive = ev.event_key === activeEvent;
              const isConfirming = confirmingDelete === ev.event_key;
              const isDeleting = deletingKey === ev.event_key;
              return (
                <li key={ev.event_key} className="flex items-stretch gap-2">
                  <Button
                    data-testid={`setup-switch-${ev.event_key}`}
                    variant={isActive ? 'default' : 'outline'}
                    className="h-auto min-w-0 flex-1 justify-between py-2"
                    disabled={isActive || isDeleting}
                    onClick={() => void makeActive(ev.event_key)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col items-start text-left">
                      <span className="w-full truncate font-mono font-semibold">{ev.event_key}</span>
                      {ev.name ? (
                        <span className="w-full truncate text-xs font-normal opacity-80">
                          {ev.name}
                        </span>
                      ) : null}
                    </span>
                    {isActive ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs">
                        <CheckCircle2 className="size-4" /> Active
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs opacity-70">Set active</span>
                    )}
                  </Button>

                  {isConfirming ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        data-testid={`setup-delete-confirm-${ev.event_key}`}
                        variant="outline"
                        className="h-auto shrink-0 border-destructive bg-destructive/15 px-3 text-destructive hover:bg-destructive/25"
                        disabled={isDeleting}
                        onClick={() => void handleDelete(ev.event_key)}
                      >
                        {isDeleting ? 'Deleting…' : 'Delete'}
                      </Button>
                      <Button
                        data-testid={`setup-delete-cancel-${ev.event_key}`}
                        variant="ghost"
                        className="h-auto shrink-0 px-3"
                        disabled={isDeleting}
                        onClick={() => setConfirmingDelete(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      data-testid={`setup-delete-${ev.event_key}`}
                      variant="outline"
                      aria-label={`Delete event ${ev.event_key}`}
                      className="h-auto shrink-0 px-3 text-muted-foreground hover:border-destructive hover:bg-destructive/15 hover:text-destructive"
                      onClick={() => {
                        setError(null);
                        setConfirmingDelete(ev.event_key);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {events.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Deleting an event permanently removes it and all of its matches,
            scouters, and reports.
          </p>
        ) : null}

        {/* Import a new event; on success make it the active event so it persists. */}
        <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
          <span className="text-sm font-medium">Import a new event</span>
          <EventSetup
            embedded
            onImported={(key) => {
              void makeActive(key);
            }}
          />
        </div>
      </div>

      {/* Base team — pivots the whole dashboard (Next Match, live data, rankings). */}
      <div
        data-testid="setup-base-team"
        className="flex flex-col gap-2 rounded-lg border border-border p-3"
      >
        <div className="flex items-center gap-2">
          <Users className="size-4 text-brand" />
          <span className="text-sm font-medium">Base team</span>
        </div>
        <p className="text-xs text-muted-foreground">
          The team the dashboard is built around — its next match, live field status,
          and rankings. Defaults to {DEFAULT_BASE_TEAM}. Change it to test events your
          team isn't registered at (e.g. to verify the live-data feed).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            data-testid="setup-base-team-input"
            className="max-w-[8rem] font-mono"
            inputMode="numeric"
            placeholder="3256"
            value={baseTeamInput}
            onChange={(e) => setBaseTeamInput(e.target.value)}
          />
          <Button
            data-testid="setup-base-team-save"
            variant="outline"
            onClick={saveBaseTeam}
            className="h-11 shrink-0"
          >
            Save
          </Button>
          <Button
            data-testid="setup-base-team-reset"
            variant="ghost"
            onClick={resetBaseTeam}
            className="h-11 shrink-0"
          >
            Reset to {DEFAULT_BASE_TEAM}
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          Currently:{' '}
          <span data-testid="setup-base-team-current" className="font-mono">
            {baseTeam}
          </span>
        </div>
      </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </details>

      {activeEvent ? (
        <MatchPlanner eventKey={activeEvent} matches={matches} scouts={scouts} />
      ) : (
        <p className="text-sm text-muted-foreground">Import an event to begin.</p>
      )}
    </div>
  );
}
