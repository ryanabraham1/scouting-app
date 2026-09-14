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
// refs and a rAF loop writes straight onto overlay nodes. The live stroke is
// drawn incrementally on a canvas so each frame only pays for NEW points;
// re-tessellating the whole growing stroke here makes the ink trail the pen on
// tablets. Committed state lives
// in the whiteboard reducer; saves debounce into the Dexie outbox
// (offline-first) and drain via strategyCanvasSync.
//
// Geometry: ASPECT-TRUE viewBox (0 0 3902 1584) — see strokePath.ts. Stored
// points stay NORMALIZED [0,1] (auto_path convention) so remote docs, eraser
// hit-tests and auto-routine underlays all share one coordinate system.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  FIELD_ASPECT,
  ROBOT_COLORS,
  INITIAL_WHITEBOARD,
  whiteboardReducer,
  newStrokeId,
  nextCanvasGeneration,
  erasedIdsAt,
  docOf,
  canvasDocsEqual,
  type CanvasDoc,
  type Stroke,
  type WhiteboardAction,
  type WhiteboardPhase,
  type RobotPos,
} from '@/dash/strategy/strokes';
import { strokeToPathD } from '@/dash/strategy/strokePath';
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

/** Drop live samples closer than this (fraction of field height) to the last
 *  kept point — sensor jitter while the pen rests otherwise reads as fuzz. */
const MIN_POINT_GAP = 0.0015;

/** A tapped Clear stays armed this long waiting for the confirming second tap. */
const CLEAR_CONFIRM_MS = 2500;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Every sample the browser coalesced into one move event (pen/touch usually
 *  report 2–4× the frame rate); falls back to the event itself. */
function samplesOf(e: React.PointerEvent): PointerEvent[] {
  const native = e.nativeEvent;
  const coalesced =
    typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
  return coalesced.length > 0 ? coalesced : [native];
}

function pressureOf(e: { pointerType: string; pressure: number }): number {
  return e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
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
  // Clear is a two-tap action on a tablet (the button sits next to Undo/Redo
  // and a stray fat-finger would wipe the whole board): first tap arms it.
  const [clearArmed, setClearArmed] = useState(false);
  // Field image failed to load (offline before it was ever cached): fall back
  // to an aspect-correct blank surface so the board stays fully drawable, and
  // retry automatically when the network returns.
  const [imgFailed, setImgFailed] = useState(false);
  const online = useOnline();

  useEffect(() => {
    if (online) setImgFailed(false); // remount the <img> and retry
  }, [online]);

  const containerRef = useRef<HTMLDivElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  // In-progress stroke, OUTSIDE React state (see perf contract above).
  const livePointsRef = useRef<[number, number, number][] | null>(null);
  // Number of points already painted into the live canvas. This is the key to
  // keeping pointer latency constant as a stroke grows: a frame never redraws
  // the prefix it has already rendered.
  const renderedLivePointsRef = useRef(0);
  const activePointerRef = useRef<number | null>(null);
  const activePointerTypeRef = useRef<string>('mouse');
  // Last eraser position (normalized) — the drag hit-tests the SEGMENT since
  // the previous sample so a fast swipe can't skip over thin strokes, and the
  // live canvas draws the eraser ring here.
  const eraserPosRef = useRef<[number, number] | null>(null);
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

  const flushSave = useCallback(() => {
    if (!userDirtyRef.current) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const snapshot = docOf(stateRef.current);
    void saveStrategyCanvas(eventKey, matchKey, phase, snapshot).then(() => {
      if (canvasDocsEqual(snapshot, docOf(stateRef.current))) {
        userDirtyRef.current = false;
        setSaveState('saved');
      }
    });
  }, [eventKey, matchKey, phase]);

  useEffect(() => {
    if (!userDirtyRef.current) return;
    setSaveState('pending');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      flushSave();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [state, flushSave]);

  // A board can be replaced immediately when match/phase changes. Flush its
  // last dirty snapshot during that transition and on unmount.
  useEffect(
    () => () => {
      flushSave();
    },
    [flushSave],
  );

  // Flush the pending save when the tab is hidden/backgrounded mid-debounce.
  useEffect(() => {
    function flush(): void {
      if (document.visibilityState === 'hidden') {
        flushSave();
      }
    }
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [flushSave]);

  useEffect(() => {
    if (!clearArmed) return;
    const t = setTimeout(() => setClearArmed(false), CLEAR_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [clearArmed]);

  const toNormalized = useCallback((clientX: number, clientY: number): [number, number] => {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    return [clamp01(x), clamp01(y)];
  }, []);

  const renderLiveStroke = useCallback(() => {
    const canvas = liveCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // Cap backing-store density: 2x is already retina-sharp and avoids making
    // an iPad paint a needlessly huge full-field overlay.
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    let needsFullRedraw = false;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      needsFullRedraw = true;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    // Eraser mode: the overlay is just a cursor ring at the last touch.
    if (toolRef.current.tool === 'erase') {
      ctx.clearRect(0, 0, rect.width, rect.height);
      renderedLivePointsRef.current = 0;
      const pos = eraserPosRef.current;
      if (pos) {
        ctx.beginPath();
        ctx.arc(pos[0] * rect.width, pos[1] * rect.height, ERASE_RADIUS * rect.height, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.stroke();
      }
      return;
    }

    const points = livePointsRef.current;
    if (!points || points.length === 0) {
      ctx.clearRect(0, 0, rect.width, rect.height);
      renderedLivePointsRef.current = 0;
      return;
    }

    if (needsFullRedraw) renderedLivePointsRef.current = 0;
    let start = renderedLivePointsRef.current;
    if (start >= points.length) return;

    const W = rect.width;
    const H = rect.height;
    const baseWidth = Math.max(1, toolRef.current.size * H);
    ctx.strokeStyle = toolRef.current.color;
    ctx.fillStyle = toolRef.current.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (start === 0) {
      ctx.clearRect(0, 0, W, H);
      const [x, y, pressure] = points[0];
      const pointWidth = baseWidth * (0.65 + 0.7 * pressure);
      ctx.beginPath();
      ctx.arc(x * W, y * H, pointWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      start = 1;
    }

    // Paint only the new tail, as quadratic curves through segment midpoints
    // (the classic "smooth pen" trick): each new point extends the ink from
    // mid(p[i-2],p[i-1]) to mid(p[i-1],p[i]) with p[i-1] as the control, so
    // corners between raw samples never show as kinks. Segment-level widths
    // preserve Pencil pressure; mouse/touch points all use the 0.5 fallback.
    for (let i = start; i < points.length; i += 1) {
      const prev = points[i - 1];
      const cur = points[i];
      const mx = ((prev[0] + cur[0]) / 2) * W;
      const my = ((prev[1] + cur[1]) / 2) * H;
      ctx.lineWidth = baseWidth * (0.65 + 0.35 * (prev[2] + cur[2]));
      ctx.beginPath();
      if (i === 1) {
        ctx.moveTo(prev[0] * W, prev[1] * H);
        ctx.lineTo(mx, my);
      } else {
        const before = points[i - 2];
        ctx.moveTo(((before[0] + prev[0]) / 2) * W, ((before[1] + prev[1]) / 2) * H);
        ctx.quadraticCurveTo(prev[0] * W, prev[1] * H, mx, my);
      }
      ctx.stroke();
    }
    renderedLivePointsRef.current = points.length;
  }, []);

  const renderLive = useCallback(() => {
    rafRef.current = null;
    renderLiveStroke();
    const drag = robotDragRef.current;
    if (drag) {
      const g = robotNodeRef.current.get(drag.key);
      if (g) {
        g.setAttribute('transform', `translate(${drag.x * FIELD_W}, ${drag.y * FIELD_H})`);
      }
    }
  }, [renderLiveStroke]);

  const scheduleLive = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(renderLive);
  }, [renderLive]);

  const eraseAt = useCallback(
    (x: number, y: number) => {
      // Sweep from the previous eraser position so a quick flick across a
      // hairline stroke still catches it (samples alone can straddle it).
      const from = eraserPosRef.current;
      const samples: [number, number][] = [[x, y]];
      if (from) {
        const dx = (x - from[0]) * FIELD_ASPECT;
        const dy = y - from[1];
        const steps = Math.min(24, Math.ceil(Math.hypot(dx, dy) / ERASE_RADIUS));
        for (let i = 1; i < steps; i += 1) {
          const t = i / steps;
          samples.push([from[0] + (x - from[0]) * t, from[1] + (y - from[1]) * t]);
        }
      }
      eraserPosRef.current = [x, y];
      let added = false;
      for (const [sx, sy] of samples) {
        for (const id of erasedIdsAt(stateRef.current.strokes, sx, sy, ERASE_RADIUS)) {
          if (!eraseDragRef.current.has(id)) {
            eraseDragRef.current.add(id);
            added = true;
          }
        }
      }
      if (added) setPendingErase(new Set(eraseDragRef.current));
      scheduleLive(); // eraser ring
    },
    [scheduleLive],
  );

  const endStroke = useCallback(() => {
    const { tool: t } = toolRef.current;
    if (t === 'pen') {
      const pts = livePointsRef.current;
      livePointsRef.current = null;
      if (pts && pts.length > 0) {
        const stroke: Stroke = {
          id: newStrokeId(),
          seq: nextCanvasGeneration(),
          color: toolRef.current.color,
          size: toolRef.current.size,
          points: pts,
        };
        // The live canvas is cleared by the layout effect AFTER the committed
        // SVG path is in the DOM (see below) so the ink never blinks out for
        // a frame between the two layers.
        commit({ type: 'add', stroke });
      } else {
        scheduleLive(); // nothing committed — just clear the live path
      }
    } else {
      const ids = [...eraseDragRef.current];
      eraseDragRef.current = new Set();
      eraserPosRef.current = null;
      setPendingErase(new Set());
      scheduleLive(); // clears the eraser ring
      if (ids.length > 0) commit({ type: 'erase', ids });
    }
    activePointerRef.current = null;
    onDrawingActiveChange?.(false);
  }, [commit, scheduleLive, onDrawingActiveChange]);

  // Live → committed handoff: once React has painted the new SVG stroke, drop
  // the canvas copy in the same frame (no gap, no double-draw flash).
  useLayoutEffect(() => {
    if (livePointsRef.current == null && renderedLivePointsRef.current > 0) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      renderLive();
    }
  }, [state.strokes, renderLive]);

  const beginStroke = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      activePointerRef.current = e.pointerId;
      activePointerTypeRef.current = e.pointerType;
      e.currentTarget.setPointerCapture(e.pointerId);
      onDrawingActiveChange?.(true);
      const [x, y] = toNormalized(e.clientX, e.clientY);
      if (toolRef.current.tool === 'pen') {
        // A pointer-up clear and the next pointer-down can land before the same
        // animation frame. Explicitly start a fresh incremental cursor so a
        // rapid second stroke never inherits the first stroke's point count.
        renderedLivePointsRef.current = 0;
        livePointsRef.current = [[x, y, pressureOf(e)]];
        scheduleLive();
      } else {
        eraserPosRef.current = null;
        eraseAt(x, y);
      }
    },
    [toNormalized, scheduleLive, eraseAt, onDrawingActiveChange],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (robotDragRef.current != null) return; // a robot drag claims the surface
      if (activePointerRef.current != null) {
        // Single-pointer policy: a second touch (palm, other hand) is ignored
        // so it can't fork the stroke — EXCEPT a pen arriving while a finger/
        // palm holds the surface: the Pencil is what the user meant, so the
        // touch stroke is discarded and the pen takes over (palm rejection).
        if (e.pointerType !== 'pen' || activePointerTypeRef.current === 'pen') return;
        livePointsRef.current = null;
        eraseDragRef.current = new Set();
        eraserPosRef.current = null;
        setPendingErase(new Set());
        activePointerRef.current = null;
      }
      beginStroke(e);
    },
    [beginStroke],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerRef.current !== e.pointerId) return;
      if (toolRef.current.tool === 'pen') {
        const pts = livePointsRef.current;
        if (!pts) return;
        // Coalesced samples give the curve 2–4× the points of the frame rate;
        // the min-gap filter throws away the sub-pixel jitter among them.
        let last = pts[pts.length - 1];
        let pushed = false;
        for (const sample of samplesOf(e)) {
          const [x, y] = toNormalized(sample.clientX, sample.clientY);
          const dx = (x - last[0]) * FIELD_ASPECT;
          const dy = y - last[1];
          if (dx * dx + dy * dy < MIN_POINT_GAP * MIN_POINT_GAP) continue;
          last = [x, y, pressureOf(sample)];
          pts.push(last);
          pushed = true;
        }
        if (pushed) scheduleLive();
      } else {
        const [x, y] = toNormalized(e.clientX, e.clientY);
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
        movedAt: nextCanvasGeneration(),
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

  // Keyboard shortcuts for laptop use: P/E tools, [ ] size, Cmd/Ctrl+Z undo,
  // Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y redo. Ignored while typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        commit({ type: e.shiftKey ? 'redo' : 'undo' });
      } else if (mod && k === 'y') {
        e.preventDefault();
        commit({ type: 'redo' });
      } else if (!mod && !e.altKey) {
        if (k === 'p') setTool('pen');
        else if (k === 'e') setTool('erase');
        else if (k === '[' || k === ']') {
          const idx = SIZES.findIndex((sz) => sz.value === toolRef.current.size);
          const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, idx + (k === ']' ? 1 : -1)))];
          setSize(next.value);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commit]);

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

  // 44px targets on tablet+; 38px on phones so the toolbar wraps into two tidy
  // rows (tools/sizes/actions + a full-width color row) instead of a ragged
  // three-line stack.
  const toolBtn = (active: boolean): string =>
    cn(
      'inline-flex min-h-[38px] min-w-[38px] items-center justify-center rounded-md border px-2 text-sm font-medium transition-colors sm:min-h-[44px] sm:min-w-[44px] sm:px-2.5',
      active
        ? 'border-brand bg-brand/20 text-brand'
        : 'border-border bg-card/60 text-foreground hover:bg-accent',
    );

  return (
    <div data-testid="field-whiteboard" data-phase={phase} className="flex flex-col gap-2">
      {/* Toolbar — 44px targets for gloved/pencil taps (38px compact on phones). */}
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Drawing tool">
          <button
            type="button"
            data-testid="wb-tool-pen"
            aria-pressed={tool === 'pen'}
            title="Pen (P)"
            aria-label="Pen"
            className={toolBtn(tool === 'pen')}
            onClick={() => setTool('pen')}
          >
            <Pen className="size-4" />
          </button>
          <button
            type="button"
            data-testid="wb-tool-erase"
            aria-pressed={tool === 'erase'}
            title="Eraser (E)"
            aria-label="Eraser"
            className={toolBtn(tool === 'erase')}
            onClick={() => setTool('erase')}
          >
            <Eraser className="size-4" />
          </button>
        </div>

        {/* Colors take their own full-width row on phones (order-last) so the
            seven swatches spread evenly instead of breaking mid-group. */}
        <div
          className="order-last flex w-full items-center gap-1 sm:order-none sm:w-auto"
          role="group"
          aria-label="Pen color"
        >
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
                'inline-flex min-h-[38px] min-w-[32px] flex-1 items-center justify-center rounded-md border transition-colors sm:min-h-[44px] sm:min-w-[36px] sm:flex-none',
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
              title={`${s.label} ([ / ] to change)`}
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
            title="Undo (Cmd/Ctrl+Z)"
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
            title="Redo (Cmd/Ctrl+Shift+Z)"
            disabled={state.redoStack.length === 0}
            className={cn(toolBtn(false), 'disabled:opacity-40')}
            onClick={() => commit({ type: 'redo' })}
          >
            <Redo2 className="size-4" />
          </button>
          <button
            type="button"
            data-testid="wb-clear"
            aria-label={clearArmed ? 'Confirm clear drawing' : 'Clear drawing'}
            title={clearArmed ? 'Tap again to clear' : 'Clear drawing (tap twice)'}
            disabled={state.strokes.length === 0}
            className={cn(
              toolBtn(false),
              'gap-1.5 disabled:opacity-40',
              clearArmed && 'border-destructive bg-destructive/20 text-destructive hover:bg-destructive/30',
            )}
            onClick={() => {
              if (clearArmed) {
                setClearArmed(false);
                commit({ type: 'clear' });
              } else {
                setClearArmed(true);
              }
            }}
          >
            <Trash2 className="size-4" />
            {clearArmed ? <span className="text-xs">Clear?</span> : null}
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
        onLostPointerCapture={onPointerEnd}
        // iPadOS long-press callout / desktop right-click would interrupt a
        // stroke that pauses mid-air.
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'relative w-full overflow-hidden rounded-lg ring-1 ring-border',
          tool === 'erase' ? 'cursor-cell' : 'cursor-crosshair',
        )}
        style={{ touchAction: 'none', userSelect: 'none' }}
      >
        {imgFailed ? (
          <div
            data-testid="wb-field-fallback"
            className="flex w-full items-center justify-center bg-zinc-800"
            style={{ aspectRatio: `${FIELD_W} / ${FIELD_H}` }}
          >
            <span className="rounded-md bg-black/40 px-3 py-1.5 text-xs text-muted-foreground">
              Field image unavailable offline — drawing still works
            </span>
          </div>
        ) : (
          <img
            src="/assets/field/field.png"
            alt="field"
            draggable={false}
            onError={() => setImgFailed(true)}
            style={{ display: 'block', width: '100%', height: 'auto' }}
          />
        )}
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
          {/* Auto-routine underlays — beneath the ink so drawn plays sit on top.
              Each routine is LABELED with the team running it (at its start
              square, or the path start when no start was scouted). */}
          {underlays?.map((o, i) => {
            const anchor = o.startPosition ?? (o.path && o.path.length > 0 ? o.path[0] : null);
            return (
              <g key={i} opacity={0.6} data-testid={`wb-underlay-${o.label ?? i}`}>
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
                  // Display-only start square (matches FieldDiagram's marker
                  // size; the DRAGGABLE squares stay bigger for grabbability).
                  <rect
                    x={o.startPosition.x * FIELD_W - (FIELD_H * 0.062) / 2}
                    y={o.startPosition.y * FIELD_H - (FIELD_H * 0.062) / 2}
                    width={FIELD_H * 0.062}
                    height={FIELD_H * 0.062}
                    rx={FIELD_H * 0.006}
                    fill={o.color}
                    stroke="#ffffff"
                    strokeWidth={FIELD_H * 0.004}
                  />
                )}
                {o.label && anchor && (
                  <text
                    x={anchor.x * FIELD_W}
                    y={
                      o.startPosition
                        ? anchor.y * FIELD_H
                        : anchor.y * FIELD_H - FIELD_H * 0.02
                    }
                    textAnchor="middle"
                    dominantBaseline={o.startPosition ? 'central' : 'auto'}
                    fontSize={FIELD_H * 0.062 * 0.42}
                    fontWeight={800}
                    fill="#0b0f1a"
                    stroke="#ffffff"
                    strokeWidth={FIELD_H * 0.002}
                    paintOrder="stroke"
                    style={{ userSelect: 'none' }}
                  >
                    {o.label}
                  </text>
                )}
              </g>
            );
          })}
          {/* Committed ink. */}
          {committedPaths.map((p) =>
            pendingErase.has(p.id) ? null : (
              <path key={p.id} d={p.d} fill={p.color} data-testid={`wb-stroke-${p.id}`} />
            ),
          )}
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
        {/* The live stroke is incremental canvas ink. It sits above the SVG
            while the pointer is down, then clears as the committed SVG stroke
            takes over. Keeping it outside React avoids render/poll jitter. */}
        <canvas
          ref={liveCanvasRef}
          data-testid="wb-live-stroke"
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        />
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
