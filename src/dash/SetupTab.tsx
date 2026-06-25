// src/dash/SetupTab.tsx — lead event setup: import an event (which becomes the
// ACTIVE event and persists across sessions), set the BASE team the dashboard is
// built around, and assign scouters. Folds the old /admin page in.
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Users, ArrowLeftRight } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EventSetup } from '@/admin/EventSetup';
import { ScheduleView } from '@/admin/ScheduleView';
import { AssignmentBoard } from '@/admin/AssignmentBoard';
import type { AssignMatch, AssignScout } from '@/admin/types';
import { useActiveEvent } from '@/dash/useActiveEvent';
import { setActiveEvent } from '@/dash/setActiveEvent';
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

export default function SetupTab(): JSX.Element {
  const queryClient = useQueryClient();
  const { eventKey: activeEvent } = useActiveEvent();
  const [matches, setMatches] = useState<AssignMatch[]>([]);
  const [scouts, setScouts] = useState<AssignScout[]>([]);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [error, setError] = useState<string | null>(null);

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
        setError(err instanceof Error ? err.message : 'Failed to set active event.');
      }
    },
    [queryClient, loadEvents],
  );

  return (
    <div data-testid="setup-tab" className="flex flex-col gap-4">
      {/* Active event. Set automatically when you import an event below; it sticks
          across sessions, so there's nothing extra to press to "keep" it. */}
      <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">Active event</span>
          <span data-testid="setup-active-event" className="font-mono text-lg font-semibold">
            {activeEvent ?? '— none —'}
          </span>
          {activeEvent && <CheckCircle2 className="size-5 text-success" />}
        </div>
        <p className="text-xs text-muted-foreground">
          Importing an event makes it active and keeps it active across sessions and
          devices. Switch between already-imported events below — no re-import needed.
        </p>
      </div>

      {/* Switch the active event among already-imported ones (no re-import). */}
      <div
        data-testid="setup-events"
        className="flex flex-col gap-2 rounded-lg border border-border p-3"
      >
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="size-4 text-brand" />
          <span className="text-sm font-medium">Switch event</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Pick any imported event to make it active, or import a new one below.
        </p>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events imported yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {events.map((ev) => {
              const isActive = ev.event_key === activeEvent;
              return (
                <li key={ev.event_key}>
                  <Button
                    data-testid={`setup-switch-${ev.event_key}`}
                    variant={isActive ? 'default' : 'outline'}
                    className="h-auto w-full justify-between py-2"
                    disabled={isActive}
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
                </li>
              );
            })}
          </ul>
        )}
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

      {/* Import an event; on success make it the active event so it persists. */}
      <EventSetup
        onImported={(key) => {
          void makeActive(key);
        }}
      />

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {activeEvent ? (
        <>
          <ScheduleView eventKey={activeEvent} />
          <AssignmentBoard eventKey={activeEvent} matches={matches} scouts={scouts} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Import an event to begin.</p>
      )}
    </div>
  );
}
