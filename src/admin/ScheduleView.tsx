import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

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

export interface ScheduleViewProps {
  eventKey: string;
}

export function ScheduleView({ eventKey }: ScheduleViewProps): JSX.Element {
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      const { data } = await supabase
        .from('match')
        .select('match_key,match_number,red1,red2,red3,blue1,blue2,blue3')
        .eq('event_key', eventKey)
        .order('match_number', { ascending: true });
      if (active) {
        setMatches((data as MatchRow[] | null) ?? []);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [eventKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Schedule</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches yet.</p>
        ) : (
          <ul data-testid="schedule-list" className="flex flex-col gap-2">
            {matches.map((m) => (
              <li
                key={m.match_key}
                data-testid="schedule-row"
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3 text-sm"
              >
                <span className="w-10 shrink-0 font-semibold text-brand">Q{m.match_number}</span>
                <span className="flex gap-1 font-mono text-red-400">
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5">{m.red1}</span>
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5">{m.red2}</span>
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5">{m.red3}</span>
                </span>
                <span className="flex gap-1 font-mono text-blue-400">
                  <span className="rounded bg-blue-500/15 px-1.5 py-0.5">{m.blue1}</span>
                  <span className="rounded bg-blue-500/15 px-1.5 py-0.5">{m.blue2}</span>
                  <span className="rounded bg-blue-500/15 px-1.5 py-0.5">{m.blue3}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default ScheduleView;
