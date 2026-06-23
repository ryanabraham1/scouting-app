import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/auth/useSession';
import { listDrafts, countUnsynced } from '@/db/localStore';
import type { CaptureDraft } from '@/db/types';
import { CaptureScreen } from '@/capture/CaptureScreen';
import { ReviewScreen } from '@/capture/ReviewScreen';
import { useCaptureSession, type CaptureTarget } from '@/capture/useCaptureSession';
import { exportUnsyncedToFile } from '@/export/exportReports';

interface AssignmentRow {
  match_key: string;
  alliance_color: 'red' | 'blue';
  station: 1 | 2 | 3;
  target_team_number: number;
  event_key: string;
}

// Owns ONE capture session shared across the LIVE (CaptureScreen) and DEFERRED
// (ReviewScreen) tiers so deferred edits land in the same Save.
function CaptureFlow(props: { target: CaptureTarget; onDone: () => void }) {
  const session = useCaptureSession(props.target);
  const [stage, setStage] = useState<'live' | 'review'>('live');
  if (stage === 'review') {
    return <ReviewScreen session={session} onSaved={() => props.onDone()} />;
  }
  return <CaptureScreen session={session} onToReview={() => setStage('review')} />;
}

export default function ScoutHome() {
  const { scout } = useSession();
  const scoutId = scout?.id ?? '';
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [drafts, setDrafts] = useState<CaptureDraft[]>([]);
  const [unsynced, setUnsynced] = useState(0);
  const [active, setActive] = useState<CaptureTarget | null>(null);

  const [eventKey, setEventKey] = useState('');
  const [matchKey, setMatchKey] = useState('');
  const [alliance, setAlliance] = useState<'red' | 'blue'>('red');
  const [station, setStation] = useState<1 | 2 | 3>(1);
  const [team, setTeam] = useState('');

  const refreshLocal = async () => {
    setDrafts(await listDrafts());
    setUnsynced(await countUnsynced());
  };

  useEffect(() => {
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
    // Release the object URL once the download has been initiated.
    URL.revokeObjectURL(desc.blobUrl);
  };

  return (
    <div
      data-testid="scout-home"
      className="flex min-h-screen flex-col gap-6 bg-background p-4 text-foreground"
    >
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Scout</h1>
        <span className="text-sm text-muted-foreground">Unsynced: {unsynced}</span>
      </header>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Your assignments</h2>
        <ul className="flex flex-col gap-2">
          {assignments.map((a, i) => (
            <li key={`${a.match_key}-${i}`}>
              <Button
                data-testid="scout-assignment"
                variant="outline"
                className="h-14 min-h-[44px] w-full justify-between"
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

      <section
        data-testid="scout-manual-pick"
        className="rounded-lg border border-border p-3"
      >
        <h2 className="mb-2 text-lg font-semibold">Manual pick</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="mp-event">Event</Label>
            <Input
              id="mp-event"
              value={eventKey}
              onChange={(e) => setEventKey(e.target.value)}
              className="min-h-[44px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mp-match">Match</Label>
            <Input
              id="mp-match"
              value={matchKey}
              onChange={(e) => setMatchKey(e.target.value)}
              className="min-h-[44px]"
            />
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
          <div className="col-span-2 flex flex-col gap-1">
            <Label htmlFor="mp-team">Target team</Label>
            <Input
              id="mp-team"
              type="number"
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              className="min-h-[44px]"
            />
          </div>
        </div>
        <Button
          data-testid="scout-start-capture"
          className="mt-3 h-14 min-h-[44px] w-full text-lg"
          disabled={!matchKey || !team}
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
                  // New drafts store their full CaptureTarget — resume from it so
                  // the report keeps its original event/alliance/station/team.
                  const stored = (d.state as { target?: CaptureTarget } | null)?.target;
                  if (stored) {
                    setActive(stored);
                    return;
                  }
                  // Legacy draft (pre-target): reconstruct from the key + form.
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

      <Button variant="secondary" className="h-14 min-h-[44px]" onClick={() => void onExport()}>
        Export unsynced
      </Button>
    </div>
  );
}
