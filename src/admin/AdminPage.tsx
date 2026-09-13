import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { EventSetup } from './EventSetup';
import { ScheduleView } from './ScheduleView';
import { AssignmentBoard } from './AssignmentBoard';
import type { AssignMatch, AssignScout } from './types';

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

export default function AdminPage(): JSX.Element {
  const [eventKey, setEventKey] = useState<string | null>(null);
  const [matches, setMatches] = useState<AssignMatch[]>([]);
  const [scouts, setScouts] = useState<AssignScout[]>([]);

  // Resolve the active event once on mount.
  useEffect(() => {
    let active = true;
    void (async () => {
      const { data } = await supabase
        .from('event')
        .select('event_key')
        .eq('is_active', true)
        .order('imported_at', { ascending: false })
        .limit(1);
      const key = (data as { event_key: string }[] | null)?.[0]?.event_key ?? null;
      if (active) setEventKey(key);
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadEventData = useCallback(async (key: string) => {
    const [matchRes, scoutRes] = await Promise.all([
      supabase
        .from('match')
        .select('match_key,match_number,scheduled_time,red1,red2,red3,blue1,blue2,blue3')
        .eq('event_key', key)
        .order('match_number', { ascending: true }),
      supabase.from('scout').select('id,display_name').eq('event_key', key),
    ]);

    const matchRows = (matchRes.data as MatchRow[] | null) ?? [];
    setMatches(
      matchRows.map((m) => ({
        matchKey: m.match_key,
        scheduledTime: m.scheduled_time,
        redTeams: [m.red1, m.red2, m.red3],
        blueTeams: [m.blue1, m.blue2, m.blue3],
      }))
    );

    const scoutRows = (scoutRes.data as ScoutRow[] | null) ?? [];
    setScouts(scoutRows.map((s) => ({ id: s.id, displayName: s.display_name })));
  }, []);

  useEffect(() => {
    if (eventKey) void loadEventData(eventKey);
  }, [eventKey, loadEventData]);

  function onImported(key: string): void {
    setEventKey(key);
  }

  return (
    <main data-testid="admin-page" className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <h1 className="text-2xl font-bold">Admin</h1>
      <EventSetup onImported={onImported} />
      {eventKey ? (
        <>
          <ScheduleView eventKey={eventKey} />
          <AssignmentBoard eventKey={eventKey} matches={matches} scouts={scouts} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Import an event to begin.</p>
      )}
    </main>
  );
}
