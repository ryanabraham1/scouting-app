import { useEffect, useState } from 'react';
import { Pin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { readPreference, teamList, writePreference } from './analysisPreferences';

/** Key this component by event so visits and pins never leak into another roster. */
export default function TeamQuickAccess({ eventKey, selected, onSelect }: {
  eventKey: string;
  selected: number | null;
  onSelect: (team: number) => void;
}): JSX.Element {
  const key = `analysis-teams-v1:${eventKey}`;
  const [lists, setLists] = useState(() => {
    const stored = readPreference(key) as { recent?: unknown; pinned?: unknown } | null;
    return { recent: teamList(stored?.recent).slice(0, 6), pinned: teamList(stored?.pinned) };
  });

  useEffect(() => {
    if (selected == null) return;
    setLists((previous) => previous.recent[0] === selected ? previous : {
      ...previous, recent: [selected, ...previous.recent.filter((team) => team !== selected)].slice(0, 6),
    });
  }, [selected]);
  useEffect(() => { writePreference(key, lists); }, [key, lists]);

  const pinned = selected != null && lists.pinned.includes(selected);
  return (
    <section aria-label="Team shortcuts" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-zinc-800 px-3 py-2 sm:px-4">
      {(['pinned', 'recent'] as const).map((kind) => (
        <div key={kind} className="flex min-w-0 items-center gap-2">
          <h3 className="text-xs font-semibold text-zinc-400">{kind === 'pinned' ? 'Pinned' : 'Recent'}</h3>
          <div className="flex flex-wrap gap-1.5" aria-label={kind === 'pinned' ? 'Pinned teams' : 'Recent teams'}>
            {lists[kind].map((team) => <Button
              key={team} variant={selected === team ? 'default' : 'outline'} size="sm"
              className="min-h-11 min-w-14 font-mono" aria-pressed={selected === team}
              aria-label={`Open team ${team}`} onClick={() => onSelect(team)}
            >{team}</Button>)}
            {lists[kind].length === 0 ? <span className="text-xs text-zinc-600">—</span> : null}
          </div>
        </div>
      ))}
      {selected != null ? <Button
        variant="outline" size="sm" className="ml-auto min-h-11"
        aria-pressed={pinned} disabled={!pinned && lists.pinned.length >= 12}
        title={!pinned && lists.pinned.length >= 12 ? '12 teams pinned. Unpin a team to make room.' : undefined}
        onClick={() => setLists((previous) => ({ ...previous, pinned: pinned
          ? previous.pinned.filter((team) => team !== selected)
          : [...previous.pinned, selected] }))}
      ><Pin className="size-4" />{pinned ? `Unpin team ${selected}` : `Pin team ${selected}`}</Button> : null}
    </section>
  );
}
