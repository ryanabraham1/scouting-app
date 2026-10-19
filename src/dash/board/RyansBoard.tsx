// src/dash/board/RyansBoard.tsx
// Ryan's Board: the lead dashboard's infinite canvas, one board per event.
// Our own engine (editor.ts + BoardCanvas), built up from the Strategy-tab
// whiteboard: ink, highlighter, eraser, text, images, laser and live data
// widgets, saved on-device first and synced to the cloud.
// Plan and hand-off notes: docs/plans/ryans-board/README.md.
//
// Lazy-loaded by DashboardScreen, so none of this reaches the scout bundle.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HardDrive } from 'lucide-react';
import { BoardEditor } from '@/dash/board/editor';
import { BoardCanvas } from '@/dash/board/BoardCanvas';
import { Toolbar, StylePanel, ZoomControls, PANEL } from '@/dash/board/BoardChrome';
import { Minimap } from '@/dash/board/Minimap';
import { BoardTopBar } from '@/dash/board/BoardTopBar';
import { measureTextHeight } from '@/dash/board/measureText';
import { prepareImage } from '@/dash/board/images';
import {
  boardClientId,
  liveShapes,
  loadBoardRecords,
  loadCamera,
  loadPrefs,
  persistBoard,
} from '@/dash/board/persistence';
import { useBoard } from '@/dash/board/useBoard';
import { useEventMatches } from '@/dash/useEventData';
import { nextMatchForTeam } from '@/dash/nextMatch';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';
import type { Point, WidgetShape } from '@/dash/board/model';
import { cn } from '@/lib/utils';

function WidgetPlaceholder({ shape }: { shape: WidgetShape }): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-xl border border-border bg-card text-xs text-muted-foreground">
      {shape.kind}
    </div>
  );
}

export default function RyansBoard({ eventKey }: { eventKey: string }): JSX.Element {
  const editor = useMemo(
    () => new BoardEditor({ clientId: boardClientId(), measureText: measureTextHeight }),
    // One editor per event board.
    [eventKey],
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [expanded, setExpanded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const penMode = useBoard(editor, (e) => e.penMode);

  // Dev/e2e handle for inspecting the live editor (never shipped in prod builds).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __ryansBoard?: BoardEditor }).__ryansBoard = editor;
  }, [editor]);

  // Load this device's copy, then mirror every change back into it.
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;
    setStatus('loading');
    const prefs = loadPrefs();
    if (prefs.style) editor.style = { ...editor.style, ...prefs.style };
    if (prefs.tool && prefs.tool !== 'laser') editor.tool = prefs.tool;
    const cam = loadCamera(eventKey);
    editor.setCamera(cam ?? { x: 120, y: 80, z: 1 });
    loadBoardRecords(eventKey)
      .then((records) => {
        if (cancelled) return;
        editor.load(liveShapes(records));
        dispose = persistBoard(editor, eventKey);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        console.error("Ryan's Board: local load failed", err);
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [editor, eventKey]);

  // Esc leaves full screen once the canvas has nothing left to cancel.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (editor.editingId || editor.selection.size || editor.tool !== 'select') return;
      setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, editor]);

  const onImages = useCallback(
    (files: File[], at: Point | undefined) => {
      void (async () => {
        let i = 0;
        for (const f of files) {
          try {
            const img = await prepareImage(f);
            const base = at ?? editor.viewCenter();
            editor.insertImage(img.src, img.width, img.height, { x: base.x + i * 24, y: base.y + i * 24 });
            i += 1;
          } catch (err) {
            console.error("Ryan's Board: image import failed", err);
          }
        }
      })();
    },
    [editor],
  );

  const matchesQ = useEventMatches(eventKey);
  const nextMatch = useMemo(
    () => nextMatchForTeam(matchesQ.data ?? [], getStoredBaseTeam()),
    [matchesQ.data],
  );

  const renderWidget = useCallback((shape: WidgetShape): ReactNode => <WidgetPlaceholder shape={shape} />, []);

  const statusChip = (
    <span
      className="hidden shrink-0 items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 text-[11px] text-success sm:inline-flex"
      title="Cloud sync arrives in the next phase"
    >
      <HardDrive className="size-3" aria-hidden />
      Saved on this device
    </span>
  );

  return (
    <div
      data-testid="ryans-board"
      className={cn(
        'flex flex-col overflow-hidden bg-card',
        expanded ? 'fixed inset-0 z-50' : 'h-[calc(100dvh-11rem)] min-h-[420px] rounded-xl border border-border',
      )}
    >
      <BoardTopBar
        eventKey={eventKey}
        nextMatch={nextMatch}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((v) => !v)}
        status={statusChip}
      />
      <div className="relative min-h-0 flex-1">
        {status === 'loading' && (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading board…
          </p>
        )}
        {status === 'error' && (
          <p role="alert" className="p-4 text-sm text-destructive">
            Couldn&apos;t open this device&apos;s saved board. Reload to try again.
          </p>
        )}
        {status === 'ready' && (
          <BoardCanvas editor={editor} renderWidget={renderWidget} onImages={onImages}>
            <div data-board-chrome className="absolute left-3 top-3">
              <Toolbar editor={editor} large={penMode} onPickImage={() => fileInput.current?.click()} />
            </div>
            <div data-board-chrome className="absolute right-3 top-3">
              <StylePanel editor={editor} />
            </div>
            <div data-board-chrome className="absolute bottom-3 left-3">
              <ZoomControls editor={editor} large={penMode} />
            </div>
            <div data-board-chrome className="absolute bottom-3 right-3 hidden sm:block">
              <Minimap editor={editor} />
            </div>
            {penMode && (
              <div data-board-chrome className={cn(PANEL, 'absolute bottom-3 left-1/2 hidden -translate-x-1/2 px-3 py-1.5 text-[11px] md:block')}>
                Pencil draws, finger pans. Two-finger tap undoes.
              </div>
            )}
          </BoardCanvas>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) onImages(files, undefined);
          }}
        />
      </div>
    </div>
  );
}
