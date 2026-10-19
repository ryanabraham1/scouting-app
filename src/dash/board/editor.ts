// src/dash/board/editor.ts
// BoardEditor: the framework-free core of Ryan's Board. Holds the document
// (shapes), camera, selection, tool and style, runs every pointer gesture as a
// small state machine, and keeps an undo/redo history of record-level patches.
// React binds to it through useBoard() (useSyncExternalStore); persistence and
// cloud sync subscribe to onChange(). Plan: docs/plans/ryans-board/README.md §5.
//
// Perf contract: pointer-move work never allocates React state. In-progress
// ink, laser trails and the eraser ring live in `live` and are painted by the
// LiveCanvas in rAF (subscribeLive); document changes during a drag notify at
// most once per animation frame.

import {
  FONT_SIZE,
  INK_SIZE,
  HIGHLIGHTER_SCALE,
  TEXT_LINE_HEIGHT,
  inkGeometry,
  isTombstone,
  newShapeId,
  nextRev,
  paintOrder,
  rectFromPoints,
  rectsIntersect,
  recordWins,
  scaleShape,
  shapeRect,
  shapesInMarquee,
  topShapeAt,
  translateShape,
  unionRects,
  type BoardRecord,
  type ColorName,
  type ImageShape,
  type InkShape,
  type Point,
  type Rect,
  type Shape,
  type SizeName,
  type TextAlign,
  type TextShape,
  type Tombstone,
  type WidgetShape,
} from '@/dash/board/model';

export type Tool = 'select' | 'hand' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'laser';
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface BoardStyle {
  color: ColorName;
  highlighterColor: ColorName;
  size: SizeName;
  align: TextAlign;
}

export interface PointerSample {
  sx: number;
  sy: number;
  pressure: number;
}

export interface PointerInfo {
  sx: number;
  sy: number;
  pointerId: number;
  pointerType: string;
  pressure: number;
  button: number;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** Coalesced samples since the last event (falls back to the event itself). */
  samples?: PointerSample[];
}

export interface BoardChange {
  puts: Shape[];
  tombstones: Tombstone[];
  source: 'local' | 'remote';
}

interface Txn {
  before: Map<string, Shape | null>;
  after: Map<string, Shape | null>;
  selBefore: string[];
  selAfter: string[];
}

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; cam: Camera }
  | { kind: 'stroke' }
  | { kind: 'erase' }
  | { kind: 'laser' }
  | {
      kind: 'pending';
      downPage: Point;
      downSx: number;
      downSy: number;
      hitId: string | null;
      alt: boolean;
    }
  | {
      kind: 'translate';
      startPage: Point;
      originals: Map<string, Shape>;
      /** Shapes created by an Alt-drag duplicate (their "before" is null). */
      created: Set<string>;
    }
  | {
      kind: 'resize';
      handle: Handle;
      startBounds: Rect;
      originals: Map<string, Shape>;
    }
  | { kind: 'marquee'; startPage: Point; base: Set<string> };

export interface LaserPoint {
  x: number;
  y: number;
  t: number;
}

/** Ephemeral, high-frequency state painted by the LiveCanvas (never React state). */
export interface LiveState {
  /** In-progress stroke; `id` is the id the committed ink shape will get. */
  stroke: {
    id: string;
    points: [number, number, number][];
    color: ColorName;
    size: SizeName;
    highlighter: boolean;
  } | null;
  laser: LaserPoint[];
  eraser: Point | null;
  /** In-progress move (for live broadcast to collaborators). */
  drag: { ids: string[]; dx: number; dy: number } | null;
}

export interface BoardEditorOptions {
  clientId: string;
  /** Measured text height (page units) for a text shape at its width. */
  measureText?: (s: TextShape) => number;
  /** Minimum size for a widget kind (resize clamp). */
  widgetMinSize?: (kind: string) => { w: number; h: number };
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8];
const HISTORY_LIMIT = 200;
/** Screen px a select-drag must travel before it becomes a move. */
const DRAG_THRESHOLD = 3;
/** Screen px of hit slop around shapes. */
const HIT_SLOP = 6;
/** Eraser radius in screen px. */
const ERASER_RADIUS = 10;
export const LASER_FADE_MS = 1200;
const TEXT_DEFAULT_W = 280;

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function defaultMeasureText(s: TextShape): number {
  const fs = FONT_SIZE[s.size];
  const charsPerLine = Math.max(1, Math.floor(s.w / (fs * 0.55)));
  let lines = 0;
  for (const line of (s.text || ' ').split('\n')) {
    lines += Math.max(1, Math.ceil(line.length / charsPerLine));
  }
  return lines * fs * TEXT_LINE_HEIGHT;
}

export class BoardEditor {
  readonly clientId: string;
  shapes: ReadonlyMap<string, Shape> = new Map();
  order: readonly Shape[] = [];
  camera: Camera = { x: 0, y: 0, z: 1 };
  viewport = { w: 0, h: 0 };
  selection: ReadonlySet<string> = new Set();
  tool: Tool = 'select';
  style: BoardStyle = { color: 'white', highlighterColor: 'yellow', size: 'm', align: 'start' };
  editingId: string | null = null;
  marquee: Rect | null = null;
  pendingErase: ReadonlySet<string> = new Set();
  penMode = false;
  spaceHeld = false;
  /** Bumps on every notify; useBoard uses it to tear-proof selectors. */
  version = 0;
  readonly live: LiveState = { stroke: null, laser: [], eraser: null, drag: null };

  private gesture: Gesture | null = null;
  private gesturePointer: number | null = null;
  private undoStack: Txn[] = [];
  private redoStack: Txn[] = [];
  private listeners = new Set<() => void>();
  private liveListeners = new Set<() => void>();
  private changeListeners = new Set<(c: BoardChange) => void>();
  private notifyQueued = false;
  private maxZ = 0;
  private minZ = 0;
  /** A text shape created for editing that has not entered history yet. */
  private draftTextId: string | null = null;
  private clipboard: Shape[] = [];
  private readonly measureText: (s: TextShape) => number;
  private readonly widgetMinSize: (kind: string) => { w: number; h: number };

  constructor(opts: BoardEditorOptions) {
    this.clientId = opts.clientId;
    this.measureText = opts.measureText ?? defaultMeasureText;
    this.widgetMinSize = opts.widgetMinSize ?? (() => ({ w: 120, h: 60 }));
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  subscribeLive(fn: () => void): () => void {
    this.liveListeners.add(fn);
    return () => this.liveListeners.delete(fn);
  }

  onChange(fn: (c: BoardChange) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private notify(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  /** rAF-batched notify for high-frequency gesture updates. */
  private notifySoon(): void {
    if (this.notifyQueued) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.notify();
      return;
    }
    this.notifyQueued = true;
    requestAnimationFrame(() => {
      this.notifyQueued = false;
      this.notify();
    });
  }

  private notifyLive(): void {
    for (const fn of this.liveListeners) fn();
  }

  /** Ask the live canvases to repaint (remote strokes/laser changed). */
  repaintLive(): void {
    this.notifyLive();
  }

  // -------------------------------------------------------------------------
  // Document mutation (the single write path)
  // -------------------------------------------------------------------------

  /** Replace the whole document (initial load). No history, no change event. */
  load(shapes: Iterable<Shape>): void {
    const map = new Map<string, Shape>();
    for (const s of shapes) map.set(s.id, s);
    this.setShapes(map);
    this.undoStack = [];
    this.redoStack = [];
    this.notify();
  }

  private setShapes(map: Map<string, Shape>): void {
    this.shapes = map;
    this.order = paintOrder(map.values());
    this.maxZ = this.order.length ? this.order[this.order.length - 1].z : 0;
    this.minZ = this.order.length ? this.order[0].z : 0;
    if (this.selection.size) {
      const kept = [...this.selection].filter((id) => map.has(id));
      if (kept.length !== this.selection.size) this.selection = new Set(kept);
    }
  }

  /**
   * Apply local puts/removes. Stamps rev/by, updates state, emits a change
   * event. Returns the before-images (for callers building history).
   */
  private applyLocal(puts: Shape[], removes: string[]): Map<string, Shape | null> {
    const before = new Map<string, Shape | null>();
    if (puts.length === 0 && removes.length === 0) return before;
    const next = new Map(this.shapes);
    const stamped: Shape[] = [];
    const tombstones: Tombstone[] = [];
    for (const s of puts) {
      if (!before.has(s.id)) before.set(s.id, this.shapes.get(s.id) ?? null);
      const out = { ...s, rev: nextRev(), by: this.clientId } as Shape;
      next.set(out.id, out);
      stamped.push(out);
    }
    for (const id of removes) {
      if (!this.shapes.has(id) && !next.has(id)) continue;
      if (!before.has(id)) before.set(id, this.shapes.get(id) ?? null);
      next.delete(id);
      tombstones.push({ id, deleted: true, rev: nextRev(), by: this.clientId });
    }
    this.setShapes(next);
    for (const fn of this.changeListeners) fn({ puts: stamped, tombstones, source: 'local' });
    return before;
  }

  private pushHistory(before: Map<string, Shape | null>, selBefore: string[]): void {
    if (before.size === 0) return;
    const after = new Map<string, Shape | null>();
    for (const id of before.keys()) after.set(id, this.shapes.get(id) ?? null);
    this.undoStack.push({ before, after, selBefore, selAfter: [...this.selection] });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Local change with one undo step. */
  commit(puts: Shape[], removes: string[] = [], select?: string[]): void {
    const selBefore = [...this.selection];
    const before = this.applyLocal(puts, removes);
    if (select) this.selection = new Set(select.filter((id) => this.shapes.has(id)));
    this.pushHistory(before, selBefore);
    this.notify();
  }

  /** Merge remote records (cloud load / realtime). Never touches history. */
  applyRemote(records: readonly BoardRecord[]): void {
    let next: Map<string, Shape> | null = null;
    const puts: Shape[] = [];
    const tombstones: Tombstone[] = [];
    for (const r of records) {
      const current = (next ?? this.shapes).get(r.id);
      if (current && !recordWins(r, current)) continue;
      if (!current && isTombstone(r)) continue;
      next ??= new Map(this.shapes);
      if (isTombstone(r)) {
        next.delete(r.id);
        tombstones.push(r);
        if (this.editingId === r.id) this.editingId = null;
      } else {
        next.set(r.id, r);
        puts.push(r);
      }
    }
    if (!next) return;
    this.setShapes(next);
    for (const fn of this.changeListeners) fn({ puts, tombstones, source: 'remote' });
    this.notify();
  }

  undo(): void {
    this.finishEditing();
    const t = this.undoStack.pop();
    if (!t) return;
    this.replay(t.before, t.selBefore);
    this.redoStack.push(t);
  }

  redo(): void {
    this.finishEditing();
    const t = this.redoStack.pop();
    if (!t) return;
    this.replay(t.after, t.selAfter);
    this.undoStack.push(t);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private replay(state: Map<string, Shape | null>, sel: string[]): void {
    const puts: Shape[] = [];
    const removes: string[] = [];
    for (const [id, s] of state) {
      if (s) puts.push(s);
      else removes.push(id);
    }
    this.applyLocal(puts, removes);
    this.selection = new Set(sel.filter((id) => this.shapes.has(id)));
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  setViewport(w: number, h: number): void {
    if (w === this.viewport.w && h === this.viewport.h) return;
    this.viewport = { w, h };
    this.notify();
  }

  setCamera(c: Camera): void {
    this.camera = { x: c.x, y: c.y, z: clampZoom(c.z) };
    this.notifySoon();
  }

  screenToPage(sx: number, sy: number): Point {
    const { x, y, z } = this.camera;
    return { x: (sx - x) / z, y: (sy - y) / z };
  }

  pageToScreen(px: number, py: number): Point {
    const { x, y, z } = this.camera;
    return { x: px * z + x, y: py * z + y };
  }

  /** The page-space rect currently on screen. */
  viewPageRect(): Rect {
    const tl = this.screenToPage(0, 0);
    return { x: tl.x, y: tl.y, w: this.viewport.w / this.camera.z, h: this.viewport.h / this.camera.z };
  }

  zoomAt(sx: number, sy: number, z: number): void {
    const nz = clampZoom(z);
    const p = this.screenToPage(sx, sy);
    this.setCamera({ x: sx - p.x * nz, y: sy - p.y * nz, z: nz });
  }

  panBy(dx: number, dy: number): void {
    this.setCamera({ ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy });
  }

  zoomStep(dir: 1 | -1): void {
    const z = this.camera.z;
    const next =
      dir > 0
        ? (ZOOM_STEPS.find((s) => s > z + 1e-6) ?? MAX_ZOOM)
        : ([...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6) ?? MIN_ZOOM);
    this.zoomAt(this.viewport.w / 2, this.viewport.h / 2, next);
  }

  resetZoom(): void {
    this.zoomAt(this.viewport.w / 2, this.viewport.h / 2, 1);
  }

  /** Fit a page rect in view with screen padding; zoom capped at `maxZ`. */
  zoomToRect(r: Rect, maxZ = 1, pad = 64): void {
    const { w, h } = this.viewport;
    if (w <= 0 || h <= 0) return;
    const z = clampZoom(
      Math.min(maxZ, (w - pad * 2) / Math.max(1, r.w), (h - pad * 2) / Math.max(1, r.h)),
    );
    this.setCamera({ x: w / 2 - (r.x + r.w / 2) * z, y: h / 2 - (r.y + r.h / 2) * z, z });
  }

  zoomToFit(): void {
    const r = unionRects(this.order.map(shapeRect));
    if (r) this.zoomToRect(r);
    else this.setCamera({ x: this.viewport.w / 2, y: this.viewport.h / 2, z: 1 });
  }

  zoomToSelection(): void {
    const r = this.selectionBounds();
    if (r) this.zoomToRect(r, 2);
  }

  /** Center the camera on a page point (keeps zoom). */
  centerOn(p: Point): void {
    const z = this.camera.z;
    this.setCamera({ x: this.viewport.w / 2 - p.x * z, y: this.viewport.h / 2 - p.y * z, z });
  }

  /** Page point at the center of the view. */
  viewCenter(): Point {
    return this.screenToPage(this.viewport.w / 2, this.viewport.h / 2);
  }

  // -------------------------------------------------------------------------
  // Tool, style, selection
  // -------------------------------------------------------------------------

  setTool(tool: Tool): void {
    if (this.tool === tool) return;
    this.finishEditing();
    this.tool = tool;
    if (tool !== 'select') this.selection = new Set();
    this.notify();
  }

  setStyle(patch: Partial<BoardStyle>): void {
    this.style = { ...this.style, ...patch };
    // Restyle the selection too (one undo step).
    const puts: Shape[] = [];
    for (const id of this.selection) {
      const s = this.shapes.get(id);
      if (!s || s.locked) continue;
      if (s.type === 'ink') {
        puts.push({
          ...s,
          ...(patch.color ? { color: s.highlighter ? s.color : patch.color } : {}),
          ...(patch.highlighterColor && s.highlighter ? { color: patch.highlighterColor } : {}),
          ...(patch.size ? { size: patch.size } : {}),
        });
      } else if (s.type === 'text') {
        const t: TextShape = {
          ...s,
          ...(patch.color ? { color: patch.color } : {}),
          ...(patch.size ? { size: patch.size } : {}),
          ...(patch.align ? { align: patch.align } : {}),
        };
        puts.push({ ...t, h: this.measureText(t) });
      }
    }
    if (puts.length) this.commit(puts, [], [...this.selection]);
    else this.notify();
  }

  setSelection(ids: Iterable<string>): void {
    this.selection = new Set([...ids].filter((id) => this.shapes.has(id)));
    this.notify();
  }

  selectAll(): void {
    this.setTool('select');
    this.setSelection(this.shapes.keys());
  }

  selectedShapes(): Shape[] {
    return [...this.selection].map((id) => this.shapes.get(id)).filter((s): s is Shape => !!s);
  }

  selectionBounds(): Rect | null {
    return unionRects(this.selectedShapes().map(shapeRect));
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  deleteSelection(): void {
    const ids = this.selectedShapes().filter((s) => !s.locked).map((s) => s.id);
    if (ids.length) this.commit([], ids, []);
  }

  duplicateSelection(offset = 16): void {
    const copies = this.cloneShapes(this.selectedShapes(), offset, offset);
    if (copies.length) this.commit(copies, [], copies.map((s) => s.id));
  }

  nudge(dx: number, dy: number): void {
    const z = this.camera.z;
    const puts = this.selectedShapes()
      .filter((s) => !s.locked)
      .map((s) => translateShape(s, dx / z, dy / z));
    if (puts.length) this.commit(puts, [], [...this.selection]);
  }

  /** z-order: 'front' | 'back' | 'forward' | 'backward'. */
  reorder(where: 'front' | 'back' | 'forward' | 'backward'): void {
    const sel = this.selectedShapes();
    if (!sel.length) return;
    const ids = new Set(sel.map((s) => s.id));
    let puts: Shape[];
    if (where === 'front') {
      puts = paintOrder(sel).map((s, i) => ({ ...s, z: this.maxZ + 1 + i }));
    } else if (where === 'back') {
      puts = paintOrder(sel).map((s, i, all) => ({ ...s, z: this.minZ - all.length + i }));
    } else {
      // One step: jump just past the nearest overlapping non-selected shape.
      const bounds = this.selectionBounds()!;
      const others = this.order.filter((s) => !ids.has(s.id) && rectsIntersect(bounds, shapeRect(s)));
      const selMax = Math.max(...sel.map((s) => s.z));
      const selMin = Math.min(...sel.map((s) => s.z));
      if (where === 'forward') {
        const above = others.filter((s) => s.z > selMin).sort((a, b) => a.z - b.z)[0];
        if (!above) return;
        const next = this.order.find((s) => s.z > above.z && !ids.has(s.id));
        const top = next ? (above.z + next.z) / 2 : above.z + 1;
        puts = paintOrder(sel).map((s, i, all) => ({ ...s, z: above.z + ((top - above.z) * (i + 1)) / (all.length + 1) }));
      } else {
        const below = others.filter((s) => s.z < selMax).sort((a, b) => b.z - a.z)[0];
        if (!below) return;
        const prev = [...this.order].reverse().find((s) => s.z < below.z && !ids.has(s.id));
        const bottom = prev ? (below.z + prev.z) / 2 : below.z - 1;
        puts = paintOrder(sel).map((s, i, all) => ({ ...s, z: bottom + ((below.z - bottom) * (i + 1)) / (all.length + 1) }));
      }
    }
    this.commit(puts, [], [...ids]);
  }

  toggleLock(): void {
    const sel = this.selectedShapes();
    if (!sel.length) return;
    const lock = sel.some((s) => !s.locked);
    this.commit(sel.map((s) => ({ ...s, locked: lock || undefined })), [], [...this.selection]);
  }

  /** Copies with fresh ids (and z on top), offset in page units. */
  cloneShapes(shapes: readonly Shape[], dx: number, dy: number): Shape[] {
    let z = this.maxZ;
    return paintOrder(shapes).map((s) => {
      z += 1;
      return { ...translateShape(s, dx, dy), id: newShapeId(), z, locked: undefined } as Shape;
    });
  }

  copySelection(): string | null {
    const sel = this.selectedShapes();
    if (!sel.length) return null;
    this.clipboard = sel;
    return JSON.stringify({ ryansBoard: 1, shapes: sel });
  }

  cutSelection(): string | null {
    const json = this.copySelection();
    if (json) this.deleteSelection();
    return json;
  }

  /** Paste shapes (from our clipboard JSON, or the in-memory fallback) centered at `at`. */
  pasteShapes(json: string | null, at?: Point): boolean {
    let shapes: Shape[] = this.clipboard;
    if (json) {
      try {
        const parsed = JSON.parse(json) as { ryansBoard?: number; shapes?: Shape[] };
        if (parsed?.ryansBoard !== 1 || !Array.isArray(parsed.shapes)) return false;
        shapes = parsed.shapes;
      } catch {
        return false;
      }
    }
    if (!shapes.length) return false;
    const b = unionRects(shapes.map(shapeRect))!;
    const target = at ?? this.viewCenter();
    const copies = this.cloneShapes(shapes, target.x - (b.x + b.w / 2), target.y - (b.y + b.h / 2));
    this.setTool('select');
    this.commit(copies, [], copies.map((s) => s.id));
    return true;
  }

  private nextZ(): number {
    return this.maxZ + 1;
  }

  insertImage(src: string, naturalW: number, naturalH: number, at?: Point): string {
    const c = at ?? this.viewCenter();
    // Fit into ~480 page units on the long side at the current zoom.
    const scale = Math.min(1, 480 / Math.max(naturalW, naturalH));
    const w = Math.max(16, naturalW * scale);
    const h = Math.max(16, naturalH * scale);
    const shape: ImageShape = {
      id: newShapeId(),
      type: 'image',
      x: c.x - w / 2,
      y: c.y - h / 2,
      w,
      h,
      z: this.nextZ(),
      rev: 0,
      by: this.clientId,
      src,
      naturalW,
      naturalH,
    };
    this.setTool('select');
    this.commit([shape], [], [shape.id]);
    return shape.id;
  }

  insertWidget(
    kind: string,
    config: Record<string, unknown>,
    size: { w: number; h: number },
    at?: Point,
  ): string {
    const c = at ?? this.viewCenter();
    const shape: WidgetShape = {
      id: newShapeId(),
      type: 'widget',
      x: c.x - size.w / 2,
      y: c.y - size.h / 2,
      w: size.w,
      h: size.h,
      z: this.nextZ(),
      rev: 0,
      by: this.clientId,
      kind,
      config,
    };
    this.setTool('select');
    this.commit([shape], [], [shape.id]);
    return shape.id;
  }

  updateShape(id: string, patch: Partial<Shape>): void {
    const s = this.shapes.get(id);
    if (!s) return;
    this.commit([{ ...s, ...patch } as Shape], [], [...this.selection]);
  }

  insertText(text: string, at?: Point): string {
    const c = at ?? this.viewCenter();
    const t: TextShape = {
      id: newShapeId(),
      type: 'text',
      x: c.x,
      y: c.y,
      w: TEXT_DEFAULT_W,
      h: 0,
      z: this.nextZ(),
      rev: 0,
      by: this.clientId,
      text,
      color: this.style.color,
      size: this.style.size,
      align: this.style.align,
    };
    t.h = this.measureText(t);
    this.commit([t], [], [t.id]);
    return t.id;
  }

  // -------------------------------------------------------------------------
  // Text editing
  // -------------------------------------------------------------------------

  /** Create a draft text shape at a page point and start editing it. */
  beginTextAt(p: Point): void {
    const t: TextShape = {
      id: newShapeId(),
      type: 'text',
      x: p.x,
      y: p.y - (FONT_SIZE[this.style.size] * TEXT_LINE_HEIGHT) / 2,
      w: TEXT_DEFAULT_W,
      h: FONT_SIZE[this.style.size] * TEXT_LINE_HEIGHT,
      z: this.nextZ(),
      rev: 0,
      by: this.clientId,
      text: '',
      color: this.style.color,
      size: this.style.size,
      align: this.style.align,
    };
    // Drafts stay out of the shared document until they have text.
    const next = new Map(this.shapes);
    next.set(t.id, t);
    this.setShapes(next);
    this.draftTextId = t.id;
    this.editingId = t.id;
    this.selection = new Set([t.id]);
    this.notify();
  }

  startEditing(id: string): void {
    const s = this.shapes.get(id);
    if (!s || s.type !== 'text' || s.locked) return;
    this.editingId = id;
    this.selection = new Set([id]);
    this.notify();
  }

  /** Commit the text being edited. Empty text deletes the shape. */
  commitText(id: string, text: string): void {
    if (this.editingId !== id) return;
    this.editingId = null;
    const s = this.shapes.get(id);
    const isDraft = this.draftTextId === id;
    this.draftTextId = null;
    if (!s || s.type !== 'text') {
      this.notify();
      return;
    }
    const trimmed = text.replace(/\s+$/, '');
    if (!trimmed) {
      if (isDraft) {
        const next = new Map(this.shapes);
        next.delete(id);
        this.setShapes(next);
        this.selection = new Set();
        this.notify();
      } else {
        this.commit([], [id], []);
      }
      return;
    }
    if (!isDraft && trimmed === s.text) {
      this.notify();
      return;
    }
    const updated: TextShape = { ...s, text: trimmed };
    updated.h = this.measureText(updated);
    if (isDraft) {
      // Enter history as a create (before = null).
      const draftless = new Map(this.shapes);
      draftless.delete(id);
      this.shapes = draftless;
    }
    this.commit([updated], [], [id]);
  }

  finishEditing(): void {
    // The TextEditor commits on blur; this only clears a dangling draft.
    if (this.editingId && this.draftTextId === this.editingId) {
      const s = this.shapes.get(this.editingId);
      if (s && s.type === 'text' && !s.text) {
        const next = new Map(this.shapes);
        next.delete(s.id);
        this.setShapes(next);
      }
      this.draftTextId = null;
    }
    this.editingId = null;
  }

  // -------------------------------------------------------------------------
  // Pointer gestures
  // -------------------------------------------------------------------------

  get isGesturing(): boolean {
    return this.gesture != null;
  }

  /** Which selection handle (if any) is under a screen point. */
  handleAt(sx: number, sy: number, hitPx: number): Handle | null {
    const b = this.selectionBounds();
    if (!b || this.selection.size === 0) return null;
    if ([...this.selection].every((id) => this.shapes.get(id)?.locked)) return null;
    const tl = this.pageToScreen(b.x, b.y);
    const br = this.pageToScreen(b.x + b.w, b.y + b.h);
    const mx = (tl.x + br.x) / 2;
    const my = (tl.y + br.y) / 2;
    const pts: [Handle, number, number][] = [
      ['nw', tl.x, tl.y],
      ['ne', br.x, tl.y],
      ['se', br.x, br.y],
      ['sw', tl.x, br.y],
      ['n', mx, tl.y],
      ['s', mx, br.y],
      ['e', br.x, my],
      ['w', tl.x, my],
    ];
    for (const [h, x, y] of pts) {
      if (Math.abs(sx - x) <= hitPx && Math.abs(sy - y) <= hitPx) return h;
    }
    return null;
  }

  shapeAtScreen(sx: number, sy: number): Shape | null {
    const p = this.screenToPage(sx, sy);
    return topShapeAt(this.order, p, HIT_SLOP / this.camera.z);
  }

  setSpaceHeld(held: boolean): void {
    if (this.spaceHeld === held) return;
    this.spaceHeld = held;
    this.notify();
  }

  /** Tool currently in effect (Space temporarily forces the hand). */
  get effectiveTool(): Tool {
    return this.spaceHeld ? 'hand' : this.tool;
  }

  pointerDown(e: PointerInfo, opts: { forcePan?: boolean; handleHitPx?: number } = {}): void {
    if (this.gesture) return;
    if (e.pointerType === 'pen' && !this.penMode) {
      this.penMode = true;
      this.notify();
    }
    this.gesturePointer = e.pointerId;
    const tool = opts.forcePan ? 'hand' : this.effectiveTool;
    const p = this.screenToPage(e.sx, e.sy);
    switch (tool) {
      case 'hand':
        this.gesture = { kind: 'pan', sx: e.sx, sy: e.sy, cam: this.camera };
        return;
      case 'pen':
      case 'highlighter': {
        const highlighter = tool === 'highlighter';
        this.live.stroke = {
          id: newShapeId(),
          points: [[p.x, p.y, e.pressure]],
          color: highlighter ? this.style.highlighterColor : this.style.color,
          size: this.style.size,
          highlighter,
        };
        this.gesture = { kind: 'stroke' };
        this.notifyLive();
        return;
      }
      case 'eraser':
        this.gesture = { kind: 'erase' };
        this.pendingErase = new Set();
        this.eraseAlong(p, p);
        this.live.eraser = p;
        this.notifyLive();
        return;
      case 'laser':
        this.gesture = { kind: 'laser' };
        this.live.laser.push({ x: p.x, y: p.y, t: performance.now() });
        this.notifyLive();
        return;
      case 'text': {
        const hit = this.shapeAtScreen(e.sx, e.sy);
        this.gesture = null;
        this.gesturePointer = null;
        if (hit?.type === 'text') this.startEditing(hit.id);
        else this.beginTextAt(p);
        return;
      }
      case 'select': {
        const handle = this.handleAt(e.sx, e.sy, opts.handleHitPx ?? 8);
        if (handle) {
          const sel = this.selectedShapes().filter((s) => !s.locked);
          this.gesture = {
            kind: 'resize',
            handle,
            startBounds: this.selectionBounds()!,
            originals: new Map(sel.map((s) => [s.id, s])),
          };
          return;
        }
        const hit = this.shapeAtScreen(e.sx, e.sy);
        if (hit) {
          if (e.shift) {
            const next = new Set(this.selection);
            if (next.has(hit.id)) next.delete(hit.id);
            else next.add(hit.id);
            this.selection = next;
          } else if (!this.selection.has(hit.id)) {
            this.selection = new Set([hit.id]);
          }
          this.notify();
          this.gesture = { kind: 'pending', downPage: p, downSx: e.sx, downSy: e.sy, hitId: hit.id, alt: e.alt };
        } else {
          const base = e.shift ? new Set(this.selection) : new Set<string>();
          if (!e.shift && this.selection.size) {
            this.selection = new Set();
            this.notify();
          }
          this.gesture = { kind: 'marquee', startPage: p, base };
        }
        return;
      }
    }
  }

  pointerMove(e: PointerInfo): void {
    const g = this.gesture;
    if (!g || e.pointerId !== this.gesturePointer) return;
    const p = this.screenToPage(e.sx, e.sy);
    switch (g.kind) {
      case 'pan':
        this.setCamera({ ...g.cam, x: g.cam.x + (e.sx - g.sx), y: g.cam.y + (e.sy - g.sy) });
        return;
      case 'stroke': {
        const stroke = this.live.stroke;
        if (!stroke) return;
        const minGap = 0.75 / this.camera.z;
        for (const s of e.samples ?? [{ sx: e.sx, sy: e.sy, pressure: e.pressure }]) {
          const q = this.screenToPage(s.sx, s.sy);
          const last = stroke.points[stroke.points.length - 1];
          if (Math.hypot(q.x - last[0], q.y - last[1]) < minGap) continue;
          stroke.points.push([q.x, q.y, s.pressure]);
        }
        this.notifyLive();
        return;
      }
      case 'erase': {
        const from = this.live.eraser ?? p;
        this.eraseAlong(from, p);
        this.live.eraser = p;
        this.notifyLive();
        return;
      }
      case 'laser':
        this.live.laser.push({ x: p.x, y: p.y, t: performance.now() });
        this.notifyLive();
        return;
      case 'pending': {
        if (Math.hypot(e.sx - g.downSx, e.sy - g.downSy) < DRAG_THRESHOLD) return;
        this.beginTranslate(g.downPage, g.alt);
        this.pointerMove(e);
        return;
      }
      case 'translate': {
        const dx = p.x - g.startPage.x;
        const dy = p.y - g.startPage.y;
        const next = new Map(this.shapes);
        for (const [id, orig] of g.originals) next.set(id, translateShape(orig, dx, dy));
        this.setShapesLive(next, [...g.originals.keys()]);
        // Alt-duplicates don't exist remotely yet; only broadcast real moves.
        if (g.created.size === 0) {
          this.live.drag = { ids: [...g.originals.keys()], dx, dy };
          this.notifyLive();
        }
        return;
      }
      case 'resize':
        this.resizeTo(g, p, e.shift, e.alt);
        return;
      case 'marquee': {
        const r = rectFromPoints(g.startPage, p);
        this.marquee = r;
        const hits = shapesInMarquee(this.shapes.values(), r).map((s) => s.id);
        this.selection = new Set([...g.base, ...hits]);
        this.notifySoon();
        return;
      }
    }
  }

  pointerUp(e: PointerInfo): void {
    let g = this.gesture;
    if (!g || e.pointerId !== this.gesturePointer) return;
    // The release position can differ from the last move (fast flicks,
    // synthetic drags): apply it before finishing.
    if (g.kind !== 'pan' && g.kind !== 'pending' && g.kind !== 'laser') {
      this.pointerMove(e);
      g = this.gesture ?? g;
    }
    this.gesture = null;
    this.gesturePointer = null;
    switch (g.kind) {
      case 'stroke':
        this.commitStroke();
        return;
      case 'erase': {
        const ids = [...this.pendingErase];
        this.pendingErase = new Set();
        this.live.eraser = null;
        this.notifyLive();
        if (ids.length) this.commit([], ids, [...this.selection].filter((id) => !ids.includes(id)));
        else this.notify();
        return;
      }
      case 'laser':
        this.notifyLive();
        return;
      case 'pending':
        return;
      case 'translate':
      case 'resize':
        this.finishLiveGesture(g.originals, g.kind === 'translate' ? g.created : new Set());
        return;
      case 'marquee':
        this.marquee = null;
        this.notify();
        return;
      case 'pan':
        return;
    }
  }

  /** Abort the current gesture (second finger landed, pointer cancel). */
  cancelGesture(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.gesturePointer = null;
    if (g.kind === 'stroke') {
      this.live.stroke = null;
      this.notifyLive();
    } else if (g.kind === 'erase') {
      this.pendingErase = new Set();
      this.live.eraser = null;
      this.notifyLive();
      this.notify();
    } else if (g.kind === 'translate' || g.kind === 'resize') {
      this.finishLiveGesture(g.originals, g.kind === 'translate' ? g.created : new Set());
    } else if (g.kind === 'marquee') {
      this.marquee = null;
      this.notify();
    }
  }

  /** Remove laser points older than the fade window; true when any remain. */
  pruneLaser(now: number): boolean {
    const cutoff = now - LASER_FADE_MS;
    const l = this.live.laser;
    let i = 0;
    while (i < l.length && l[i].t < cutoff) i += 1;
    if (i) l.splice(0, i);
    return l.length > 0;
  }

  private commitStroke(): void {
    const stroke = this.live.stroke;
    this.live.stroke = null;
    this.notifyLive();
    if (!stroke || stroke.points.length === 0) return;
    const diameter = INK_SIZE[stroke.size] * (stroke.highlighter ? HIGHLIGHTER_SCALE : 1);
    const geo = inkGeometry(stroke.points, diameter);
    const ink: InkShape = {
      id: stroke.id,
      type: 'ink',
      ...geo,
      z: this.nextZ(),
      rev: 0,
      by: this.clientId,
      color: stroke.color,
      size: stroke.size,
      ...(stroke.highlighter ? { highlighter: true } : {}),
    };
    this.commit([ink], [], [...this.selection]);
  }

  private eraseAlong(from: Point, to: Point): void {
    const z = this.camera.z;
    const radius = ERASER_RADIUS / z;
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (4 / z)));
    let changed = false;
    const next = new Set(this.pendingErase);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const q = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      for (let k = this.order.length - 1; k >= 0; k -= 1) {
        const s = this.order[k];
        if (s.type === 'widget' || s.locked || next.has(s.id)) continue;
        if (topShapeAt([s], q, radius)) {
          next.add(s.id);
          changed = true;
        }
      }
    }
    if (changed) {
      this.pendingErase = next;
      this.notifySoon();
    }
  }

  private beginTranslate(startPage: Point, duplicate: boolean): void {
    let sel = this.selectedShapes().filter((s) => !s.locked);
    const created = new Set<string>();
    if (duplicate && sel.length) {
      const copies = this.cloneShapes(sel, 0, 0);
      const next = new Map(this.shapes);
      for (const c of copies) {
        next.set(c.id, c);
        created.add(c.id);
      }
      this.setShapes(next);
      this.selection = new Set(copies.map((c) => c.id));
      sel = copies;
    }
    this.gesture = { kind: 'translate', startPage, originals: new Map(sel.map((s) => [s.id, s])), created };
  }

  private resizeTo(
    g: Extract<Gesture, { kind: 'resize' }>,
    p: Point,
    shift: boolean,
    alt: boolean,
  ): void {
    const b = g.startBounds;
    let left = b.x;
    let top = b.y;
    let right = b.x + b.w;
    let bottom = b.y + b.h;
    const h = g.handle;
    if (h.includes('w')) left = p.x;
    if (h.includes('e')) right = p.x;
    if (h.includes('n')) top = p.y;
    if (h.includes('s')) bottom = p.y;
    if (alt) {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (h.includes('w')) right = cx + (cx - left);
      if (h.includes('e')) left = cx - (right - cx);
      if (h.includes('n')) bottom = cy + (cy - top);
      if (h.includes('s')) top = cy - (bottom - cy);
    }
    const originals = [...g.originals.values()];
    const onlyImages = originals.length > 0 && originals.every((s) => s.type === 'image');
    const keepAspect = (shift !== onlyImages) && h.length === 2 && b.w > 0 && b.h > 0;
    let to: Rect = { x: left, y: top, w: right - left, h: bottom - top };
    if (keepAspect) {
      const s = Math.max(Math.abs(to.w) / b.w, Math.abs(to.h) / b.h);
      const w = b.w * s * Math.sign(to.w || 1);
      const hh = b.h * s * Math.sign(to.h || 1);
      to = {
        x: h.includes('w') ? right - w : left,
        y: h.includes('n') ? bottom - hh : top,
        w,
        h: hh,
      };
    }
    const next = new Map(this.shapes);
    for (const orig of originals) {
      let s = scaleShape(orig, b, to);
      if (s.type === 'widget' && originals.length === 1) {
        const min = this.widgetMinSize(s.kind);
        s = { ...s, w: Math.max(min.w, s.w), h: Math.max(min.h, s.h) };
      } else if (s.type === 'text') {
        s = { ...s, w: Math.max(40, s.w) };
        s = { ...s, h: this.measureText(s) };
      }
      next.set(s.id, s);
    }
    this.setShapesLive(next, [...g.originals.keys()]);
  }

  /** In-gesture update: state + persistence events, no history (rAF notify). */
  private setShapesLive(next: Map<string, Shape>, _ids: string[]): void {
    this.setShapes(next);
    this.notifySoon();
  }

  /**
   * Show a collaborator's in-progress move: positions only, no rev, no change
   * event, no history. The real record (newer rev) replaces it when it lands.
   */
  applyPreview(shapes: readonly Shape[]): void {
    if (!shapes.length) return;
    const next = new Map(this.shapes);
    let changed = false;
    for (const s of shapes) {
      if (!next.has(s.id) || this.isGesturing) continue;
      next.set(s.id, s);
      changed = true;
    }
    if (!changed) return;
    this.setShapes(next);
    this.notifySoon();
  }

  /** End a translate/resize: emit the final records and push ONE undo step. */
  private finishLiveGesture(originals: Map<string, Shape>, created: Set<string>): void {
    if (this.live.drag) {
      this.live.drag = null;
      this.notifyLive();
    }
    const finals: Shape[] = [];
    for (const id of originals.keys()) {
      const s = this.shapes.get(id);
      if (s) finals.push(s);
    }
    const moved = finals.filter((s) => {
      const o = originals.get(s.id)!;
      return created.has(s.id) || o.x !== s.x || o.y !== s.y || o.w !== s.w || o.h !== s.h;
    });
    if (!moved.length) {
      this.notify();
      return;
    }
    const selBefore = [...this.selection];
    // Restore the pre-gesture document so applyLocal records true before-images.
    const restored = new Map(this.shapes);
    for (const [id, o] of originals) {
      if (created.has(id)) restored.delete(id);
      else restored.set(id, o);
    }
    this.shapes = restored;
    const before = this.applyLocal(moved, []);
    this.selection = new Set(selBefore);
    this.pushHistory(before, selBefore);
    this.notify();
  }
}
