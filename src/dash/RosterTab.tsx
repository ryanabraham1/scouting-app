// src/dash/RosterTab.tsx — lead-facing scouter roster manager. Backed by the
// server-side `scouter_roster` table via the rosterClient (owned by Workstream
// B). Add a name, list names, remove a name. Landscape, big-button styling.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Trash2, Plus, Users } from 'lucide-react';
import { listRoster, addScouter, removeScouter } from '@/roster/rosterClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Scouter {
  id: string;
  name: string;
}

export default function RosterTab(): JSX.Element {
  const [scouters, setScouters] = useState<Scouter[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listRoster();
      setScouters(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roster.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onAdd(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    const trimmed = name.trim();
    if (busy || trimmed.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await addScouter(trimmed);
      setName('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add scouter.');
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeScouter(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove scouter.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="roster-tab">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <Users className="size-5" /> Scouter Roster
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex flex-wrap items-center gap-3" onSubmit={(e) => void onAdd(e)}>
          <Input
            data-testid="roster-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Scouter name"
            autoComplete="off"
            className="h-14 flex-1 min-w-[12rem] text-lg"
          />
          <Button
            type="submit"
            size="big"
            data-testid="roster-add-btn"
            disabled={busy || name.trim().length === 0}
          >
            <Plus /> Add
          </Button>
        </form>

        {error ? (
          <p data-testid="roster-error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <ul data-testid="roster-list" className="flex flex-col gap-2">
          {scouters.length === 0 ? (
            <li className="text-sm text-muted-foreground">No scouters yet.</li>
          ) : (
            scouters.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <span className="text-lg font-medium">{s.name}</span>
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  data-testid={`roster-remove-${s.id}`}
                  aria-label={`Remove ${s.name}`}
                  disabled={busy}
                  className="h-12 w-12"
                  onClick={() => void onRemove(s.id)}
                >
                  <Trash2 className="size-5" />
                </Button>
              </li>
            ))
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
