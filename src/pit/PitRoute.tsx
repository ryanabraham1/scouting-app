// src/pit/PitRoute.tsx — minimal /pit entry: pick a team, then render PitScoutScreen.
import { useState } from 'react';
import { useSession } from '@/auth/useSession';
import PitScoutScreen from './PitScoutScreen';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export default function PitRoute(): JSX.Element {
  const { scout } = useSession();
  const [teamInput, setTeamInput] = useState('');
  const [team, setTeam] = useState<number | null>(null);

  if (!scout) {
    return (
      <main data-testid="pit-route" className="mx-auto max-w-sm p-6">
        <p className="text-sm text-muted-foreground">Join an event first to pit scout.</p>
      </main>
    );
  }

  if (team === null) {
    const valid = /^\d+$/.test(teamInput.trim());
    return (
      <main data-testid="pit-route" className="mx-auto flex max-w-sm flex-col gap-4 p-6">
        <h1 className="text-xl font-bold">Pit Scouting</h1>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pit-team-input">Team number</Label>
          <Input
            id="pit-team-input"
            data-testid="pit-team-input"
            inputMode="numeric"
            value={teamInput}
            onChange={(e) => setTeamInput(e.target.value)}
            className="h-11"
          />
        </div>
        <Button
          data-testid="pit-team-go"
          className="h-11"
          disabled={!valid}
          onClick={() => setTeam(Number(teamInput.trim()))}
        >
          Start pit scouting
        </Button>
      </main>
    );
  }

  return <PitScoutScreen eventKey={scout.event_key} teamNumber={team} scoutId={scout.id} />;
}
