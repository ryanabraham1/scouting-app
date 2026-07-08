// src/dash/strategy/FieldWhiteboard.tsx
// The Strategy tab's drawing surface: freehand strokes over the field image,
// built for an iPad in a pre-match strategy meeting (Apple Pencil / finger).
//
// Perf contract (this view re-renders every Nexus poll tick): the IN-PROGRESS
// stroke never touches React state — pointer points accumulate in a ref and a
// rAF loop writes the tessellated path `d` straight onto a dedicated <path>
// node (FieldDiagram's drawingRef pattern, upgraded with a live preview).
// Committed strokes live in the whiteboard reducer; saves debounce into the
// Dexie outbox (offline-first) and drain via strategyCanvasSync.
//
// Geometry: ASPECT-TRUE viewBox (0 0 3902 1584) — see strokePath.ts. Stored
// points stay NORMALIZED [0,1] (auto_path convention) so remote docs, eraser
// hit-tests and auto-routine underlays all share one coordinate system.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Eraser, Pen, Redo2, Trash2, Undo2, Cloud, CloudOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOnline } from '@/sync/useOnline';
import type { RoutineOverlay } from '@/components/FieldDiagram';
import {
  FIELD_W,
  FIELD_H,
  INITIAL_WHITEBOARD,
  whiteboardReducer,
  newStrokeId,
  erasedIdsAt,
  docOf,
  canvasDocsEqual,
  type CanvasDoc,
  type Stroke,
  type WhiteboardAction,
} from '@/dash/strategy/strokes';
import { strokeToPathD, livePathD } from '@/dash/strategy/strokePath';
import { saveStrategyCanvas } from '@/dash/strategy/strategyCanvasClient';

export interface FieldWhiteboardProps {
  eventKey: string;
  matchKey: string;
  /** Server+local merged doc from useStrategyCanvas (undefined while loading). */
  remoteDoc: CanvasDoc | undefined;
  /** Read-only auto-routine polylines rendered UNDER the ink. */
  underlays?: RoutineOverlay[];
  /** Fires when a stroke starts/ends — the parent defers match auto-switching
   *  while ink is mid-air so the board never swaps out under a moving pen. */
  onDrawingActiveChange?: (active: boolean) => void;
}

const COLORS = [
  { value: '#facc15', label: 'Yellow' },
  { value: '#ef4444', label: 'Red' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#22c55e', label: 'Green' },
  { value: '#ffffff', label: 'White' },
  { value: '#0b0f1a', label: 'Black' },
];

/** Pen sizes as a fraction of field HEIGHT (render-size independent). */
const SIZES = [
  { value: 0.011, label: 'Fine' },
  { value: 0.02, label: 'Medium' },
  { value: 0.036, label: 'Bold' },
];

/** Eraser touch radius (fraction of field height). */
const ERASE_RADIUS = 0.035;

const SAVE_DEBOUNCE_MS = 900;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export default function FieldWhiteboard({
  eventKey,
  matchKey,
  remoteDoc,
  underlays,
  onDrawingActiveChange,
}: FieldWhiteboardProps): JSX.Element {
  const [state, dispatch] = useReducer(whiteboardReducer, INITIAL_WHITEBOARD);
  const [tool, setTool] = useState<'pen' | 'erase'>('pen');
  const [color, setColor] = useState(COLORS[0].value);
  const [size, setSize] = useState(SIZES[1].value);
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saved'>('idle');
  const online = useOnline();

  const containerRef = useRef<HTMLDivElement>(null);
  const livePathRef = useRef<SVGPathElement>(null);
  // In-progress stroke, OUTSIDE React state (see perf contract above).
  const livePointsRef = useRef<[number, number, number][] | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  // Ids collected by the current eraser drag (committed as ONE undoable op).
  const eraseDragRef = useRef<Set<string>>(new Set());
  // Visual-only: strokes hidden mid-eraser-drag before the op commits.
  const [pendingErase, setPendingErase] = useState<ReadonlySet<string>>(new Set());
  // True once a USER op (not hydration) touched the doc — gates the save effect.
  const userDirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest tool config for pointer handlers without re-binding them.
  const toolRef = useRef({ tool, color, size });
  toolRef.current = { tool, color, size };
  const stateRef = useRef(state);
  stateRef.current = state;

  // Hydrate remote/merged docs into local state. mergeCanvasDocs is monotonic
  // (id-union + tombstones), so this can never clobber unsaved local ink.
  useEffect(() => {
    if (remoteDoc && remoteDoc !== undefined) {
      if (!canvasDocsEqual(docOf(stateRef.current), remoteDoc)) {
        dispatch({ type: 'hydrate', doc: remoteDoc });
      }
    }
  }, [remoteDoc]);

  // A user op happened → debounce a save of the CURRENT doc into the outbox.
  const commit = useCallback((action: WhiteboardAction) => {
    userDirtyRef.current = true;
    dispatch(action);
  }, []);

  useEffect(() => {
    if (!userDirtyRef.current) return;
    setSaveState('pending');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveStrategyCanvas(eventKey, matchKey, docOf(state)).then(() =>
        setSaveState('saved'),
      );
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [state, eventKey, matchKey]);

  // Flush the pending save when the tab is hidden/backgrounded mid-debounce.
  useEffect(() => {
    function flush(): void {
      if (document.visibilityState === 'hidden' && userDirtyRef.current && saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        void saveStrategyCanvas(eventKey, matchKey, docOf(stateRef.current));
      }
    }
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [eventKey, matchKey]);

  const toNormalized = useCallback((clientX: number, clientY: number): [number, number] => {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    return [clamp01(x), clamp01(y)];
  }, []);

  const renderLive = useCallback(() => {
    rafRef.current = null;
    const pts = livePointsRef.current;
    const node = livePathRef.current;
    if (!node) return;
    node.setAttribute('d', pts && pts.length > 0 ? livePathD(pts, toolRef.current.size) : '');
  }, []);

  const scheduleLive = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(renderLive);
  }, [renderLive]);

  const eraseAt = useCallback((x: number, y: number) => {
    const hits = erasedIdsAt(stateRef.current.strokes, x, y, ERASE_RADIUS);
    let added = false;
    for (const id of hits) {
      if (!eraseDragRef.current.has(id)) {
        eraseDragRef.current.add(id);
        added = true;
      }
    }
    if (added) setPendingErase(new Set(eraseDragRef.current));
  }, []);

  const endStroke = useCallback(() => {
    const { tool: t } = toolRef.current;
    if (t === 'pen') {
      const pts = livePointsRef.current;
      livePointsRef.current = null;
      scheduleLive(); // clears the live path
      if (pts && pts.length > 0) {
        const stroke: Stroke = {
          id: newStrokeId(),
          seq: Date.now(),
          color: toolRef.current.color,
          size: toolRef.current.size,
          points: pts,
        };
        commit({ type: 'add', stroke });
      }
    } else {
      const ids = [...eraseDragRef.current];
      eraseDragRef.current = new Set();
      setPendingErase(new Set());
      if (ids.length > 0) commit({ type: 'erase', ids });
    }
    activePointerRef.current = null;
    onDrawingActiveChange?.(false);
  }, [commit, scheduleLive, onDrawingActiveChange]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Single-pointer policy: a second touch (palm, other hand) is ignored so
      // it can't fork the stroke.
      if (activePointerRef.current != null) return;
      activePointerRef.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      onDrawingActiveChange?.(true);
      const [x, y] = toNormalized(e.clientX, e.clientY);
      if (toolRef.current.tool === 'pen') {
        const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
        livePointsRef.current = [[x, y, pressure]];
        scheduleLive();
      } else {
        eraseAt(x, y);
      }
    },
    [toNormalized, scheduleLive, eraseAt, onDrawingActiveChange],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerRef.current !== e.pointerId) return;
      const [x, y] = toNormalized(e.clientX, e.clientY);
      if (toolRef.current.tool === 'pen') {
        if (!livePointsRef.current) return;
        const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
        livePointsRef.current.push([x, y, pressure]);
        scheduleLive();
      } else {
        eraseAt(x, y);
      }
    },
    [toNormalized, scheduleLive, eraseAt],
  );

  const onPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerRef.current !== e.pointerId) return;
      endStroke();
    },
    [endStroke],
  );

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // Committed ink (memoized path tessellation — only recomputes on doc change).
  const committedPaths = useMemo(
    () =>
      state.strokes.map((s) => ({
        id: s.id,
        color: s.color,
        d: strokeToPathD(s),
      })),
    [state.strokes],
  );

  const toolBtn = (active: boolean): string =>
    cn(
      'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border px-2.5 text-sm font-medium transition-colors',
      active
        ? 'border-brand bg-brand/20 text-brand'
        : 'border-border bg-card/60 text-foreground hover:bg-accent',
    );

  return (
    <div data-testid="field-whiteboard" className="flex flex-col gap-2">
      {/* Toolbar — 44px targets for gloved/pencil taps. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Drawing tool">
          <button
            type="button"
            data-testid="wb-tool-pen"
            aria-pressed={tool === 'pen'}
            className={toolBtn(tool === 'pen')}
            onClick={() => setTool('pen')}
          >
            <Pen className="size-4" />
          </button>
          <button
            type="button"
            data-testid="wb-tool-erase"
            aria-pressed={tool === 'erase'}
            className={toolBtn(tool === 'erase')}
            onClick={() => setTool('erase')}
          >
            <Eraser className="size-4" />
          </button>
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Pen color">
          {COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              data-testid={`wb-color-${c.label.toLowerCase()}`}
              aria-label={c.label}
              aria-pressed={color === c.value}
              onClick={() => {
                setColor(c.value);
                setTool('pen');
              }}
              className={cn(
                'inline-flex min-h-[44px] min-w-[36px] items-center justify-center rounded-md border transition-colors',
                color === c.value && tool === 'pen'
                  ? 'border-brand bg-brand/15'
                  : 'border-border bg-card/60 hover:bg-accent',
              )}
            >
              <span
                aria-hidden
                className="size-5 rounded-full ring-1 ring-white/25"
                style={{ background: c.value }}
              />
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Pen size">
          {SIZES.map((s) => (
            <button
              key={s.label}
              type="button"
              data-testid={`wb-size-${s.label.toLowerCase()}`}
              aria-label={s.label}
              aria-pressed={size === s.value}
              onClick={() => setSize(s.value)}
              className={toolBtn(size === s.value)}
            >
              <span
                aria-hidden
                className="rounded-full bg-current"
                style={{ width: 6 + s.value * 400, height: 6 + s.value * 400 }}
              />
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="wb-undo"
            aria-label="Undo"
            disabled={state.undoStack.length === 0}
            className={cn(toolBtn(false), 'disabled:opacity-40')}
            onClick={() => commit({ type: 'undo' })}
          >
            <Undo2 className="size-4" />
          </button>
          <button
            type="button"
            data-testid="wb-redo"
            aria-label="Redo"
            disabled={state.redoStack.length === 0}
            className={cn(toolBtn(false), 'disabled:opacity-40')}
            onClick={() => commit({ type: 'redo' })}
          >
            <Redo2 className="size-4" />
          </button>
          <button
            type="button"
            data-testid="wb-clear"
            aria-label="Clear drawing"
            disabled={state.strokes.length === 0}
            className={cn(toolBtn(false), 'disabled:opacity-40')}
            onClick={() => commit({ type: 'clear' })}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>

      {/* Drawing surface. */}
      <div
        ref={containerRef}
        data-testid="wb-surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        className={cn(
          'relative w-full overflow-hidden rounded-lg ring-1 ring-border',
          tool === 'erase' ? 'cursor-cell' : 'cursor-crosshair',
        )}
        style={{ touchAction: 'none', userSelect: 'none' }}
      >
        <img
          src="/assets/field/field.png"
          alt="field"
          draggable={false}
          style={{ display: 'block', width: '100%', height: 'auto' }}
        />
        <svg
          data-testid="wb-svg"
          viewBox={`0 0 ${FIELD_W} ${FIELD_H}`}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        >
          {/* Auto-routine underlays — beneath the ink so drawn plays sit on top. */}
          {underlays?.map((o, i) => (
            <g key={i} opacity={0.55}>
              {o.path && o.path.length >= 2 && (
                <polyline
                  fill="none"
                  stroke={o.color}
                  strokeWidth={FIELD_H * 0.012}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={`${FIELD_H * 0.02} ${FIELD_H * 0.025}`}
                  points={o.path.map((p) => `${p.x * FIELD_W},${p.y * FIELD_H}`).join(' ')}
                />
              )}
              {o.startPosition && (
                <circle
                  cx={o.startPosition.x * FIELD_W}
                  cy={o.startPosition.y * FIELD_H}
                  r={FIELD_H * 0.026}
                  fill={o.color}
                  stroke="#ffffff"
                  strokeWidth={FIELD_H * 0.005}
                />
              )}
            </g>
          ))}
          {/* Committed ink. */}
          {committedPaths.map((p) =>
            pendingErase.has(p.id) ? null : (
              <path key={p.id} d={p.d} fill={p.color} data-testid={`wb-stroke-${p.id}`} />
            ),
          )}
          {/* Live (in-progress) stroke — mutated directly via rAF, never React. */}
          <path ref={livePathRef} fill={color} data-testid="wb-live-stroke" />
        </svg>
      </div>

      {/* Save status — local persistence is instant; cloud sync drains behind it. */}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span data-testid="wb-save-state" className="inline-flex items-center gap-1.5">
          {online ? <Cloud className="size-3.5" /> : <CloudOff className="size-3.5" />}
          {saveState === 'pending'
            ? 'Saving…'
            : saveState === 'saved'
              ? online
                ? 'Saved — synced to cloud'
                : 'Saved offline — will sync when online'
              : online
                ? 'Drawings save automatically'
                : 'Offline — drawings save on this device'}
        </span>
        <span className="tabular-nums">
          {state.strokes.length} stroke{state.strokes.length === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  );
}
