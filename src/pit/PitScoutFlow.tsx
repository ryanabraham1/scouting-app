// src/pit/PitScoutFlow.tsx — the inline pit-scouting flow (team picker → form),
// shared by the /scout?mode=pit toggle (ScoutHome) and the legacy PitRoute.
// It takes an already-resolved scout identity + active event, so the user never
// re-picks their name when switching into pit mode.
import { useEffect, useState } from 'react';
import { Hash, Wrench } from 'lucide-react';
import PitScoutScreen from './PitScoutScreen';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { getCachedTeams } from '@/db/preloadClient';
import { supabase } from '@/lib/supabase';

export interface PitScoutFlowProps {
  eventKey: string;
  scoutId: string;
}

interface TeamOption {
  team_number: number;
  nickname: string | null;
}

/**
 * Load this event's team list for the pit-picker autocomplete. Local-first: the
 * offline preload cache answers instantly (and works with no network); when it's
 * empty (never preloaded) we fall back to the same `event_team → team` query the
 * dashboard uses. Best-effort — a failure just leaves the numeric input working
 * without suggestions.
 */
function useEventTeamOptions(eventKey: string): TeamOption[] {
  const [teams, setTeams] = useState<TeamOption[]>([]);
  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;
    void (async () => {
      // The cache read gets its own try: on devices where IndexedDB is broken
      // (Safari private mode etc.) it can throw, and it must fall THROUGH to
      // the network query rather than reject the whole IIFE unhandled —
      // those degraded devices are exactly who the fallback exists for.
      try {
        const cached = await getCachedTeams(eventKey);
        if (!cancelled && cached.length) {
          setTeams(cached.map((t) => ({ team_number: t.team_number, nickname: t.nickname })));
          return;
        }
      } catch {
        /* cache unavailable — fall through to the network */
      }
      try {
        const res = await supabase
          .from('event_team')
          .select('team:team(team_number,nickname)')
          .eq('event_key', eventKey);
        const nested =
          (res.data as unknown as Array<{ team: TeamOption | null }> | null) ?? [];
        const rows = nested
          .map((r) => r.team)
          .filter((t): t is TeamOption => t != null)
          .sort((a, b) => a.team_number - b.team_number);
        if (!cancelled) setTeams(rows);
      } catch {
        /* offline / no data — numeric input still works without suggestions */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventKey]);
  return teams;
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
  // Whether the autocomplete list is open (input focused). Selecting a team or
  // blurring closes it.
  const [open, setOpen] = useState(false);
  const teamOptions = useEventTeamOptions(eventKey);

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
    const trimmed = teamInput.trim();
    const valid = /^\d+$/.test(trimmed);
    const q = trimmed.toLowerCase();
    // Live suggestions: filter as soon as the scout starts typing. A digit query
    // matches team numbers by PREFIX (typing "2" → 254, 2643, 2854…); any query
    // also matches nicknames by substring. Empty + focused shows the roster to
    // browse. Capped so a big event's list stays snappy.
    const suggestions = (
      q === ''
        ? teamOptions
        : teamOptions.filter(
            (t) =>
              String(t.team_number).startsWith(q) ||
              (t.nickname ?? '').toLowerCase().includes(q),
          )
    ).slice(0, 8);
    const matched = valid
      ? teamOptions.find((t) => t.team_number === Number(trimmed))
      : undefined;
    const choose = (n: number): void => {
      setTeamInput(String(n));
      setOpen(false);
    };
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
          {/* Custom autocomplete (the native <datalist> only filters on the full
              value and its popup is unreliable). Suggestions render IN-FLOW
              below the input — pushing the hint + Start button down rather than
              overlaying them, so a tap aimed at Start can never land on a
              suggestion and silently swap the typed team number. */}
          <div>
            <Input
              id="pit-team-input"
              data-testid="pit-team-input"
              inputMode="numeric"
              role="combobox"
              aria-expanded={open && suggestions.length > 0}
              aria-controls="pit-team-options"
              aria-autocomplete="list"
              value={teamInput}
              onChange={(e) => {
                setTeamInput(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              // Delay close so a click/tap on an option registers first.
              onBlur={() => window.setTimeout(() => setOpen(false), 120)}
              placeholder="Start typing a team number…"
              className="h-14 font-mono text-lg tabular-nums"
              autoComplete="off"
            />
            {open && suggestions.length > 0 && (
              <ul
                id="pit-team-options"
                role="listbox"
                aria-label="Matching teams"
                data-testid="pit-team-options"
                className="mt-1 max-h-72 w-full overflow-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
              >
                {suggestions.map((t) => (
                  <li key={t.team_number} role="option" aria-selected={t.team_number === Number(trimmed)}>
                    <button
                      type="button"
                      data-testid={`pit-team-option-${t.team_number}`}
                      // onMouseDown fires before the input's blur, so the pick
                      // isn't lost to the blur-close.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(t.team_number);
                      }}
                      className="flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 text-left hover:bg-accent"
                    >
                      <span className="w-14 shrink-0 font-mono text-base font-semibold tabular-nums text-brand">
                        {t.team_number}
                      </span>
                      <span className="truncate text-sm text-muted-foreground">
                        {t.nickname ?? ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p
            data-testid="pit-team-match"
            className="min-h-[1.25rem] text-sm text-muted-foreground"
          >
            {matched ? (
              <span className="text-brand">
                {matched.nickname ?? `Team ${matched.team_number}`}
              </span>
            ) : valid && teamOptions.length > 0 ? (
              'Not on this event’s roster — double-check the number.'
            ) : (
              ''
            )}
          </p>
          <Button
            data-testid="pit-team-go"
            variant="brand"
            size="xl"
            className="w-full gap-2"
            disabled={!valid}
            onClick={() => setTeam(Number(trimmed))}
          >
            <Wrench className="size-5" />
            Start pit scouting
          </Button>
        </div>
      </section>
    );
  }

  const backToPicker = (): void => {
    setTeam(null);
    setTeamInput('');
  };

  return (
    <section data-testid="pit-flow" className="flex flex-col gap-3">
      <Button
        data-testid="pit-change-team"
        variant="outline"
        size="big"
        className="w-full gap-2"
        onClick={backToPicker}
      >
        <Hash className="size-5" />
        Change team (Team {team})
      </Button>
      <PitScoutScreen
        eventKey={eventKey}
        teamNumber={team}
        scoutId={scoutId}
        onDone={backToPicker}
      />
    </section>
  );
}
