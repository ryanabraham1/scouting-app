// src/dash/strategy/FieldWhiteboard.tsx
// The Strategy tab's drawing surface: freehand strokes over the field image,
// built for an iPad in a pre-match strategy meeting (Apple Pencil / finger).
//
// One board per game PHASE (auto / transition / active / inactive / endgame —
// the parent passes `phase` and keys this component so each phase keeps its own
// ink). The AUTO board additionally renders draggable robot-sized start squares
// for OUR alliance (one color per team, echoing FieldDiagram's pick-start
// square style), with a color key underneath. Robot drags merge per key with
// the newer move winning (0043 RPC), so they never conflict across devices.
//
// Perf contract (this view re-renders every Nexus poll tick): the IN-PROGRESS
// stroke and an in-flight robot drag never touch React state — they live in
// refs and a rAF loop writes straight onto the SVG nodes. Committed state lives
// in the whiteboard reducer; saves debounce into the Dexie outbox
// (offline-first) and drain via strategyCanvasSync.
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
  ROBOT_COLORS,
  INITIAL_WHITEBOARD,
  whiteboardReducer,
  newStrokeId,
  erasedIdsAt,
  docOf,
  canvasDocsEqual,
  type CanvasDoc,
  type Stroke,
  type WhiteboardAction,
  type WhiteboardPhase,
  type RobotPos,
} from '@/dash/strategy/strokes';
import { strokeToPathD, livePathD } from '@/dash/strategy/strokePath';
import { saveStrategyCanvas } from '@/dash/strategy/strategyCanvasClient';

/** One robot square seed: OUR alliance team + its stable color + default spot. */
export interface RobotSeed {
  key: string;
  team: number;
  color: string;
  defaultX: number;
  defaultY: number;
}

export interface FieldWhiteboardProps {
  eventKey: string;
  matchKey: string;
  phase: WhiteboardPhase;
  /** Server+local merged doc from useStrategyCanvas (undefined while loading). */
  remoteDoc: CanvasDoc | undefined;
  /** Read-only auto-routine polylines rendered UNDER the ink. */
  underlays?: RoutineOverlay[];
  /** Draggable robot start squares (auto board only) + their color key. */
  robotSeeds?: RobotSeed[];
  /** Fires when a stroke starts/ends — the parent defers match auto-switching
   *  while ink is mid-air so the board never swaps out under a moving pen. */
  onDrawingActiveChange?: (active: boolean) => void;
}

// First three = the robot colors assigned to OUR alliance's start squares
// (ROBOT_COLORS), so a play can be drawn in the acting robot's color; the rest
// are generic annotation colors.
const COLORS = [
  { value: ROBOT_COLORS[0], label: 'Robot 1' },
  { value: ROBOT_COLORS[1], label: 'Robot 2' },
  { value: ROBOT_COLORS[2], label: 'Robot 3' },
  { value: '#ef4444', label: 'Red' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#22c55e', label: 'Green' },
  { value: '#ffffff', label: 'White' },
];

/** Pen sizes as a fraction of field HEIGHT (render-size independent). */
const SIZES = [
  { value: 0.011, label: 'Fine' },
  { value: 0.02, label: 'Medium' },
  { value: 0.036, label: 'Bold' },
];

/** Eraser touch radius (fraction of field height). */
const ERASE_RADIUS = 0.035;

/** Robot square side in viewBox px — roughly a bumpered-robot footprint. */
const ROBOT_PX = 0.095 * FIELD_H;

const SAVE_DEBOUNCE_MS = 900;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export default function FieldWhiteboard({
  eventKey,
  matchKey,
  phase,
  remoteDoc,
  underlays,
  robotSeeds,
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
  // In-flight robot drag (auto board): live position in a ref + direct DOM
  // transform via the node map; committed to the reducer on drop.
  const robotDragRef = useRef<{
    key: string;
    pointerId: number;
    grabDx: number;
    grabDy: number;
    x: number;
    y: number;
  } | null>(null);
  const robotNodeRef = useRef<Map<string, SVGGElement>>(new Map());
  // True once a USER op (not hydration) touched the doc — gates the save effect.
  const userDirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest tool config for pointer handlers without re-binding them.
  const toolRef = useRef({ tool, color, size });
  toolRef.current = { tool, color, size };
  const stateRef = useRef(state);
  stateRef.current = state;

  // Hydrate remote/merged docs into local state. mergeCanvasDocs is monotonic
  // (id-union + tombstones + newer-robot-wins), so this can never clobber
  // unsaved local ink.
  useEffect(() => {
    if (remoteDoc) {
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
      void saveStrategyCanvas(eventKey, matchKey, phase, docOf(state)).then(() =>
        setSaveState('saved'),
      );
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [state, eventKey, matchKey, phase]);

  // Flush the pending save when the tab is hidden/backgrounded mid-debounce.
  useEffect(() => {
    function flush(): void {
      if (document.visibilityState === 'hidden' && userDirtyRef.current && saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        void saveStrategyCanvas(eventKey, matchKey, phase, docOf(stateRef.current));
      }
    }
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [eventKey, matchKey, phase]);

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
    if (node) {
      node.setAttribute('d', pts && pts.length > 0 ? livePathD(pts, toolRef.current.size) : '');
    }
    const drag = robotDragRef.current;
    if (drag) {
      const g = robotNodeRef.current.get(drag.key);
      if (g) {
        g.setAttribute('transform', `translate(${drag.x * FIELD_W}, ${drag.y * FIELD_H})`);
      }
    }
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
      // it can't fork the stroke. A robot drag also claims the surface.
      if (activePointerRef.current != null || robotDragRef.current != null) return;
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

  // ------------------------------------------------------------------
  // Robot square dragging (auto board). stopPropagation keeps the surface
  // from starting a stroke; capture goes to the robot's own <g>.
  // ------------------------------------------------------------------

  const robotPosition = useCallback(
    (seed: RobotSeed): { x: number; y: number } => {
      const placed = stateRef.current.robots.find((r) => r.key === seed.key);
      return placed ? { x: placed.x, y: placed.y } : { x: seed.defaultX, y: seed.defaultY };
    },
    [],
  );

  const onRobotPointerDown = useCallback(
    (seed: RobotSeed) => (e: React.PointerEvent<SVGGElement>) => {
      if (robotDragRef.current != null || activePointerRef.current != null) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      onDrawingActiveChange?.(true);
      const [px, py] = toNormalized(e.clientX, e.clientY);
      const pos = robotPosition(seed);
      robotDragRef.current = {
        key: seed.key,
        pointerId: e.pointerId,
        grabDx: pos.x - px,
        grabDy: pos.y - py,
        x: pos.x,
        y: pos.y,
      };
    },
    [toNormalized, robotPosition, onDrawingActiveChange],
  );

  const onRobotPointerMove = useCallback(
    (e: React.PointerEvent<SVGGElement>) => {
      const drag = robotDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      e.stopPropagation();
      const [px, py] = toNormalized(e.clientX, e.clientY);
      drag.x = clamp01(px + drag.grabDx);
      drag.y = clamp01(py + drag.grabDy);
      scheduleLive();
    },
    [toNormalized, scheduleLive],
  );

  const onRobotPointerEnd = useCallback(
    (seed: RobotSeed) => (e: React.PointerEvent<SVGGElement>) => {
      const drag = robotDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      e.stopPropagation();
      robotDragRef.current = null;
      onDrawingActiveChange?.(false);
      const robot: RobotPos = {
        key: seed.key,
        team: seed.team,
        x: drag.x,
        y: drag.y,
        movedAt: Date.now(),
      };
      commit({ type: 'moveRobot', robot });
    },
    [commit, onDrawingActiveChange],
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
    <div data-testid="field-whiteboard" data-phase={phase} className="flex flex-col gap-2">
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
          {COLORS.map((c, i) => (
            <button
              key={c.value}
              type="button"
              data-testid={`wb-color-${c.label.toLowerCase().replace(/\s+/g, '-')}`}
              aria-label={
                i < 3 && robotSeeds?.[i] ? `Team ${robotSeeds[i].team} color` : c.label
              }
              title={i < 3 && robotSeeds?.[i] ? `Team ${robotSeeds[i].team}` : c.label}
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
                // Robot-footprint square (matches FieldDiagram's start markers
                // and the draggable squares' visual language).
                <rect
                  x={o.startPosition.x * FIELD_W - (FIELD_H * 0.095) / 2}
                  y={o.startPosition.y * FIELD_H - (FIELD_H * 0.095) / 2}
                  width={FIELD_H * 0.095}
                  height={FIELD_H * 0.095}
                  rx={FIELD_H * 0.008}
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
          {/* Robot start squares (AUTO board only) — the same square-with-white-
              border language as FieldDiagram's pick-start marker, one color per
              team. The color KEY below stays on every board. */}
          {phase === 'auto' && robotSeeds?.map((seed) => {
            const pos = robotPosition(seed);
            return (
              <g
                key={seed.key}
                ref={(node) => {
                  if (node) robotNodeRef.current.set(seed.key, node);
                  else robotNodeRef.current.delete(seed.key);
                }}
                data-testid={`wb-robot-${seed.team}`}
                transform={`translate(${pos.x * FIELD_W}, ${pos.y * FIELD_H})`}
                style={{ pointerEvents: 'all', cursor: 'grab', touchAction: 'none' }}
                onPointerDown={onRobotPointerDown(seed)}
                onPointerMove={onRobotPointerMove}
                onPointerUp={onRobotPointerEnd(seed)}
                onPointerCancel={onRobotPointerEnd(seed)}
              >
                <rect
                  x={-ROBOT_PX / 2}
                  y={-ROBOT_PX / 2}
                  width={ROBOT_PX}
                  height={ROBOT_PX}
                  rx={FIELD_H * 0.008}
                  fill={seed.color}
                  fillOpacity={0.85}
                  stroke="#ffffff"
                  strokeWidth={FIELD_H * 0.006}
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={ROBOT_PX * 0.34}
                  fontWeight={700}
                  fill="#0b0f1a"
                  style={{ userSelect: 'none' }}
                >
                  {seed.team}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Color key: which color is which of OUR alliance robots — visible on
          EVERY phase board (colors also lead the pen palette). */}
      {robotSeeds && robotSeeds.length > 0 ? (
        <div
          data-testid="wb-robot-key"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        >
          <span className="font-semibold uppercase tracking-wide">
            {phase === 'auto' ? 'Start squares' : 'Robot colors'}
          </span>
          {robotSeeds.map((seed) => (
            <span key={seed.key} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-3.5 rounded-[3px] ring-1 ring-white/60"
                style={{ background: seed.color }}
              />
              <span className="tabular-nums font-medium text-foreground">{seed.team}</span>
            </span>
          ))}
          {phase === 'auto' ? (
            <span className="text-muted-foreground/70">drag a square to place its start</span>
          ) : null}
        </div>
      ) : null}

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
