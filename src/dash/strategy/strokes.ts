// src/dash/strategy/strokes.ts
// Pure stroke model for the Strategy-tab field whiteboard. No React, no IO —
// everything here is unit-testable. Three concerns:
//   1. the wire/document shape (Stroke / CanvasDoc) shared with the
//      `strategy_canvas` table and its merge-upsert RPC (migration 0042);
//   2. `mergeCanvasDocs` — the CLIENT mirror of the RPC's server-side merge, so
//      hydrating a remote snapshot into local state follows the exact same
//      stroke-id-union + tombstone rules as the server;
//   3. the whiteboard state machine (add / erase / clear / undo / redo).
//
// Tombstone invariant (shared with the RPC): a stroke id in `deletedIds` is
// dead FOREVER — merges drop it everywhere. Any op that resurrects a stroke
// (undo of an erase/clear, redo of an undone add) therefore re-adds it under a
// FRESH id, keeping the merge monotonic across devices.

export interface Stroke {
  /** Client-generated unique id (the merge key across devices). */
  id: string;
  /** Epoch-ms at creation — stable draw order across merged devices. */
  seq: number;
  /** CSS color. */
  color: string;
  /** Pen size as a fraction of the field's HEIGHT (render-size independent). */
  size: number;
  /** [x, y, pressure] triples; x/y NORMALIZED [0,1] field coords (same
   *  convention as auto_path so drawings compose with FieldDiagram overlays). */
  points: [number, number, number][];
}

/** The persisted whiteboard document for one (event, match). */
export interface CanvasDoc {
  strokes: Stroke[];
  deletedIds: string[];
}

export const EMPTY_DOC: CanvasDoc = { strokes: [], deletedIds: [] };

/** Field image aspect (public/assets/field/field.png is 3902×1584). */
export const FIELD_W = 3902;
export const FIELD_H = 1584;
export const FIELD_ASPECT = FIELD_W / FIELD_H;

let idCounter = 0;
/** Unique-enough stroke id: time + random + a per-session counter. */
export function newStrokeId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${idCounter.toString(36)}`;
}

function sortBySeq(strokes: Stroke[]): Stroke[] {
  return strokes.slice().sort((a, b) => a.seq - b.seq);
}

/**
 * CLIENT mirror of the `upsert_strategy_canvas` merge: tombstones union;
 * strokes = incoming wins per id ∪ base strokes the incoming doc doesn't carry,
 * minus anything tombstoned; ordered by seq. Commutative on stroke SETS, so
 * hydrate(remote) and the server's merge(local) converge to the same document.
 */
export function mergeCanvasDocs(base: CanvasDoc, incoming: CanvasDoc): CanvasDoc {
  const deleted = new Set<string>([...base.deletedIds, ...incoming.deletedIds]);
  const byId = new Map<string, Stroke>();
  for (const s of base.strokes) byId.set(s.id, s);
  for (const s of incoming.strokes) byId.set(s.id, s); // incoming wins per id
  const strokes = sortBySeq([...byId.values()].filter((s) => !deleted.has(s.id)));
  return { strokes, deletedIds: [...deleted] };
}

/** Two docs render identically (same visible strokes + same tombstones). */
export function canvasDocsEqual(a: CanvasDoc, b: CanvasDoc): boolean {
  if (a.strokes.length !== b.strokes.length) return false;
  if (a.deletedIds.length !== b.deletedIds.length) return false;
  const bDel = new Set(b.deletedIds);
  for (const id of a.deletedIds) if (!bDel.has(id)) return false;
  const bIds = new Map(b.strokes.map((s) => [s.id, s]));
  for (const s of a.strokes) {
    const o = bIds.get(s.id);
    if (!o || o.points.length !== s.points.length) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Whiteboard state machine (single device): add / erase / clear / undo / redo.
// ---------------------------------------------------------------------------

export type CanvasOp =
  | { kind: 'add'; stroke: Stroke }
  /** Strokes removed together (one eraser drag, or one clear). Kept whole so
   *  undo can re-add them (under fresh ids — see the tombstone invariant). */
  | { kind: 'erase'; strokes: Stroke[] };

export interface WhiteboardState {
  strokes: Stroke[];
  deletedIds: string[];
  undoStack: CanvasOp[];
  redoStack: CanvasOp[];
}

export const INITIAL_WHITEBOARD: WhiteboardState = {
  strokes: [],
  deletedIds: [],
  undoStack: [],
  redoStack: [],
};

export type WhiteboardAction =
  | { type: 'add'; stroke: Stroke }
  | { type: 'erase'; ids: string[] }
  | { type: 'clear' }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Merge a remote/hydrated doc under local state (undo/redo stacks kept). */
  | { type: 'hydrate'; doc: CanvasDoc };

/** Re-issue strokes under fresh ids/seq so tombstoned ids stay dead. */
function reissue(strokes: Stroke[]): Stroke[] {
  const now = Date.now();
  return strokes.map((s, i) => ({ ...s, id: newStrokeId(), seq: now + i }));
}

export function whiteboardReducer(
  state: WhiteboardState,
  action: WhiteboardAction,
): WhiteboardState {
  switch (action.type) {
    case 'add': {
      if (action.stroke.points.length === 0) return state;
      return {
        ...state,
        strokes: [...state.strokes, action.stroke],
        undoStack: [...state.undoStack, { kind: 'add', stroke: action.stroke }],
        redoStack: [],
      };
    }
    case 'erase': {
      const ids = new Set(action.ids);
      const removed = state.strokes.filter((s) => ids.has(s.id));
      if (removed.length === 0) return state;
      return {
        ...state,
        strokes: state.strokes.filter((s) => !ids.has(s.id)),
        deletedIds: [...state.deletedIds, ...removed.map((s) => s.id)],
        undoStack: [...state.undoStack, { kind: 'erase', strokes: removed }],
        redoStack: [],
      };
    }
    case 'clear': {
      if (state.strokes.length === 0) return state;
      return {
        ...state,
        strokes: [],
        deletedIds: [...state.deletedIds, ...state.strokes.map((s) => s.id)],
        undoStack: [...state.undoStack, { kind: 'erase', strokes: state.strokes }],
        redoStack: [],
      };
    }
    case 'undo': {
      const op = state.undoStack[state.undoStack.length - 1];
      if (!op) return state;
      const undoStack = state.undoStack.slice(0, -1);
      if (op.kind === 'add') {
        // Remove + tombstone the stroke; redo re-adds it under a fresh id.
        return {
          ...state,
          strokes: state.strokes.filter((s) => s.id !== op.stroke.id),
          deletedIds: [...state.deletedIds, op.stroke.id],
          undoStack,
          redoStack: [...state.redoStack, op],
        };
      }
      // erase: re-add the removed strokes under FRESH ids (old ids tombstoned);
      // the redo op must erase the REISSUED strokes, so it's rebuilt here.
      const revived = reissue(op.strokes);
      return {
        ...state,
        strokes: sortBySeq([...state.strokes, ...revived]),
        undoStack,
        redoStack: [...state.redoStack, { kind: 'erase', strokes: revived }],
      };
    }
    case 'redo': {
      const op = state.redoStack[state.redoStack.length - 1];
      if (!op) return state;
      const redoStack = state.redoStack.slice(0, -1);
      if (op.kind === 'add') {
        // The original id was tombstoned by undo — re-add under a fresh id and
        // rebuild the undo op so a further undo targets the reissued stroke.
        const [revived] = reissue([op.stroke]);
        return {
          ...state,
          strokes: sortBySeq([...state.strokes, revived]),
          undoStack: [...state.undoStack, { kind: 'add', stroke: revived }],
          redoStack,
        };
      }
      const ids = new Set(op.strokes.map((s) => s.id));
      const removed = state.strokes.filter((s) => ids.has(s.id));
      return {
        ...state,
        strokes: state.strokes.filter((s) => !ids.has(s.id)),
        deletedIds: [...state.deletedIds, ...removed.map((s) => s.id)],
        undoStack: [...state.undoStack, { kind: 'erase', strokes: removed }],
        redoStack,
      };
    }
    case 'hydrate': {
      const merged = mergeCanvasDocs(
        { strokes: state.strokes, deletedIds: state.deletedIds },
        action.doc,
      );
      return { ...state, strokes: merged.strokes, deletedIds: merged.deletedIds };
    }
    default:
      return state;
  }
}

export function docOf(state: WhiteboardState): CanvasDoc {
  return { strokes: state.strokes, deletedIds: state.deletedIds };
}

// ---------------------------------------------------------------------------
// Eraser hit-testing. Distances are computed in ASPECT-TRUE space (x scaled by
// FIELD_ASPECT) so the eraser radius feels circular on screen even though the
// stored coords are normalized to a non-square field.
// ---------------------------------------------------------------------------

/** Squared distance from point p to segment ab, in aspect-true units of field
 *  HEIGHT (y-units). */
function segDist2(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2)) : 0;
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return dx * dx + dy * dy;
}

/**
 * True when the (normalized) point is within `radius` (fraction of field
 * height) of the stroke's polyline — the stroke's own half-width counts toward
 * the hit so fat strokes erase as easily as they read.
 */
export function strokeHitTest(
  stroke: Stroke,
  x: number,
  y: number,
  radius: number,
): boolean {
  const px = x * FIELD_ASPECT;
  const py = y;
  const r = radius + stroke.size / 2;
  const r2 = r * r;
  const pts = stroke.points;
  if (pts.length === 1) {
    const dx = px - pts[0][0] * FIELD_ASPECT;
    const dy = py - pts[0][1];
    return dx * dx + dy * dy <= r2;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const d2 = segDist2(
      px, py,
      pts[i][0] * FIELD_ASPECT, pts[i][1],
      pts[i + 1][0] * FIELD_ASPECT, pts[i + 1][1],
    );
    if (d2 <= r2) return true;
  }
  return false;
}

/** Ids of all strokes hit by an eraser touch at (x, y). */
export function erasedIdsAt(
  strokes: Stroke[],
  x: number,
  y: number,
  radius: number,
): string[] {
  return strokes.filter((s) => strokeHitTest(s, x, y, radius)).map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Wire (snake-ish jsonb) parsing for rows read from strategy_canvas.
// ---------------------------------------------------------------------------

function isPointTriple(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === 'number' && Number.isFinite(v[0]) &&
    typeof v[1] === 'number' && Number.isFinite(v[1])
  );
}

/** Parse one stroke object from jsonb; null on malformed input (never throws). */
export function parseStroke(raw: unknown): Stroke | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (!Array.isArray(o.points)) return null;
  const points: [number, number, number][] = [];
  for (const p of o.points) {
    if (!isPointTriple(p)) return null;
    points.push([p[0], p[1], typeof p[2] === 'number' ? p[2] : 0.5]);
  }
  if (points.length === 0) return null;
  return {
    id: o.id,
    seq: typeof o.seq === 'number' && Number.isFinite(o.seq) ? o.seq : 0,
    color: typeof o.color === 'string' && o.color ? o.color : '#ffffff',
    size: typeof o.size === 'number' && Number.isFinite(o.size) && o.size > 0 ? o.size : 0.02,
    points,
  };
}

/** Parse a full `strategy_canvas` row's strokes/deleted_ids jsonb. */
export function parseCanvasDoc(strokesRaw: unknown, deletedRaw: unknown): CanvasDoc {
  const strokes: Stroke[] = [];
  if (Array.isArray(strokesRaw)) {
    for (const s of strokesRaw) {
      const parsed = parseStroke(s);
      if (parsed) strokes.push(parsed);
    }
  }
  const deletedIds = Array.isArray(deletedRaw)
    ? deletedRaw.filter((d): d is string => typeof d === 'string')
    : [];
  return { strokes: sortBySeq(strokes), deletedIds };
}
