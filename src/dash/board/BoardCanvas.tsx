// src/dash/board/BoardCanvas.tsx
// The board viewport: input routing (mouse, trackpad, touch, Apple Pencil,
// keyboard, clipboard, drag-and-drop) into the BoardEditor, and the render
// stack (dot grid -> world layer -> selection overlay -> live canvases -> text
// editor -> chrome). Plan: docs/plans/ryans-board/README.md §3, §5.4–5.7.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  startTransition,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useBoard } from '@/dash/board/useBoard';
import type { BoardEditor, PointerInfo, Tool } from '@/dash/board/editor';
import { visibleShapesSnapshot } from '@/dash/board/viewport';
import { ShapeView } from '@/dash/board/ShapeView';
import { SelectionOverlay } from '@/dash/board/SelectionOverlay';
import { LiveCanvas, type LiveCanvasProps } from '@/dash/board/LiveCanvas';
import { TextEditor } from '@/dash/board/TextEditor';
import { imageFilesOf } from '@/dash/board/images';

/** Must match Spotlight's WIDGET_DRAG_TYPE (kept here to avoid a module cycle). */
const WIDGET_DRAG_TYPE = 'application/x-ryans-board-widget';
import { type Point, type WidgetShape } from '@/dash/board/model';

/** After Pencil input, finger/palm touches are ignored this long (FieldWhiteboard). */
const PEN_PRIORITY_MS = 2500;
const TAP_MAX_MS = 250;
const TAP_MAX_MOVE = 10;
const GRID_STEP = 24;

const CURSOR: Record<Tool, string> = {
  select: 'default',
  hand: 'grab',
  pen: 'crosshair',
  highlighter: 'crosshair',
  eraser: 'cell',
  text: 'text',
  laser: 'crosshair',
  comment: 'crosshair',
};

/** Elements inside a card that keep their own clicks and drags. */
const CONTROL_SELECTOR =
  'button,a,input,select,textarea,label,summary,iframe,video,audio,[role="button"],[role="link"],[role="slider"],[draggable="true"],[contenteditable="true"]';

/** Can this element (or a scrollable ancestor inside it) scroll further by (dx, dy)? */
function canScroll(el: HTMLElement, dx: number, dy: number): boolean {
  const y = dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : dy < 0 ? el.scrollTop > 0 : false;
  const x = dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : dx < 0 ? el.scrollLeft > 0 : false;
  return Math.abs(dy) >= Math.abs(dx) ? y : x;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

export interface BoardCanvasProps {
  editor: BoardEditor;
  renderWidget: (shape: WidgetShape) => ReactNode;
  onImages: (files: File[], at: Point | undefined) => void;
  /** Plain text pasted that isn't board JSON (spotlight may turn it into a widget). */
  onPasteText?: (text: string, at: Point) => boolean;
  onPointerPage?: (p: Point | null) => void;
  onOpenSearch?: () => void;
  /** A spotlight result dragged onto the canvas (JSON payload of WIDGET_DRAG_TYPE). */
  onDropWidget?: (payload: string, at: Point) => void;
  remote?: LiveCanvasProps['remote'];
  exportAll?: boolean;
  onDropTeams?: (ids: string[], at: Point) => void;
  /** Floating chrome rendered above the canvas. */
  children?: ReactNode;
}

interface TouchTrack {
  sx: number;
  sy: number;
  startSx: number;
  startSy: number;
}

export function BoardCanvas({
  editor,
  renderWidget,
  onImages,
  onPasteText,
  onPointerPage,
  onOpenSearch,
  onDropWidget,
  remote,
  exportAll = false,
  onDropTeams,
  children,
}: BoardCanvasProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const worldRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const snapshot = useMemo(() => visibleShapesSnapshot(editor, exportAll), [editor, exportAll]);
  // Edits re-render immediately; camera-driven changes to the visible set
  // (new cards scrolling or zooming into range) mount in a background
  // transition, so a batch of widgets never blocks a frame of the pan.
  const [visible, setVisible] = useState(snapshot);
  useEffect(() => {
    let last = snapshot();
    let order = editor.order;
    setVisible(last);
    return editor.subscribe(() => {
      const next = snapshot();
      if (next === last) return;
      last = next;
      if (editor.order !== order || exportAll) {
        order = editor.order;
        setVisible(next);
      } else {
        startTransition(() => setVisible(next));
      }
    });
  }, [editor, snapshot, exportAll]);
  const pendingErase = useBoard(editor, (e) => e.pendingErase);
  const editingId = useBoard(editor, (e) => e.editingId);
  const tool = useBoard(editor, (e) => e.effectiveTool);
  const penMode = useBoard(editor, (e) => e.penMode);
  const [panning, setPanning] = useState(false);

  const touches = useRef(new Map<number, TouchTrack>());
  const pinch = useRef<{ dist: number; mid: Point; cam: { x: number; y: number; z: number } } | null>(null);
  const tap = useRef<{ start: number; max: number; moved: boolean } | null>(null);
  const lastPenAt = useRef(0);
  const panPointer = useRef<number | null>(null);
  const lastPointer = useRef<Point | null>(null);

  // Viewport size.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: width, h: height });
      editor.setViewport(width, height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [editor]);

  const local = useCallback((clientX: number, clientY: number): Point => {
    const r = ref.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }, []);

  const info = useCallback(
    (e: React.PointerEvent, bounds = ref.current!.getBoundingClientRect()): PointerInfo => {
      const p = { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
      const native = e.nativeEvent;
      const coalesced = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      const pressureOf = (ev: { pointerType: string; pressure: number }): number =>
        ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 0.5;
      return {
        sx: p.x,
        sy: p.y,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        pressure: pressureOf(e),
        button: e.button,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey || e.ctrlKey,
        samples:
          coalesced.length > 0
            ? coalesced.map((c) => {
                const q = { x: c.clientX - bounds.left, y: c.clientY - bounds.top };
                return { sx: q.x, sy: q.y, pressure: pressureOf(c) };
              })
            : undefined,
      };
    },
    [],
  );

  // ---------------------------------------------------------------- pointers
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-board-interactive]')) {
      // A card's body belongs to the card only for real controls, or once the
      // card is selected (scroll it, select its text). Otherwise a press grabs
      // and moves the card like its header, and pan gestures always pan.
      const pan = e.button === 1 || editor.spaceHeld || editor.tool === 'hand';
      const control = target.closest(CONTROL_SELECTOR);
      const id = target.closest('[data-shape-id]')?.getAttribute('data-shape-id');
      const owned = id != null && editor.selection.size === 1 && editor.selection.has(id);
      if (!pan && (control || owned)) return;
    }
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('[data-board-chrome]')) return;
    ref.current?.focus({ preventScroll: true });
    if (editingId) return; // the textarea's blur commits first
    const p = local(e.clientX, e.clientY);
    if (e.pointerType === 'pen') lastPenAt.current = Date.now();

    if (e.pointerType === 'touch') {
      if (Date.now() - lastPenAt.current < PEN_PRIORITY_MS && !touches.current.size) return;
      touches.current.set(e.pointerId, { sx: p.x, sy: p.y, startSx: p.x, startSy: p.y });
      e.currentTarget.setPointerCapture(e.pointerId);
      const n = touches.current.size;
      if (n === 1) tap.current = { start: Date.now(), max: 1, moved: false };
      else if (tap.current) tap.current.max = Math.max(tap.current.max, n);
      if (n === 2) {
        editor.cancelGesture();
        panPointer.current = null;
        const [a, b] = [...touches.current.values()];
        pinch.current = {
          dist: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1,
          mid: { x: (a.sx + b.sx) / 2, y: (a.sy + b.sy) / 2 },
          cam: editor.camera,
        };
        return;
      }
      if (n > 2) return;
      // One finger: pans when a Pencil has been seen (finger never draws), else
      // acts like the mouse with the current tool.
      if (penMode) {
        panPointer.current = e.pointerId;
        editor.pointerDown(info(e), { forcePan: true });
        setPanning(true);
        return;
      }
    } else {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const forcePan = e.button === 1;
    if (forcePan || editor.effectiveTool === 'hand') setPanning(true);
    editor.pointerDown(info(e), { forcePan, handleHitPx: penMode || e.pointerType !== 'mouse' ? 18 : 9 });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const bounds = ref.current!.getBoundingClientRect();
    const p = { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
    lastPointer.current = p;
    onPointerPage?.(editor.screenToPage(p.x, p.y));
    if (e.pointerType === 'touch') {
      const t = touches.current.get(e.pointerId);
      if (!t) return;
      t.sx = p.x;
      t.sy = p.y;
      if (tap.current && Math.hypot(p.x - t.startSx, p.y - t.startSy) > TAP_MAX_MOVE) tap.current.moved = true;
      if (pinch.current && touches.current.size >= 2) {
        const [a, b] = [...touches.current.values()];
        const dist = Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1;
        const mid = { x: (a.sx + b.sx) / 2, y: (a.sy + b.sy) / 2 };
        const s = pinch.current;
        const z = Math.min(8, Math.max(0.1, s.cam.z * (dist / s.dist)));
        // Keep the page point under the starting midpoint under the current midpoint.
        const px = (s.mid.x - s.cam.x) / s.cam.z;
        const py = (s.mid.y - s.cam.y) / s.cam.z;
        editor.setCamera({ x: mid.x - px * z, y: mid.y - py * z, z });
        return;
      }
    }
    editor.pointerMove(info(e, bounds));
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    if (e.pointerType === 'touch') {
      const had = touches.current.delete(e.pointerId);
      if (!had) return;
      if (touches.current.size < 2) pinch.current = null;
      if (touches.current.size === 0) {
        const t = tap.current;
        tap.current = null;
        if (t && !t.moved && Date.now() - t.start < TAP_MAX_MS) {
          if (t.max === 2) editor.undo();
          else if (t.max === 3) editor.redo();
        }
      }
      if (touches.current.size > 0 && panPointer.current !== e.pointerId) return;
    }
    if (panPointer.current === e.pointerId) panPointer.current = null;
    setPanning(false);
    const drag = editor.live.drag;
    if (cancelled) editor.cancelGesture();
    else {
      editor.pointerUp(info(e));
      if (drag) { const p = local(e.clientX, e.clientY); onDropTeams?.(drag.ids, editor.screenToPage(p.x, p.y)); }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('[data-board-chrome]')) return;
    if (editor.tool !== 'select') return;
    const p = local(e.clientX, e.clientY);
    const hit = editor.shapeAtScreen(p.x, p.y);
    if (hit?.type === 'widget') { editor.cancelGesture(); editor.setSelection([hit.id]); }
    else if (hit?.type === 'text') editor.startEditing(hit.id);
    else if (!hit) editor.beginTextAt(editor.screenToPage(p.x, p.y));
  };

  // ------------------------------------------------------------------ wheel
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      const r = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      const scroller = (e.target as HTMLElement).closest?.('[data-board-scroll]') as HTMLElement | null;
      if (scroller && !e.ctrlKey && !e.metaKey) {
        const card = scroller.closest('[data-shape-id]');
        // Chrome overlays (spotlight, tray, inspector) scroll natively.
        if (!card) return;
        // The wheel pans the board, never a card in passing: only a SELECTED
        // card with room to scroll that way keeps it. Panning across a wall of
        // widgets would otherwise stall every time the cursor crossed one.
        const id = card.getAttribute('data-shape-id');
        if (id && editor.selection.size === 1 && editor.selection.has(id) && canScroll(scroller, dx, dy)) return;
      }
      e.preventDefault();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch (ctrl+wheel) or Cmd+wheel: zoom about the cursor.
        editor.zoomAt(sx, sy, editor.camera.z * Math.exp(-dy * 0.01));
      } else if (e.shiftKey && dx === 0) {
        editor.panBy(-dy, 0);
      } else {
        editor.panBy(-dx, -dy);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // Safari trackpad pinch arrives as gesture events.
    let gestureStart = 1;
    const onGestureStart = (e: Event): void => {
      e.preventDefault();
      gestureStart = editor.camera.z;
    };
    const onGestureChange = (e: Event): void => {
      e.preventDefault();
      const ge = e as Event & { scale: number; clientX: number; clientY: number };
      const r = el.getBoundingClientRect();
      editor.zoomAt(ge.clientX - r.left, ge.clientY - r.top, gestureStart * ge.scale);
    };
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, [editor]);

  // --------------------------------------------------------------- keyboard
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    if (isTypingTarget(e.target) || editor.editingId) return;
    if (e.key !== 'Escape' && e.target instanceof HTMLElement && e.target.closest('[data-board-interactive]')) return;
    // Another dialog/menu owns the keyboard.
    if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"],[role="menu"]') && !ref.current?.contains(e.target)) return;
    if (!ref.current || !ref.current.isConnected) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const handled = ((): boolean => {
      if (e.key === ' ') {
        if (!e.repeat) editor.setSpaceHeld(true);
        return true;
      }
      if (mod && k === 'z') {
        if (e.shiftKey) editor.redo();
        else editor.undo();
        return true;
      }
      if (mod && k === 'y') {
        editor.redo();
        return true;
      }
      if (mod && k === 'a') {
        editor.selectAll();
        return true;
      }
      if (mod && k === 'd') {
        editor.duplicateSelection();
        return true;
      }
      if (mod && k === 'k') {
        onOpenSearch?.();
        return true;
      }
      if (mod && e.shiftKey && k === 'l') {
        editor.toggleLock();
        return true;
      }
      if (mod && (e.key === '=' || e.key === '+')) {
        editor.zoomStep(1);
        return true;
      }
      if (mod && e.key === '-') {
        editor.zoomStep(-1);
        return true;
      }
      if (mod && e.key === ']') {
        editor.reorder('front');
        return true;
      }
      if (mod && e.key === '[') {
        editor.reorder('back');
        return true;
      }
      if (mod) return false;
      if (e.shiftKey && (e.code === 'Digit1' || e.key === '!')) {
        editor.zoomToFit();
        return true;
      }
      if (e.shiftKey && (e.code === 'Digit2' || e.key === '@')) {
        editor.zoomToSelection();
        return true;
      }
      if (e.shiftKey && (e.code === 'Digit0' || e.key === ')')) {
        editor.resetZoom();
        return true;
      }
      switch (e.key) {
        case 'Escape':
          if (editor.selection.size) editor.setSelection([]);
          else if (editor.tool !== 'select') editor.setTool('select');
          else return false; // Let the board leave full screen when nothing needs cancelling.
          return true;
        case 'Delete':
        case 'Backspace':
          editor.deleteSelection();
          return true;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          if (!editor.selection.size) return false;
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          editor.nudge(dx * editor.camera.z, dy * editor.camera.z);
          return true;
        }
        case ']':
          editor.reorder('forward');
          return true;
        case '[':
          editor.reorder('backward');
          return true;
        case '+':
        case '=':
          editor.zoomStep(1);
          return true;
        case '-':
        case '_':
          editor.zoomStep(-1);
          return true;
        case '/':
          onOpenSearch?.();
          return true;
      }
      const tools: Record<string, Tool> = {
        v: 'select',
        h: 'hand',
        p: 'pen',
        d: 'pen',
        m: 'highlighter',
        e: 'eraser',
        t: 'text',
        k: 'laser',
        c: 'comment',
      };
      if (tools[k] && !e.shiftKey && !e.altKey) {
        editor.setTool(tools[k]);
        return true;
      }
      return false;
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') editor.setSpaceHeld(false);
  };

  const keyRef = useRef({ onKeyDown, onKeyUp });
  keyRef.current = { onKeyDown, onKeyUp };
  useEffect(() => {
    const down = (e: KeyboardEvent): void => keyRef.current.onKeyDown(e);
    const up = (e: KeyboardEvent): void => keyRef.current.onKeyUp(e);
    const blur = (): void => editor.setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    ref.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [editor]);

  // ------------------------------------------------- clipboard and dropping
  useEffect(() => {
    const boardFocused = (): boolean => {
      const a = document.activeElement;
      if (!ref.current?.isConnected) return false;
      if (!a || a === document.body) return true;
      return ref.current.contains(a) && !isTypingTarget(a);
    };
    const onCopy = (e: ClipboardEvent): void => {
      if (!boardFocused() || editor.editingId) return;
      // Notes and raw record values are selectable text; preserve native copy.
      if (window.getSelection()?.toString()) return;
      const json = e.type === 'cut' ? editor.cutSelection() : editor.copySelection();
      if (!json) return;
      e.clipboardData?.setData('text/plain', json);
      e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent): void => {
      if (!boardFocused() || editor.editingId) return;
      const at = lastPointer.current
        ? editor.screenToPage(lastPointer.current.x, lastPointer.current.y)
        : editor.viewCenter();
      const files = imageFilesOf(e.clipboardData?.items);
      if (files.length) {
        e.preventDefault();
        onImages(files, at);
        return;
      }
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) {
        if (editor.pasteShapes(null, at)) e.preventDefault();
        return;
      }
      e.preventDefault();
      if (editor.pasteShapes(text, at)) return;
      if (onPasteText?.(text, at)) return;
      editor.insertText(text.slice(0, 5000), at);
    };
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCopy);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCopy);
      window.removeEventListener('paste', onPaste);
    };
  }, [editor, onImages, onPasteText]);

  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    const widget = e.dataTransfer?.getData(WIDGET_DRAG_TYPE);
    if (widget && onDropWidget) {
      e.preventDefault();
      const p = local(e.clientX, e.clientY);
      onDropWidget(widget, editor.screenToPage(p.x, p.y));
      return;
    }
    const files = imageFilesOf(e.dataTransfer?.files);
    if (!files.length) return;
    e.preventDefault();
    const p = local(e.clientX, e.clientY);
    onImages(files, editor.screenToPage(p.x, p.y));
  };

  // Camera motion updates two composited layers directly. React reconciles
  // content only when the document or buffered visible set changes.
  useLayoutEffect(() => {
    let zoom = -1;
    let grid = GRID_STEP;
    let lastCam: typeof editor.camera | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const paint = (): void => {
      const cam = editor.camera;
      if (cam === lastCam) return;
      const { x, y, z } = cam;
      const world = worldRef.current;
      if (world) {
        world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${z})`;
        // will-change only WHILE the camera moves: it keeps panning on the
        // compositor, but a permanent hint freezes text at its old raster
        // scale (blurry after zooming). Dropping it once the camera settles
        // re-rasterizes everything crisp at the new zoom.
        if (cam !== lastCam) {
          lastCam = cam;
          world.style.willChange = 'transform';
          if (settle) clearTimeout(settle);
          settle = setTimeout(() => {
            settle = null;
            world.style.willChange = 'auto';
          }, 180);
        }
      }
      const layer = gridRef.current;
      if (!layer) return;
      if (zoom !== z) {
        zoom = z;
        let step = GRID_STEP;
        while (step * z < 12) step *= 4;
        while (step * z > 48) step /= 4;
        grid = step * z;
        layer.style.backgroundSize = `${grid}px ${grid}px`;
        layer.style.backgroundPosition = `${96 - grid / 2}px ${96 - grid / 2}px`;
      }
      const phase = (v: number): number => ((v % grid) + grid) % grid;
      layer.style.transform = `translate3d(${phase(x)}px, ${phase(y)}px, 0)`;
    };
    paint();
    const unsub = editor.subscribe(paint);
    return () => {
      unsub();
      if (settle) clearTimeout(settle);
    };
  }, [editor]);

  // --------------------------------------------------------------- render
  return (
    <div
      ref={ref}
      tabIndex={0}
      data-testid="board-canvas"
      aria-label="Board canvas"
      className="relative h-full w-full select-none overflow-clip outline-none"
      style={{
        touchAction: 'none',
        cursor: panning ? 'grabbing' : CURSOR[tool],
        backgroundColor: 'hsl(0 0% 5.5%)',

      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e, false)}
      onPointerCancel={(e) => endPointer(e, true)}
      onLostPointerCapture={(e) => {
        if (editor.isGesturing && e.pointerType !== 'touch') editor.pointerUp(info(e));
      }}
      onPointerLeave={() => onPointerPage?.(null)}
      onDoubleClick={onDoubleClick}
      onMouseDown={(e) => {
        // A text box opened by this press must keep focus (the default
        // mousedown would refocus the canvas and blur-commit it empty).
        if ((editor.editingId || document.activeElement?.tagName === 'TEXTAREA') && !(e.target as HTMLElement).closest('textarea')) e.preventDefault();
      }}
      onDragOver={(e) => {
        const types = e.dataTransfer?.types ?? [];
        if (types.includes('Files') || types.includes(WIDGET_DRAG_TYPE)) e.preventDefault();
      }}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={gridRef} aria-hidden style={{ position: 'absolute', inset: -96, pointerEvents: 'none', willChange: 'transform', backgroundImage: 'radial-gradient(circle, hsl(0 0% 19%) 1px, transparent 1.3px)' }} />
      <div
        ref={worldRef}
        data-board-world
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
        }}
      >
        {visible.map((s) => (
          <ShapeView
            key={s.id}
            shape={s}
            erasing={pendingErase.has(s.id)}
            editing={editingId === s.id}
            interactive={s.type === 'widget' && tool === 'select'}
            renderWidget={renderWidget}
          />
        ))}
      </div>
      <SelectionOverlay editor={editor} width={size.w} height={size.h} handleSize={penMode ? 13 : 9} />
      <LiveCanvas editor={editor} width={size.w} height={size.h} remote={remote} />
      <TextEditor editor={editor} />
      {children}
    </div>
  );
}
