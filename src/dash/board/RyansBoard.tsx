// src/dash/board/RyansBoard.tsx
// Ryan's Board: the lead dashboard's infinite canvas, one board per event.
// Our own engine (editor.ts + BoardCanvas), built up from the Strategy-tab
// whiteboard: ink, highlighter, eraser, text, images, laser and live data
// widgets, saved on-device first and synced to the cloud.
// Plan and hand-off notes: docs/plans/ryans-board/README.md.
//
// Lazy-loaded by DashboardScreen, so none of this reaches the scout bundle.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BoardEditor } from '@/dash/board/editor';
import { BoardCanvas } from '@/dash/board/BoardCanvas';
import { Toolbar, StylePanel, ZoomControls, PANEL } from '@/dash/board/BoardChrome';
import { Minimap } from '@/dash/board/Minimap';
import { BoardTopBar } from '@/dash/board/BoardTopBar';
import { measureTextHeight } from '@/dash/board/measureText';
import { prepareImage } from '@/dash/board/images';
import {
  boardClientId,
  loadBoardRecords,
  loadCamera,
  loadPrefs,
  persistBoard,
} from '@/dash/board/persistence';
import { useBoard } from '@/dash/board/useBoard';
import { fetchBoardRecords, useBoardSyncState } from '@/dash/board/cloud';
import { BoardLive } from '@/dash/board/live';
import { PresenceStack, RemoteCursors, SyncChip } from '@/dash/board/Presence';
import { useSync } from '@/sync/useSync';
import { useEventMatches } from '@/dash/useEventData';
import { nextMatchForTeam } from '@/dash/nextMatch';
import { getStoredBaseTeam } from '@/dash/baseTeamStore';
import type { Point, WidgetShape } from '@/dash/board/model';
import { BoardDataProvider } from '@/dash/board/widgets/data';
import { WidgetFrame } from '@/dash/board/widgets/WidgetFrame';
import { WidgetInspector } from '@/dash/board/widgets/WidgetInspector';
import { WidgetTray } from '@/dash/board/widgets/WidgetTray';
import { Spotlight, useSearchContext } from '@/dash/board/Spotlight';
import { dropTeamsOnCompare, insertWidget } from '@/dash/board/widgets/actions';
import { search } from '@/dash/board/search/interpret';
import type { WidgetKind } from '@/dash/board/widgets/registry';
import { widgetMinSize } from '@/dash/board/widgets/registry';
import { WidgetActionsProvider } from '@/dash/board/widgets/interaction';
import { Comments } from '@/dash/board/Comments';
import { exportPng } from '@/dash/board/exportPng';
import { cn } from '@/lib/utils';

/**
 * Pasting a bare team number or match ("254", "qm32") drops its widget instead
 * of a text box. Registers a capture-phase paste listener ahead of the canvas.
 */
function SmartPaste({ editor }: { editor: BoardEditor }): null {
  const ctx = useSearchContext(editor);
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain')?.trim() ?? '';
      if (!text || text.length > 24 || editor.editingId) return;
      const a = document.activeElement;
      if (a instanceof HTMLElement && (a.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName))) return;
      const { interpretation, results } = search(text, ctx);
      const top = results[0];
      const exact =
        interpretation.complete &&
        interpretation.quality >= 0.95 &&
        interpretation.teams.length + interpretation.matches.length === 1 &&
        top?.widget &&
        (top.kind === 'team' || top.kind === 'match');
      if (!exact || !top?.widget) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      insertWidget(editor, top.widget.kind, top.widget.config);
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, [editor, ctx]);
  return null;
}

export default function RyansBoard({ eventKey }: { eventKey: string }): JSX.Element {
  const editor = useMemo(
    () =>
      new BoardEditor({ clientId: boardClientId(), measureText: measureTextHeight, widgetMinSize }),
    // One editor per event board.
    [eventKey],
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [expanded, setExpanded] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [presenting, setPresenting] = useState(false);
  const previousTool = useRef(editor.tool);
  const [trayOpen, setTrayOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => {
    setTrayOpen(false);
    setSearchOpen(true);
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const penMode = useBoard(editor, (e) => e.penMode);
  const live = useMemo(() => new BoardLive(editor, eventKey), [editor, eventKey]);
  const syncState = useBoardSyncState(eventKey);
  // Keep the shared sync controller mounted so board edits drain.
  useSync();

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
    // Pull the cloud copy and merge it (newer rev wins per record). Runs on
    // open and on every offline->online edge; realtime covers the rest.
    const pull = (): void => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      fetchBoardRecords(eventKey)
        .then((records) => {
          if (!cancelled) editor.applyRemote(records);
        })
        .catch((err: unknown) => console.warn("Ryan's Board: cloud pull failed", err));
    };
    loadBoardRecords(eventKey)
      .then((records) => {
        if (cancelled) return;
        editor.load(records);
        dispose = persistBoard(editor, eventKey);
        setStatus('ready');
        live.start();
        pull();
        window.addEventListener('online', pull);
      })
      .catch((err: unknown) => {
        console.error("Ryan's Board: local load failed", err);
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
      window.removeEventListener('online', pull);
      live.dispose();
      dispose?.();
    };
  }, [editor, eventKey, live]);

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

  const stopPresenting = useCallback(() => {
    setPresenting(false);
    editor.setTool(previousTool.current);
  }, [editor]);
  useEffect(() => {
    if (!presenting) return;
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); stopPresenting(); }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [presenting, stopPresenting]);

  const download = async (): Promise<void> => {
    setNotice('');
    setExporting(true);
    try {
      // Two frames let React mount all culled widgets before reading their DOM.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (boardRef.current) await exportPng(editor, boardRef.current, `ryans-board-${eventKey}.png`);
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Export failed.'); }
    finally { setExporting(false); }
  };

  const onImages = useCallback(
    (files: File[], at: Point | undefined) => {
      void (async () => {
        let i = 0;
        for (const f of files) {
          try {
            const img = await prepareImage(f);
            const base = at ?? editor.viewCenter();
            editor.insertImage(img.src, img.width, img.height, {
              x: base.x + i * 24,
              y: base.y + i * 24,
            });
            i += 1;
          } catch (err) {
            console.error("Ryan's Board: image import failed", err);
            setNotice("Could not import that image. Try a different image file.");
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

  const renderWidget = useCallback(
    (shape: WidgetShape): ReactNode => <WidgetFrame shape={shape} editor={editor} />,
    [editor],
  );

  return (
    <div
      ref={boardRef}
      data-testid="ryans-board"
      className={cn(
        'flex flex-col overflow-hidden bg-card',
        expanded
          ? 'fixed inset-0 z-50'
          : 'h-[calc(100dvh-11rem)] min-h-[420px] rounded-xl border border-border',
      )}
    >
      {!presenting && <BoardTopBar
        eventKey={eventKey}
        nextMatch={nextMatch}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((v) => !v)}
        onOpenSearch={status === 'ready' ? openSearch : undefined}
        status={<SyncChip state={syncState} />}
        presence={<PresenceStack live={live} />}
        exporting={exporting}
        onExport={status === 'ready' ? () => void download() : undefined}
        onPresent={status === 'ready' ? () => {
          previousTool.current = editor.tool;
          editor.setSelection([]);
          editor.setTool('laser');
          setSearchOpen(false);
          setTrayOpen(false);
          setExpanded(true);
          setPresenting(true);
        } : undefined}
      />}
      {notice && <div role="alert" className="flex items-center justify-between gap-2 bg-destructive/10 px-3 py-2 text-xs text-destructive">{notice}<button type="button" onClick={() => setNotice('')}>Dismiss</button></div>}
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
          <BoardDataProvider eventKey={eventKey}>
            <WidgetActionsProvider editor={editor}>
            <BoardCanvas
              editor={editor}
              exportAll={exporting}
              onDropTeams={(ids, at) => dropTeamsOnCompare(editor, ids, at, getStoredBaseTeam())}
              renderWidget={renderWidget}
              onImages={onImages}
              onPointerPage={(p) => live.setCursor(p)}
              onOpenSearch={openSearch}
              onDropWidget={(payload, at) => {
                try {
                  const w = JSON.parse(payload) as {
                    kind: WidgetKind;
                    config: Record<string, unknown>;
                  };
                  insertWidget(editor, w.kind, w.config, at);
                } catch {
                  // not ours
                }
              }}
              remote={live.remote}
            >
              <RemoteCursors editor={editor} live={live} />
              {!presenting && <><div data-board-chrome className="absolute left-3 top-3">
                <Toolbar
                  editor={editor}
                  large={penMode}
                  onPickImage={() => fileInput.current?.click()}
                  onOpenWidgets={() => setTrayOpen((v) => !v)}
                />
              </div>
              {trayOpen && (
                <div
                  data-board-chrome
                  className={cn('absolute top-3', penMode ? 'left-[76px]' : 'left-[62px]')}
                >
                  <WidgetTray
                    editor={editor}
                    onClose={() => setTrayOpen(false)}
                    onOpenSearch={openSearch}
                  />
                </div>
              )}
              <div
                data-board-chrome
                className="absolute right-3 top-3 flex flex-col items-end gap-2"
              >
                <Comments editor={editor} author={live.name} />
                <WidgetInspector editor={editor} />
                <StylePanel editor={editor} />
              </div>
              <div data-board-chrome className="absolute bottom-3 left-3">
                <ZoomControls editor={editor} large={penMode} />
              </div>
              <div data-board-chrome className="absolute bottom-3 right-3 hidden sm:block">
                <Minimap editor={editor} />
              </div>
              </>}
              {presenting && <button data-board-chrome type="button" onClick={stopPresenting} className="absolute right-3 top-3 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground opacity-40 hover:opacity-100">Exit presentation (Esc)</button>}
              <SmartPaste editor={editor} />
              {searchOpen && <Spotlight editor={editor} onClose={() => setSearchOpen(false)} />}
              {penMode && !presenting && (
                <div
                  data-board-chrome
                  className={cn(
                    PANEL,
                    'absolute bottom-3 left-1/2 hidden -translate-x-1/2 px-3 py-1.5 text-[11px] md:block',
                  )}
                >
                  Pencil draws, finger pans. Two-finger tap undoes.
                </div>
              )}
            </BoardCanvas>
            </WidgetActionsProvider>
          </BoardDataProvider>
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
