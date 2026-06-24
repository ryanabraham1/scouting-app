import { useEffect, useState } from 'react';
import { BarChart3, UserRound, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/auth/useSession';
import type { ScoutRow } from '@/auth/scoutRow';
import { listDrafts } from '@/db/localStore';
import type { CaptureDraft } from '@/db/types';
import { CaptureScreen } from '@/capture/CaptureScreen';
import { ReviewScreen } from '@/capture/ReviewScreen';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { exportUnsyncedToFile } from '@/export/exportReports';
import { SyncIndicator } from '@/sync/SyncIndicator';
import { getStoredActiveEvent } from '@/dash/activeEventStore';
import { listRoster, type RosterScouter } from '@/roster/rosterClient';
import {
  selectScouter,
  getRememberedScouterName,
  forgetScouterName,
} from '@/roster/selectScouter';

interface AssignmentRow {
  match_key: string;
  alliance_color: 'red' | 'blue';
  station: 1 | 2 | 3;
  target_team_number: number;
  event_key: string;
}

function CaptureFlow(props: { target: CaptureTarget; onDone: () => void }) {
  const session = useCaptureSession(props.target);
  const [stage, setStage] = useState<'live' | 'review'>('live');
  if (stage === 'review') {
    return <ReviewScreen session={session} onSaved={() => props.onDone()} />;
  }
  return <CaptureScreen session={session} onToReview={() => setStage('review')} />;
}

// Login-less identity: pick your name from the team roster. Tapping a name binds
// this device (anonymous auth.uid) to a per-event scout row via select_scouter.
function NamePicker(props: { eventKey: string; onPicked: (s: ScoutRow) => void }) {
  const [roster, setRoster] = useState<RosterScouter[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listRoster();
        if (!cancelled) setRoster(rows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load roster.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = roster.filter((r) => r.name.toLowerCase().includes(filter.trim().toLowerCase()));

  const pick = async (name: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const row = await selectScouter(props.eventKey, name);
      props.onPicked(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select scouter.');
      setBusy(false);
    }
  };

  return (
    <section data-testid="scout-name-picker" className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold">Who are you?</h2>
        <p className="text-sm text-muted-foreground">
          Select your name to start scouting event <span className="font-mono">{props.eventKey}</span>.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Search className="size-5 text-muted-foreground" />
        <Input
          data-testid="scout-name-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Type to find your name"
          className="h-14 flex-1 text-lg"
          autoComplete="off"
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <ul className="grid grid-cols-2 gap-3 landscape:grid-cols-3">
        {filtered.map((r) => (
          <li key={r.id}>
            <Button
              data-testid={`scout-name-option-${r.name}`}
              size="big"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => void pick(r.name)}
            >
              {r.name}
            </Button>
          </li>
        ))}
        {roster.length === 0 && !error && (
          <li className="col-span-full text-sm text-muted-foreground">
            No scouters on the roster yet — ask your lead to add names.
          </li>
        )}
      </ul>
    </section>
  );
}

export default function ScoutHome() {
  const { scout } = useSession();
  const [picked, setPicked] = useState<ScoutRow | null>(null);
  const effective = scout ?? picked;
  const scoutId = effective?.id ?? '';

  // Resolve the active event without React Query (keeps this screen provider-free).
  const [activeEvent, setActiveEvent] = useState<string | null>(getStoredActiveEvent());
  useEffect(() => {
    if (activeEvent) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from('event')
        .select('event_key')
        .eq('is_active', true);
      const key = (data as { event_key: string }[] | null)?.[0]?.event_key ?? null;
      if (!cancelled) setActiveEvent(key);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeEvent]);

  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [drafts, setDrafts] = useState<CaptureDraft[]>([]);
  const [active, setActive] = useState<CaptureTarget | null>(null);

  const [matchKey, setMatchKey] = useState('');
  const [alliance, setAlliance] = useState<'red' | 'blue'>('red');
  const [station, setStation] = useState<1 | 2 | 3>(1);
  const [team, setTeam] = useState('');

  const refreshLocal = async () => {
    setDrafts(await listDrafts());
  };

  useEffect(() => {
    if (!scoutId) return;
    let cancelled = false;
    void (async () => {
      const res = await supabase.from('assignment').select('*').eq('scout_id', scoutId);
      if (!cancelled && res.data) {
        setAssignments(res.data as AssignmentRow[]);
      }
    })();
    void refreshLocal();
    return () => {
      cancelled = true;
    };
  }, [scoutId]);

  // Gate: no scouter selected yet on this device → pick a name (or wait for an event).
  if (!effective) {
    return (
      <div
        data-testid="scout-home"
        className="flex min-h-screen flex-col gap-6 bg-background p-4 text-foreground"
      >
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Scout</h1>
          <SyncIndicator />
        </header>
        {!activeEvent ? (
          <p data-testid="scout-no-event" className="text-muted-foreground">
            No active event yet. Ask your scouting lead to set the active event.
          </p>
        ) : (
          <NamePicker eventKey={activeEvent} onPicked={setPicked} />
        )}
      </div>
    );
  }

  if (active) {
    return (
      <CaptureFlow
        target={active}
        onDone={() => {
          setActive(null);
          void refreshLocal();
        }}
      />
    );
  }

  const eventKey = effective.event_key || activeEvent || '';

  const startFromAssignment = (a: AssignmentRow) => {
    setActive({
      eventKey: a.event_key,
      matchKey: a.match_key,
      scoutId,
      targetTeamNumber: a.target_team_number,
      allianceColor: a.alliance_color,
      station: a.station,
    });
  };

  const startManual = () => {
    setActive({
      eventKey,
      matchKey,
      scoutId,
      targetTeamNumber: Number(team),
      allianceColor: alliance,
      station,
    });
  };

  const onExport = async () => {
    const desc = await exportUnsyncedToFile();
    const a = document.createElement('a');
    a.href = desc.blobUrl;
    a.download = desc.filename;
    a.click();
    URL.revokeObjectURL(desc.blobUrl);
  };

  const switchScouter = () => {
    forgetScouterName();
    setPicked(null);
    setAssignments([]);
  };

  return (
    <div
      data-testid="scout-home"
      className="flex min-h-screen flex-col gap-6 bg-background p-4 text-foreground"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <UserRound className="size-6" />
          <h1 className="text-2xl font-bold">{effective.display_name || 'Scout'}</h1>
        </div>
        <div className="flex items-center gap-2">
          <SyncIndicator />
          <a
            data-testid="nav-my-data"
            href="/my-data"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
          >
            <BarChart3 className="size-5" /> My Data
          </a>
          <Button
            data-testid="scout-switch"
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Switch scouter"
            onClick={switchScouter}
          >
            <RefreshCw className="size-5" />
          </Button>
        </div>
      </header>

      <nav className="flex flex-wrap gap-3">
        <a
          data-testid="nav-qr-send"
          href="/qr/send"
          className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
        >
          Send via QR
        </a>
        <a
          data-testid="nav-qr-receive"
          href="/qr/receive"
          className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
        >
          Receive via QR
        </a>
      </nav>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Your assignments</h2>
        <ul className="flex flex-col gap-2">
          {assignments.map((a, i) => (
            <li key={`${a.match_key}-${i}`}>
              <Button
                data-testid="scout-assignment"
                variant="outline"
                size="big"
                className="w-full justify-between"
                onClick={() => startFromAssignment(a)}
              >
                <span>
                  {a.match_key} · {a.alliance_color} {a.station}
                </span>
                <span>#{a.target_team_number}</span>
              </Button>
            </li>
          ))}
          {assignments.length === 0 && (
            <li className="text-sm text-muted-foreground">No assignments.</li>
          )}
        </ul>
      </section>

      <section data-testid="scout-manual-pick" className="rounded-lg border border-border p-3">
        <h2 className="mb-2 text-lg font-semibold">Manual pick</h2>
        <div className="grid grid-cols-2 gap-3 landscape:grid-cols-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="mp-match">Match</Label>
            <Input id="mp-match" value={matchKey} onChange={(e) => setMatchKey(e.target.value)} className="min-h-[44px]" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mp-alliance">Alliance</Label>
            <select
              id="mp-alliance"
              value={alliance}
              onChange={(e) => setAlliance(e.target.value as 'red' | 'blue')}
              className="min-h-[44px] rounded border border-border bg-input px-2"
            >
              <option value="red">red</option>
              <option value="blue">blue</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mp-station">Station</Label>
            <select
              id="mp-station"
              value={station}
              onChange={(e) => setStation(Number(e.target.value) as 1 | 2 | 3)}
              className="min-h-[44px] rounded border border-border bg-input px-2"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mp-team">Target team</Label>
            <Input id="mp-team" type="number" value={team} onChange={(e) => setTeam(e.target.value)} className="min-h-[44px]" />
          </div>
        </div>
        <Button
          data-testid="scout-start-capture"
          size="big"
          className="mt-3 w-full"
          disabled={!matchKey || !team || !scoutId}
          onClick={startManual}
        >
          Start capture
        </Button>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Resume drafts</h2>
        <ul className="flex flex-col gap-2">
          {drafts.map((d) => (
            <li key={d.draftKey}>
              <Button
                data-testid={`scout-resume-${d.draftKey}`}
                variant="outline"
                className="h-12 min-h-[44px] w-full justify-start text-sm"
                onClick={() => {
                  const stored = (d.state as { target?: CaptureTarget } | null)?.target;
                  if (stored) {
                    setActive(stored);
                    return;
                  }
                  const [dMatch, dScout, dTeam] = d.draftKey.split(':');
                  setActive({
                    eventKey,
                    matchKey: dMatch,
                    scoutId: dScout || scoutId,
                    targetTeamNumber: Number(dTeam),
                    allianceColor: alliance,
                    station,
                  });
                }}
              >
                {d.draftKey}
              </Button>
            </li>
          ))}
          {drafts.length === 0 && <li className="text-sm text-muted-foreground">No drafts.</li>}
        </ul>
      </section>

      <Button variant="secondary" size="big" onClick={() => void onExport()}>
        Export unsynced
      </Button>
    </div>
  );
}
