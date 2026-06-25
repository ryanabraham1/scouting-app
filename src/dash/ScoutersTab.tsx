// src/dash/ScoutersTab.tsx — the merged "Scouters" hub. Two stacked sections:
//   1. Roster — the persistent, team-scoped name list (add/remove). Always
//      available, even with no active event, because names live on the
//      `scouter_roster` table (no event_key) and are picked on every device.
//   2. Performance — event-scoped drill-down into each scouter's submitted
//      reports. Shown only when an event is active; otherwise a gentle note
//      explains it appears once an event is set.
// Folds the former RosterTab CRUD inline (RosterTab.tsx stays for any other
// caller) and reuses ScouterView for the performance drill-down.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Trash2, Plus, Users, ClipboardCheck } from 'lucide-react';
import { listRoster, addScouter, removeScouter } from '@/roster/rosterClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import ScouterView from '@/dash/ScouterView';

export interface ScoutersTabProps {
  /** Active event key, or null when no event is set. */
  eventKey: string | null;
}

interface Scouter {
  id: string;
  name: string;
}

/** Persistent roster manager. Add a name, list names, remove a name. */
function RosterManager(): JSX.Element {
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
    <Card data-testid="roster-tab" className="border-border bg-card">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Users className="size-5 text-brand" />
        <CardTitle className="text-foreground">Roster ({scouters.length})</CardTitle>
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
            className="w-full sm:w-auto"
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
            <li className="text-sm text-muted-foreground">
              No scouters yet. Add the names your team picks from on each device.
            </li>
          ) : (
            scouters.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between rounded-xl border border-border bg-muted/30 p-3"
              >
                <span className="text-lg font-medium text-foreground">{s.name}</span>
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

/**
 * Merged Scouters hub: persistent roster management plus event-scoped
 * performance drill-down. Roster is always usable; performance appears once an
 * event is active.
 */
export default function ScoutersTab(props: ScoutersTabProps): JSX.Element {
  const { eventKey } = props;
  return (
    <div data-testid="dash-scouters" className="flex flex-col gap-6 text-foreground">
      <RosterManager />

      <section aria-label="Scouter performance" className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <ClipboardCheck className="size-4 text-brand" />
          Performance
        </h2>
        {eventKey ? (
          <ScouterView eventKey={eventKey} />
        ) : (
          <p
            data-testid="scouters-no-event"
            className="rounded-xl border border-border bg-card/60 px-3 py-4 text-sm text-muted-foreground"
          >
            Set an active event in Setup to see each scouter's report counts and
            reliability.
          </p>
        )}
      </section>
    </div>
  );
}
