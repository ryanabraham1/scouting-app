// src/pit/PitScoutFlow.tsx — the inline pit-scouting flow (team picker → form),
// shared by the /scout?mode=pit toggle (ScoutHome) and the legacy PitRoute.
// It takes an already-resolved scout identity + active event, so the user never
// re-picks their name when switching into pit mode.
import { useState } from 'react';
import { Hash, Wrench } from 'lucide-react';
import PitScoutScreen from './PitScoutScreen';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export interface PitScoutFlowProps {
  eventKey: string;
  scoutId: string;
}

/**
 * Pit-scouting flow with a single implementation. Renders a big team-number
 * picker; once a valid team is chosen it mounts <PitScoutScreen> for that team.
 * A "change team" affordance lets the scout return to the picker for the next
 * robot without leaving pit mode.
 */
export default function PitScoutFlow({ eventKey, scoutId }: PitScoutFlowProps): JSX.Element {
  const [teamInput, setTeamInput] = useState('');
  const [team, setTeam] = useState<number | null>(null);

  if (!eventKey) {
    return (
      <section data-testid="pit-flow" className="flex flex-col gap-3">
        <p data-testid="pit-no-event" className="text-muted-foreground">
          No active event yet. Ask your scouting lead to set the active event.
        </p>
      </section>
    );
  }

  if (team === null) {
    const valid = /^\d+$/.test(teamInput.trim());
    return (
      <section data-testid="pit-flow" className="flex flex-col gap-5">
        <div className="flex items-center gap-2">
          <Wrench className="size-6 text-brand" />
          <h2 className="text-xl font-semibold">Pit scouting</h2>
        </div>
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
          <Label htmlFor="pit-team-input" className="flex items-center gap-1.5 text-base">
            <Hash className="size-5 text-brand" />
            Team number
          </Label>
          <Input
            id="pit-team-input"
            data-testid="pit-team-input"
            inputMode="numeric"
            value={teamInput}
            onChange={(e) => setTeamInput(e.target.value)}
            placeholder="e.g. 254"
            className="h-14 text-lg"
            autoComplete="off"
          />
          <Button
            data-testid="pit-team-go"
            variant="brand"
            size="xl"
            className="mt-2 w-full gap-2"
            disabled={!valid}
            onClick={() => setTeam(Number(teamInput.trim()))}
          >
            <Wrench className="size-5" />
            Start pit scouting
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="pit-flow" className="flex flex-col gap-3">
      <Button
        data-testid="pit-change-team"
        variant="outline"
        size="big"
        className="w-full gap-2"
        onClick={() => {
          setTeam(null);
          setTeamInput('');
        }}
      >
        <Hash className="size-5" />
        Change team (Team {team})
      </Button>
      <PitScoutScreen eventKey={eventKey} teamNumber={team} scoutId={scoutId} />
    </section>
  );
}
