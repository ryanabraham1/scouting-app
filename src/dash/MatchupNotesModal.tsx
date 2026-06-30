// src/dash/MatchupNotesModal.tsx
// Controlled editor sheet for a per-opponent matchup note (matchup-intelligence).
// Pre-fills with the existing note; Save writes to Dexie 'dirty' (offline-first)
// via saveMatchupNote and invalidates the notes query so the panel re-reads.
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/button';
import { saveMatchupNote } from '@/dash/matchupNotesClient';

export interface MatchupNotesModalProps {
  open: boolean;
  onClose: () => void;
  eventKey: string;
  /** The "our" alliance teams for the keyed pairing (min = our lead). */
  ourTeams: number[];
  /** The opponent alliance teams (min = the opponent lead the note keys on). */
  oppTeams: number[];
  /** The opponent alliance lead shown in the header (the min of oppTeams). */
  oppLead: number;
  /** Existing note text to pre-fill. */
  initialNote: string;
}

export default function MatchupNotesModal({
  open,
  onClose,
  eventKey,
  ourTeams,
  oppTeams,
  oppLead,
  initialNote,
}: MatchupNotesModalProps): JSX.Element {
  const queryClient = useQueryClient();
  const [text, setText] = useState(initialNote);
  const [saving, setSaving] = useState(false);

  // Re-sync the textarea when the sheet (re)opens or the source note changes.
  useEffect(() => {
    if (open) setText(initialNote);
  }, [open, initialNote]);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await saveMatchupNote(eventKey, ourTeams, oppTeams, text);
      await queryClient.invalidateQueries({ queryKey: ['matchup-notes', eventKey] });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Notes vs alliance lead ${oppLead}`}
      data-testid="matchup-notes-sheet"
    >
      <div className="flex h-full flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Event-scoped note keyed on the alliance lead team — it resurfaces for any
          future match against alliance lead {oppLead} at this event.
        </p>
        <textarea
          data-testid="matchup-notes-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. deny their feed lane; 254 climbs every match"
          className="min-h-[200px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="brand"
            size="sm"
            data-testid="matchup-notes-save"
            disabled={saving}
            onClick={() => void onSave()}
          >
            Save
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
