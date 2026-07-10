// src/dash/MatchupPanel.tsx
// Alliance Matchup synthesis card + per-opponent notes (matchup-intelligence).
// Mounted on the Next Match tab between the win-prob banner and the alliance
// columns. Pure read of the already-computed `agg` map (no extra query) for the
// synthesis bullets; notes come from useMatchupNotes (server + Dexie merge).
import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  synthesizeMatchupGuidance,
  type AllianceGuidance,
  type Tactic,
  type TeamAgg,
} from '@/dash/aggregate';
import { useMatchupNotes } from '@/dash/useEventData';
import { normalizeMatchup, keyFor, teamNoteKeyFor } from '@/dash/matchupNotesClient';
import MatchupNotesModal from '@/dash/MatchupNotesModal';

export interface MatchupPanelProps {
  eventKey: string;
  redTeams: number[];
  blueTeams: number[];
  /** Which alliance is OURS, or null when baseTeam is in neither (manual select). */
  ourSide: 'red' | 'blue' | null;
  redAggs: (TeamAgg | undefined)[];
  blueAggs: (TeamAgg | undefined)[];
}

function SeverityDot({ severity }: { severity: Tactic['severity'] }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-1.5 inline-block size-2 shrink-0 rounded-full',
        severity === 'high' ? 'bg-warning' : 'bg-muted-foreground/60',
      )}
    />
  );
}

function TacticList({ tactics, emptyHint }: { tactics: Tactic[]; emptyHint: string }) {
  if (tactics.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyHint}</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {tactics.map((t, i) => (
        <li key={`${t.kind}-${t.teamNumber}-${i}`} className="flex items-start gap-2 text-sm text-foreground">
          <SeverityDot severity={t.severity} />
          <span>{t.text}</span>
        </li>
      ))}
    </ul>
  );
}

interface AllianceBlockProps {
  side: 'red' | 'blue';
  guidance: AllianceGuidance;
  /** Verb framing: 'opponent' = Exploit/Watch, 'ours' = edges/risks, 'neutral' = per-color. */
  framing: 'opponent' | 'ours' | 'neutral';
  note: string;
  onOpenNotes: () => void;
}

function AllianceBlock({ side, guidance, framing, note, onOpenNotes }: AllianceBlockProps) {
  const color = side === 'red' ? 'Red' : 'Blue';
  let threatLabel: string;
  let exploitLabel: string;
  if (framing === 'opponent') {
    threatLabel = 'Watch (their threats)';
    exploitLabel = 'Exploit (their weaknesses)';
  } else if (framing === 'ours') {
    threatLabel = 'Our risks';
    exploitLabel = 'Our edges';
  } else {
    threatLabel = `${color} threats`;
    exploitLabel = `${color} weaknesses`;
  }
  const hasNote = note.trim().length > 0;

  return (
    <div
      data-testid={`matchup-alliance-${side}`}
      className={cn(
        'flex flex-col gap-3 rounded-lg border p-3',
        side === 'red' ? 'border-red-500/40' : 'border-blue-500/40',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'text-xs font-bold uppercase tracking-wider',
            side === 'red' ? 'text-red-400' : 'text-blue-400',
          )}
        >
          {framing === 'ours' ? `Us — ${color}` : color}
        </span>
        {hasNote ? (
          <span
            data-testid="matchup-note-badge"
            aria-label="matchup note exists"
            className="inline-block size-2 rounded-full bg-energy"
          />
        ) : null}
      </div>

      {!guidance.scouted ? (
        <p className="text-sm text-muted-foreground">No scouting data yet</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {exploitLabel}
            </div>
            <TacticList tactics={guidance.exploits} emptyHint="No clear weakness." />
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {threatLabel}
            </div>
            <TacticList tactics={guidance.threats} emptyHint="No standout threat." />
          </div>
        </div>
      )}

      {/* Notes footer. */}
      <div className="mt-1 flex items-center justify-between gap-2 border-t border-border pt-2">
        <div className="min-w-0 flex-1">
          {hasNote ? (
            <span
              data-testid="matchup-note-text"
              className="block truncate text-xs text-foreground"
              title={note}
            >
              {note}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">No note yet.</span>
          )}
        </div>
        <button
          type="button"
          data-testid="matchup-notes-btn"
          onClick={onOpenNotes}
          className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-border bg-card/60 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
        >
          Notes
        </button>
      </div>
    </div>
  );
}

export default function MatchupPanel({
  eventKey,
  redTeams,
  blueTeams,
  ourSide,
  redAggs,
  blueAggs,
}: MatchupPanelProps): JSX.Element {
  const guidance = useMemo(
    () => synthesizeMatchupGuidance(redAggs, blueAggs),
    [redAggs, blueAggs],
  );

  const notesQ = useMatchupNotes(eventKey);
  const notes = notesQ.data;

  // Which alliance's representative-team editor is open, or null when closed.
  const [editing, setEditing] = useState<'red' | 'blue' | null>(null);

  const targetFor = (side: 'red' | 'blue'): number => {
    const teams = side === 'red' ? redTeams : blueTeams;
    return teams.length ? Math.min(...teams) : 0;
  };

  // This legacy, currently-unmounted synthesis panel keeps its one-note footer,
  // but writes that footer as a real team note. A V1 alliance-pair row remains a
  // read fallback until the note is next saved into the collision-free namespace.
  const noteFor = (side: 'red' | 'blue'): string => {
    const target = targetFor(side);
    const currentKey = teamNoteKeyFor(eventKey, target);
    if (notes?.has(currentKey)) return notes.get(currentKey) ?? '';
    const oursTeams = side === 'red' ? blueTeams : redTeams; // notes attach to the OTHER side as "ours"
    const oppTeams = side === 'red' ? redTeams : blueTeams;
    const { ourTeam, oppTeam } = normalizeMatchup(oursTeams, oppTeams);
    return notes?.get(keyFor(eventKey, ourTeam, oppTeam)) ?? '';
  };

  // Framing per side: when we're on an alliance, the OTHER alliance is the
  // opponent (Exploit/Watch) and ours is edges/risks. When ourSide is null,
  // both use neutral per-color labels so nothing is mislabeled.
  const framingFor = (side: 'red' | 'blue'): AllianceBlockProps['framing'] => {
    if (ourSide == null) return 'neutral';
    return side === ourSide ? 'ours' : 'opponent';
  };

  const editorProps = useMemo(() => {
    if (editing == null) return null;
    const targetTeam = targetFor(editing);
    return {
      targetTeam,
      allianceContext: `${editing === 'red' ? 'Red' : 'Blue'} alliance`,
      initialNote: noteFor(editing),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, redTeams, blueTeams, notes, eventKey]);

  return (
    <Card data-testid="dash-matchup-panel" className="border border-border">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-foreground">Alliance Matchup</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <AllianceBlock
            side="red"
            guidance={guidance.red}
            framing={framingFor('red')}
            note={noteFor('red')}
            onOpenNotes={() => setEditing('red')}
          />
          <AllianceBlock
            side="blue"
            guidance={guidance.blue}
            framing={framingFor('blue')}
            note={noteFor('blue')}
            onOpenNotes={() => setEditing('blue')}
          />
        </div>
      </CardContent>

      {editing != null && editorProps != null ? (
        <MatchupNotesModal
          open
          onClose={() => setEditing(null)}
          eventKey={eventKey}
          targetTeam={editorProps.targetTeam}
          allianceContext={editorProps.allianceContext}
          initialNote={editorProps.initialNote}
        />
      ) : null}
    </Card>
  );
}
