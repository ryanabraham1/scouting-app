// src/dash/SetupTab.tsx — lead event setup: import an event (which becomes the
// ACTIVE event and persists across sessions), set the BASE team the dashboard is
// built around, and assign scouters. Folds the old /admin page in.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import {
  CheckCircle2,
  Trash2,
  Sparkles,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TeamLink } from '@/components/ui/TeamLink';
import { EventSetup } from '@/admin/EventSetup';
import { useEventMatches, useEventReports } from '@/dash/useEventData';
import { validateMatchVsTba } from '@/dash/validateVsTba';
import { formatMatchKeyRaw } from '@/lib/formatMatch';
import { MatchPlanner } from '@/admin/MatchPlanner';
import type { AssignMatch, AssignScout, AssignTeam } from '@/admin/types';
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
  scheduled_time: string | null;
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

interface EventTeamRow {
  team: { team_number: number; nickname: string | null } | null;
}

interface EventOption {
  event_key: string;
  name: string | null;
  is_active: boolean;
}

interface LoadedEventData {
  eventKey: string;
  matches: AssignMatch[];
  scouts: AssignScout[];
  teams: AssignTeam[];
}

/** localStorage key remembering the Events & settings disclosure state. */
const CONFIG_OPEN_KEY = 'setup-config-open';

function ValidationTool({ eventKey }: { eventKey: string | null }): JSX.Element {
  const reports = useEventReports(eventKey);
  const matches = useEventMatches(eventKey);
  const [result, setResult] = useState<{ event: string; checked: number; flagged: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(): Promise<void> {
    if (!eventKey) return;
    setBusy(true); setError(null);
    try {
      const [rs, ms] = await Promise.all([reports.refetch(), matches.refetch()]);
      if (rs.error || ms.error) throw new Error('Could not refresh the data. Try again when online.');
      const checks = (ms.data ?? []).map(m => validateMatchVsTba(m.match_key, (rs.data ?? []).filter(r => r.match_key === m.match_key), m.actual_red_score, m.actual_blue_score));
      setResult({ event: eventKey, checked: checks.filter(c => c.hasComparable).length, flagged: checks.filter(c => c.worst === 'minor' || c.worst === 'severe').map(c => c.matchKey) });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not validate scouting.'); }
    finally { setBusy(false); }
  }
  const current = result?.event === eventKey ? result : null;
  return <><div className="lead-setting-row"><div><h3>Validate scouting vs TBA</h3><p>{error ?? (current ? `${current.checked} matches checked · ${current.flagged.length} need review` : 'Compare scouted fuel with official alliance scores')}</p></div><Button variant="outline" disabled={!eventKey || busy} onClick={() => void run()}>{busy ? 'Checking…' : 'Run now'}</Button></div>{current && current.flagged.length > 0 ? <div className="flex flex-wrap gap-3 px-6 pb-5">{current.flagged.map(key => <a className="text-sm text-brand underline" href={`/analysis?tab=match&match=${encodeURIComponent(key)}`} key={key}>{formatMatchKeyRaw(key)}</a>)}</div> : null}</>;
}

export default function SetupTab({ onLock }: { onLock?: () => void } = {}): JSX.Element {
  const queryClient = useQueryClient();
  const { eventKey: activeEvent } = useActiveEvent();
  const [matches, setMatches] = useState<AssignMatch[]>([]);
  const [scouts, setScouts] = useState<AssignScout[]>([]);
  const [teams, setTeams] = useState<AssignTeam[]>([]);
  const [loadedEventKey, setLoadedEventKey] = useState<string | null>(null);
  const [eventDataLoading, setEventDataLoading] = useState(false);
  const [failedEventKey, setFailedEventKey] = useState<string | null>(null);
  const loadGeneration = useRef(0);
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
  // The match assignments disclosure. Open by default; remembers an explicit
  // collapse across visits. A #assignments link (Scouters tab) always opens it.
  const [configOpen, setConfigOpen] = useState(() => {
    if (window.location.hash === '#assignments') return true;
    try {
      const stored = localStorage.getItem(CONFIG_OPEN_KEY);
      if (stored != null) return stored === 'true';
    } catch {
      /* no storage — default open */
    }
    return true;
  });
  const location = useLocation();
  // Re-run as the events and planner load, since each pushes the section down.
  useEffect(() => {
    if (location.hash !== '#assignments') return;
    setConfigOpen(true);
    document.getElementById('assignments')?.scrollIntoView({ block: 'start' });
  }, [location.hash, location.key, events.length, eventDataLoading]);

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

  const loadEventData = useCallback(async (key: string): Promise<LoadedEventData> => {
    const [matchRes, scoutRes, teamRes] = await Promise.all([
      supabase
        .from('match')
        .select('match_key,match_number,scheduled_time,red1,red2,red3,blue1,blue2,blue3')
        .eq('event_key', key)
        .order('match_number', { ascending: true }),
      supabase.from('scout').select('id,display_name').eq('event_key', key),
      supabase
        .from('event_team')
        .select('team:team(team_number,nickname)')
        .eq('event_key', key),
    ]);
    const firstError = matchRes.error ?? scoutRes.error ?? teamRes.error;
    if (firstError) throw new Error(firstError.message);
    const matchRows = (matchRes.data as MatchRow[] | null) ?? [];
    const nextMatches: AssignMatch[] = matchRows.map((m) => ({
      matchKey: m.match_key,
      scheduledTime: m.scheduled_time,
      redTeams: [m.red1, m.red2, m.red3] as [number, number, number],
      blueTeams: [m.blue1, m.blue2, m.blue3] as [number, number, number],
    }));
    const scoutRows = (scoutRes.data as ScoutRow[] | null) ?? [];
    const nextScouts = scoutRows.map((s) => ({ id: s.id, displayName: s.display_name }));
    const teamRows = (teamRes.data as unknown as EventTeamRow[] | null) ?? [];
    const nextTeams = teamRows
      .map((row) => row.team)
      .filter((team): team is NonNullable<EventTeamRow['team']> => team != null)
      .map((team) => ({ teamNumber: team.team_number, nickname: team.nickname }))
      .sort((a, b) => a.teamNumber - b.teamNumber);
    return {
      eventKey: key,
      matches: nextMatches,
      scouts: nextScouts,
      teams: nextTeams,
    };
  }, []);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    if (!activeEvent) {
      setMatches([]);
      setScouts([]);
      setTeams([]);
      setLoadedEventKey(null);
      setEventDataLoading(false);
      setFailedEventKey(null);
      return;
    }

    // Never render the new event key with the previous event's planner props.
    // The generation guard also prevents a slow A response from overwriting B.
    setLoadedEventKey(null);
    setEventDataLoading(true);
    setFailedEventKey(null);
    void loadEventData(activeEvent)
      .then((loaded) => {
        if (loadGeneration.current !== generation || loaded.eventKey !== activeEvent) return;
        setMatches(loaded.matches);
        setScouts(loaded.scouts);
        setTeams(loaded.teams);
        setLoadedEventKey(loaded.eventKey);
      })
      .catch((err) => {
        if (loadGeneration.current !== generation) return;
        setFailedEventKey(activeEvent);
        setError(err instanceof Error ? err.message : 'Failed to load event assignments.');
      })
      .finally(() => {
        if (loadGeneration.current === generation) setEventDataLoading(false);
      });
  }, [activeEvent, loadEventData]);

  // All already-imported events, so the lead can switch the active one WITHOUT
  // re-importing: switching flips is_active atomically via the `set_active_event`
  // RPC (see setActiveEvent.ts / migration 0037), not a direct anon `event` UPDATE.
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
    <div data-testid="setup-tab" className="lead-settings flex flex-col gap-4">
      <h1 className="lead-settings-title">Settings</h1>
      <section><h2 className="lead-section-label">Event</h2><div className="lead-settings-panel">
        <div className="lead-setting-row"><div><h3>Active event</h3><p>Every device follows this event</p></div><select aria-label="Active event" value={activeEvent ?? ''} onChange={e => void makeActive(e.target.value)}><option value="" disabled>Select an event</option>{events.map(ev => <option key={ev.event_key} value={ev.event_key}>{ev.event_key}{ev.name ? ` · ${ev.name}` : ''}</option>)}</select><span data-testid="setup-active-event" className="sr-only">{activeEvent ?? '— none —'}</span></div>
        <div data-testid="setup-base-team" className="lead-setting-row"><div><h3>Base team</h3><p>Whose matches “ours” means</p></div><div>        <div className="flex flex-wrap items-center gap-2">
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
          <TeamLink team={baseTeam} data-testid="setup-base-team-current" className="font-mono" />
        </div></div></div>
        <div className="lead-setting-row"><div><h3>Import a new event</h3><p>Pulls teams and schedule from The Blue Alliance</p></div><div className="lead-settings-import">          <EventSetup
            embedded
            onImported={(key) => {
              void makeActive(key);
            }}
          /></div></div>
      </div></section>
      <section data-testid="setup-events"><h2 className="lead-section-label">Events on this account</h2><div className="lead-settings-panel lead-event-list">        {events.length === 0 ? (
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
                    variant="outline"
                    className={cn(
                      'h-auto min-w-0 flex-1 justify-between py-2',
                      isActive && 'border-success/50 bg-success/10 text-foreground disabled:opacity-100 [&_svg]:text-success',
                    )}
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

</div></section>
      <section><h2 className="lead-section-label">Lead tools</h2><div className="lead-settings-panel">      <div
        data-testid="setup-demo"
        className="flex flex-col gap-3 sm:rounded-lg sm:border sm:border-border/70 sm:bg-muted/10 sm:p-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Demo mode</span>
            {demoActive ? (
              <span className="rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                Active
              </span>
            ) : null}
          </div>
          {demoPresent ? (
            <p
              data-testid="setup-demo-status"
              className={demoActive ? 'text-xs font-medium text-brand' : 'text-xs text-muted-foreground'}
            >
              {demoActive
                ? 'The dashboard is currently showing simulated data.'
                : 'Demo data is loaded but not active.'}
            </p>
          ) : null}
        </div>

        {demoPresent ? (
          confirmingDemoRemove ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                data-testid="setup-demo-disable"
                variant="outline"
                size="sm"
                className="border-destructive/60 text-destructive hover:bg-destructive/15"
                disabled={demoBusy}
                onClick={() => void handleDisableDemo()}
              >
                {demoBusy ? 'Removing…' : 'Remove demo data'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={demoBusy}
                onClick={() => setConfirmingDemoRemove(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              data-testid="setup-demo-disable-arm"
              variant="ghost"
              size="sm"
              className="shrink-0 self-start text-muted-foreground hover:text-destructive sm:self-center"
              disabled={demoBusy}
              onClick={() => {
                setError(null);
                setConfirmingDemoRemove(true);
              }}
            >
              {demoActive ? 'Exit demo' : 'Remove demo data'}
            </Button>
          )
        ) : (
          <Button
            data-testid="setup-demo-enable"
            variant="outline"
            size="sm"
            className="shrink-0 self-start text-muted-foreground sm:self-center"
            disabled={demoBusy}
            onClick={() => void handleEnableDemo()}
          >
            <Sparkles className="size-4" />
            {demoBusy ? 'Loading demo…' : 'Load demo data'}
          </Button>
        )}
      </div>
        {onLock ? <div className="lead-setting-row"><div><h3>Lock lead dashboard</h3><p>Ask for the lead PIN again on this device</p></div><Button variant="outline" onClick={onLock}>Lock dashboard</Button></div> : null}
        <ValidationTool eventKey={activeEvent} />
      </div></section>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <details id="assignments" open={configOpen} onToggle={e => { setConfigOpen(e.currentTarget.open); try { localStorage.setItem(CONFIG_OPEN_KEY, String(e.currentTarget.open)); } catch { /* storage unavailable */ } }} className="lead-assignments"><summary>Match assignments</summary>      {activeEvent && loadedEventKey === activeEvent && !eventDataLoading ? (
        <MatchPlanner
          key={activeEvent}
          eventKey={activeEvent}
          matches={matches}
          scouts={scouts}
          teams={teams}
        />
      ) : activeEvent && failedEventKey === activeEvent ? (
        <p data-testid="setup-event-data-error" className="text-sm text-destructive">
          Could not load {activeEvent} assignment data.
        </p>
      ) : activeEvent ? (
        <p data-testid="setup-event-data-loading" className="text-sm text-muted-foreground">
          Loading {activeEvent} assignments…
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Import an event to begin.</p>
      )}</details>
    </div>
  );
}
