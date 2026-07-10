// src/dash/MatchupNotesModal.tsx
// Controlled editor sheet for one actual team's event-scoped strategy note.
// Pre-fills with the existing note; Save writes to Dexie 'dirty' (offline-first)
// via saveTeamStrategyNote and invalidates the notes query so the panel re-reads.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/button';
import { saveTeamStrategyNote } from '@/dash/matchupNotesClient';

export interface MatchupNotesModalProps {
  open: boolean;
  onClose: () => void;
  eventKey: string;
  /** The actual team this event-scoped note describes. */
  targetTeam: number;
  /** Match-relative context, e.g. "Our partner · Red alliance". */
  allianceContext: string;
  /** Existing note text to pre-fill. */
  initialNote: string;
}

export default function MatchupNotesModal({
  open,
  onClose,
  eventKey,
  targetTeam,
  allianceContext,
  initialNote,
}: MatchupNotesModalProps): JSX.Element {
  const queryClient = useQueryClient();
  const [text, setText] = useState(initialNote);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const openedEventRef = useRef(eventKey);
  // Freeze the team/context (and seed note) the editor opened against. The parent
  // recomputes the selected matchup from live data, so without this a background
  // refresh mid-edit could redirect Save to a different team — or
  // silently reset the in-progress note. Pinned to the open transition only.
  const [frozen, setFrozen] = useState({
    eventKey,
    targetTeam,
    allianceContext,
    note: initialNote,
  });

  // Re-sync the textarea + pinned pairing when the sheet opens. Intentionally
  // keyed on `open` alone: once editing, everything stays pinned to what the user
  // opened, immune to background team/note updates.
  useEffect(() => {
    if (open) {
      openedEventRef.current = eventKey;
      setText(initialNote);
      setSaveError(null);
      setFrozen({ eventKey, targetTeam, allianceContext, note: initialNote });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && openedEventRef.current !== eventKey) onClose();
  }, [eventKey, onClose, open]);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveTeamStrategyNote(frozen.eventKey, frozen.targetTeam, text);
      // React Query pauses network-backed refetches while offline. Update the
      // visible map directly from the just-persisted Dexie row so closing and
      // reopening this team's editor immediately shows the independent draft.
      queryClient.setQueryData<Map<string, string>>(
        ['matchup-notes', frozen.eventKey],
        (current) => new Map(current ?? []).set(saved.key, saved.note),
      );
      await queryClient.invalidateQueries({ queryKey: ['matchup-notes', frozen.eventKey] });
      onClose();
    } catch {
      setSaveError('Could not save this note on this device. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Strategy note for team ${frozen.targetTeam}`}
      initialFocusRef={textareaRef}
      data-testid="matchup-notes-sheet"
    >
      <div className="flex h-full flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          {frozen.allianceContext}. This event-scoped note follows team {frozen.targetTeam}{' '}
          across every matchup at this event.
        </p>
        <textarea
          ref={textareaRef}
          data-testid="matchup-notes-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Strategy for team ${frozen.targetTeam}…`}
          className="min-h-[200px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {saveError ? (
          <p role="alert" className="text-sm text-destructive">{saveError}</p>
        ) : null}
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
