// src/dash/board/model.ts
// Pure document model for Ryan's Board (the lead dashboard's infinite canvas).
// No React, no IO: shape types, geometry, hit-testing, transforms and the
// per-record merge rule shared by local persistence and cloud sync.
// Plan: docs/plans/ryans-board/README.md §4.
//
// Coordinates are PAGE units (unbounded). The camera maps page -> screen as
// `screen = page * z + (x, y)` (see editor.ts).
//
// Merge rule (mirrored by the `upsert_board_records` RPC): every record carries
// a monotonic `rev` (nextCanvasGeneration) and the writing client's id `by`.
// Per record, the higher rev wins; ties break on `by` so every device
// converges. Deletes are tombstones with their own rev, so an undo can
// resurrect a record simply by writing it again at a newer rev.

import { newStrokeId, nextCanvasGeneration } from '@/dash/strategy/strokes';

export type ColorName =
  | 'white'
  | 'gray'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'blue'
  | 'violet'
  | 'pink';

export const COLOR_NAMES: readonly ColorName[] = [
  'white',
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
];

/** Ink/text colors tuned for the near-black canvas. */
export const COLORS: Record<ColorName, string> = {
  white: '#f4f4f5',
  gray: '#9ca3af',
  red: '#f87171',
  orange: '#fb923c',
  yellow: '#facc15',
  green: '#4ade80',
  teal: '#2dd4bf',
  blue: '#60a5fa',
  violet: '#c084fc',
  pink: '#f472b6',
};

export type SizeName = 's' | 'm' | 'l' | 'xl';
export const SIZE_NAMES: readonly SizeName[] = ['s', 'm', 'l', 'xl'];

/** Freehand ink diameter (page units). */
export const INK_SIZE: Record<SizeName, number> = { s: 3, m: 5, l: 9, xl: 16 };
/** Text font size (page units). */
export const FONT_SIZE: Record<SizeName, number> = { s: 16, m: 22, l: 32, xl: 48 };
export const TEXT_LINE_HEIGHT = 1.3;
export const HIGHLIGHTER_SCALE = 3.2;
export const HIGHLIGHTER_OPACITY = 0.35;

export type TextAlign = 'start' | 'middle' | 'end';

export interface ShapeBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Paint order; higher draws on top. Fractional, so inserts never renumber. */
  z: number;
  /** Merge revision (higher wins). */
  rev: number;
  /** Writing client id (merge tie-break). */
  by: string;
  locked?: boolean;
}

export interface InkShape extends ShapeBase {
  type: 'ink';
  /** [x, y, pressure] relative to the shape origin. */
  points: [number, number, number][];
  color: ColorName;
  size: SizeName;
  highlighter?: boolean;
}

export interface TextShape extends ShapeBase {
  type: 'text';
  text: string;
  color: ColorName;
  size: SizeName;
  align: TextAlign;
}

export interface ImageShape extends ShapeBase {
  type: 'image';
  src: string;
  naturalW: number;
  naturalH: number;
}

export interface WidgetShape extends ShapeBase {
  type: 'widget';
  kind: string;
  config: Record<string, unknown>;
}

export interface CommentShape extends ShapeBase {
  type: 'comment';
  thread: { id: string; author: string; text: string; at: number }[];
  resolved: boolean;
}

export type Shape = InkShape | TextShape | ImageShape | WidgetShape | CommentShape;
export type ShapeType = Shape['type'];
export const SHAPE_TYPES: readonly ShapeType[] = ['ink', 'text', 'image', 'widget', 'comment'];

export interface Tombstone {
  id: string;
  deleted: true;
  rev: number;
  by: string;
}

/** A persisted record: a live shape or a tombstone. */
export type BoardRecord = Shape | Tombstone;

export function isTombstone(r: BoardRecord): r is Tombstone {
  return (r as Tombstone).deleted === true;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function newShapeId(): string {
  return `s:${newStrokeId()}`;
}

export function nextRev(): number {
  return nextCanvasGeneration();
}

/** True when `incoming` should replace `current` (higher rev, then `by` tie-break). */
export function recordWins(
  incoming: { rev: number; by: string },
  current: { rev: number; by: string } | undefined,
): boolean {
  if (!current) return true;
  if (incoming.rev !== current.rev) return incoming.rev > current.rev;
  return incoming.by > current.by;
}

/** Defensive parse of a stored/remote record (drops anything malformed or unknown). */
export function parseRecord(raw: unknown): BoardRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || (typeof r.rev !== 'number' || !Number.isFinite(r.rev)) || typeof r.by !== 'string') {
    return null;
  }
  if (r.deleted === true) return { id: r.id, deleted: true, rev: r.rev, by: r.by };
  if (!SHAPE_TYPES.includes(r.type as ShapeType)) return null;
  for (const k of ['x', 'y', 'w', 'h', 'z'] as const) {
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k] as number)) return null;
  }
  if (r.type === 'ink' && !Array.isArray(r.points)) return null;
  if (r.type === 'text' && typeof r.text !== 'string') return null;
  if (r.type === 'image' && typeof r.src !== 'string') return null;
  if (r.type === 'widget' && (typeof r.kind !== 'string' || !r.config || typeof r.config !== 'object' || Array.isArray(r.config))) {
    return null;
  }
  if (r.type === 'comment' && (typeof r.resolved !== 'boolean' || !Array.isArray(r.thread) ||
    !r.thread.every((v: unknown) => {
      if (!v || typeof v !== 'object') return false;
      const m = v as Record<string, unknown>;
      return typeof m.id === 'string' && typeof m.author === 'string' && typeof m.text === 'string' && typeof m.at === 'number' && Number.isFinite(m.at);
    }))) return null;
  return raw as Shape;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function pointInRect(p: Point, r: Rect, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

/** Normalize a drag (any direction) into a positive rect. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function shapeRect(s: Shape): Rect {
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

/** Rendered diameter of an ink stroke (highlighters are wider). */
export function inkDiameter(s: InkShape): number {
  return INK_SIZE[s.size] * (s.highlighter ? HIGHLIGHTER_SCALE : 1);
}

/**
 * Build an ink shape's geometry from ABSOLUTE page points: the shape box is the
 * points' bounds padded by the stroke radius, and points become box-relative.
 */
export function inkGeometry(
  absPoints: readonly [number, number, number][],
  diameter: number,
): Pick<InkShape, 'x' | 'y' | 'w' | 'h' | 'points'> {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of absPoints) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = diameter / 2;
  const x = minX - pad;
  const y = minY - pad;
  return {
    x,
    y,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
    points: absPoints.map(([px, py, pr]) => [px - x, py - y, pr]),
  };
}

/**
 * Does page point `p` hit shape `s`? `tol` is the hit slop in page units (the
 * caller scales a screen-pixel tolerance by 1/zoom).
 */
export function hitShape(s: Shape, p: Point, tol: number): boolean {
  if (s.type !== 'ink') return pointInRect(p, shapeRect(s), tol);
  if (!pointInRect(p, shapeRect(s), tol)) return false;
  const reach = tol + inkDiameter(s) / 2;
  const pts = s.points;
  if (pts.length === 1) return Math.hypot(p.x - s.x - pts[0][0], p.y - s.y - pts[0][1]) <= reach;
  for (let i = 1; i < pts.length; i += 1) {
    const a = { x: s.x + pts[i - 1][0], y: s.y + pts[i - 1][1] };
    const b = { x: s.x + pts[i][0], y: s.y + pts[i][1] };
    if (distToSegment(p, a, b) <= reach) return true;
  }
  return false;
}

/** Shapes in paint order (z, then id for a stable tie-break across devices). */
export function paintOrder(shapes: Iterable<Shape>): Shape[] {
  return [...shapes].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Topmost shape under `p` in an already paint-ordered list. */
export function topShapeAt(
  ordered: readonly Shape[],
  p: Point,
  tol: number,
  skip?: (s: Shape) => boolean,
): Shape | null {
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const s = ordered[i];
    if (skip?.(s)) continue;
    if (hitShape(s, p, tol)) return s;
  }
  return null;
}

function inkTouchesRect(s: InkShape, r: Rect): boolean {
  if (rectContains(r, shapeRect(s))) return true;
  return s.points.some(([x, y]) => pointInRect({ x: s.x + x, y: s.y + y }, r));
}

/** Shapes a marquee selects: anything touching it (ink must have a point inside). */
export function shapesInMarquee(shapes: Iterable<Shape>, marquee: Rect): Shape[] {
  const out: Shape[] = [];
  for (const s of shapes) {
    if (!rectsIntersect(marquee, shapeRect(s))) continue;
    if (s.type === 'ink' && !inkTouchesRect(s, marquee)) continue;
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transforms (pure)
// ---------------------------------------------------------------------------

export function translateShape<T extends Shape>(s: T, dx: number, dy: number): T {
  return { ...s, x: s.x + dx, y: s.y + dy };
}

/**
 * Map a shape from `from` bounds to `to` bounds (a group resize). Ink points
 * scale with it; text only rewraps (its height is re-measured by the caller).
 * `to` may have negative w/h (dragged past the opposite edge = mirrored).
 */
export function scaleShape<T extends Shape>(s: T, from: Rect, to: Rect): T {
  const sx = from.w === 0 ? 1 : to.w / from.w;
  const sy = from.h === 0 ? 1 : to.h / from.h;
  const ax = Math.abs(sx);
  const ay = Math.abs(sy);
  // Map both corners, then normalize (handles mirroring).
  const x1 = to.x + (s.x - from.x) * sx;
  const y1 = to.y + (s.y - from.y) * sy;
  const x2 = to.x + (s.x + s.w - from.x) * sx;
  const y2 = to.y + (s.y + s.h - from.y) * sy;
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.max(1, Math.abs(x2 - x1));
  const h = Math.max(1, Math.abs(y2 - y1));
  if (s.type === 'ink') {
    const ink = s as InkShape;
    const flipX = sx < 0;
    const flipY = sy < 0;
    return {
      ...ink,
      x,
      y,
      w,
      h,
      points: ink.points.map(([px, py, pr]) => [
        flipX ? w - px * ax : px * ax,
        flipY ? h - py * ay : py * ay,
        pr,
      ]),
    } as T;
  }
  // Text only rewraps: width follows the drag, height is re-measured by the editor.
  if (s.type === 'text') return { ...s, x, y, w } as T;
  return { ...s, x, y, w, h };
}
