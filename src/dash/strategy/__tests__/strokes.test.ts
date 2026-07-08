// src/dash/strategy/__tests__/strokes.test.ts
// The whiteboard's pure model: doc merge (the client mirror of the
// upsert_strategy_canvas RPC), tombstone invariants, undo/redo reissue rules,
// eraser hit-testing, and wire parsing.
import { describe, it, expect } from 'vitest';
import {
  mergeCanvasDocs,
  whiteboardReducer,
  INITIAL_WHITEBOARD,
  newStrokeId,
  strokeHitTest,
  erasedIdsAt,
  parseCanvasDoc,
  parseStroke,
  docOf,
  canvasDocsEqual,
  EMPTY_DOC,
  type Stroke,
  type WhiteboardState,
} from '@/dash/strategy/strokes';

function stroke(id: string, seq: number, points?: [number, number, number][]): Stroke {
  return {
    id,
    seq,
    color: '#fff',
    size: 0.02,
    points: points ?? [
      [0.1, 0.1, 0.5],
      [0.2, 0.2, 0.5],
    ],
  };
}

describe('mergeCanvasDocs', () => {
  it('unions strokes by id with incoming winning per id', () => {
    const a = stroke('a', 1);
    const b = stroke('b', 2);
    const b2 = { ...stroke('b', 2), color: '#f00' };
    const merged = mergeCanvasDocs(
      { strokes: [a, b], deletedIds: [] },
      { strokes: [b2], deletedIds: [] },
    );
    expect(merged.strokes.map((s) => s.id)).toEqual(['a', 'b']);
    expect(merged.strokes.find((s) => s.id === 'b')?.color).toBe('#f00');
  });

  it('applies tombstones from BOTH sides and unions them', () => {
    const a = stroke('a', 1);
    const b = stroke('b', 2);
    const merged = mergeCanvasDocs(
      { strokes: [a, b], deletedIds: ['x'] },
      { strokes: [stroke('c', 3)], deletedIds: ['a'] },
    );
    expect(merged.strokes.map((s) => s.id)).toEqual(['b', 'c']);
    expect(new Set(merged.deletedIds)).toEqual(new Set(['x', 'a']));
  });

  it('a tombstoned id stays dead even if the other side re-sends the stroke', () => {
    const a = stroke('a', 1);
    const merged = mergeCanvasDocs(
      { strokes: [], deletedIds: ['a'] },
      { strokes: [a], deletedIds: [] },
    );
    expect(merged.strokes).toEqual([]);
  });

  it('orders merged strokes by seq (stable draw order across devices)', () => {
    const merged = mergeCanvasDocs(
      { strokes: [stroke('late', 30)], deletedIds: [] },
      { strokes: [stroke('early', 10), stroke('mid', 20)], deletedIds: [] },
    );
    expect(merged.strokes.map((s) => s.id)).toEqual(['early', 'mid', 'late']);
  });

  it('is convergent: merge(A,B) shows the same strokes as merge(B,A)', () => {
    const A = { strokes: [stroke('a', 1), stroke('b', 2)], deletedIds: ['z'] };
    const B = { strokes: [stroke('b', 2), stroke('c', 3)], deletedIds: ['a'] };
    const ab = mergeCanvasDocs(A, B);
    const ba = mergeCanvasDocs(B, A);
    expect(ab.strokes.map((s) => s.id)).toEqual(ba.strokes.map((s) => s.id));
    expect(new Set(ab.deletedIds)).toEqual(new Set(ba.deletedIds));
  });
});

describe('whiteboardReducer', () => {
  function addStroke(state: WhiteboardState, id: string, seq = 1): WhiteboardState {
    return whiteboardReducer(state, { type: 'add', stroke: stroke(id, seq) });
  }

  it('add pushes a stroke and an undo op, clearing redo', () => {
    const s1 = addStroke(INITIAL_WHITEBOARD, 'a');
    expect(s1.strokes.map((s) => s.id)).toEqual(['a']);
    expect(s1.undoStack.length).toBe(1);
    expect(s1.redoStack.length).toBe(0);
  });

  it('undo of add removes AND tombstones the stroke (remote devices see it gone)', () => {
    const s1 = addStroke(INITIAL_WHITEBOARD, 'a');
    const s2 = whiteboardReducer(s1, { type: 'undo' });
    expect(s2.strokes).toEqual([]);
    expect(s2.deletedIds).toContain('a');
  });

  it('redo of an undone add re-adds under a FRESH id (tombstoned ids stay dead)', () => {
    const s1 = addStroke(INITIAL_WHITEBOARD, 'a');
    const s2 = whiteboardReducer(s1, { type: 'undo' });
    const s3 = whiteboardReducer(s2, { type: 'redo' });
    expect(s3.strokes.length).toBe(1);
    expect(s3.strokes[0].id).not.toBe('a');
    expect(s3.deletedIds).toContain('a');
    // The re-added stroke keeps its ink.
    expect(s3.strokes[0].points).toEqual(stroke('a', 1).points);
  });

  it('erase removes + tombstones; undo of erase revives under fresh ids', () => {
    let st = addStroke(INITIAL_WHITEBOARD, 'a');
    st = addStroke(st, 'b', 2);
    st = whiteboardReducer(st, { type: 'erase', ids: ['a'] });
    expect(st.strokes.map((s) => s.id)).toEqual(['b']);
    expect(st.deletedIds).toContain('a');

    st = whiteboardReducer(st, { type: 'undo' });
    expect(st.strokes.length).toBe(2);
    expect(st.strokes.every((s) => s.id !== 'a')).toBe(true); // reissued
    // Redo erases the reissued stroke again.
    st = whiteboardReducer(st, { type: 'redo' });
    expect(st.strokes.map((s) => s.id)).toEqual(['b']);
  });

  it('clear tombstones everything as ONE undoable op', () => {
    let st = addStroke(INITIAL_WHITEBOARD, 'a');
    st = addStroke(st, 'b', 2);
    st = whiteboardReducer(st, { type: 'clear' });
    expect(st.strokes).toEqual([]);
    expect(new Set(st.deletedIds)).toEqual(new Set(['a', 'b']));
    st = whiteboardReducer(st, { type: 'undo' });
    expect(st.strokes.length).toBe(2);
  });

  it('hydrate merges a remote doc without touching unsaved local strokes or stacks', () => {
    let st = addStroke(INITIAL_WHITEBOARD, 'local');
    st = whiteboardReducer(st, {
      type: 'hydrate',
      doc: { strokes: [stroke('remote', 99)], deletedIds: [] },
    });
    expect(st.strokes.map((s) => s.id)).toEqual(['local', 'remote']);
    expect(st.undoStack.length).toBe(1); // local history intact
  });

  it('hydrate applies remote tombstones to local strokes', () => {
    let st = addStroke(INITIAL_WHITEBOARD, 'a');
    st = whiteboardReducer(st, {
      type: 'hydrate',
      doc: { strokes: [], deletedIds: ['a'] },
    });
    expect(st.strokes).toEqual([]);
  });

  it('undo/redo on empty stacks are no-ops', () => {
    expect(whiteboardReducer(INITIAL_WHITEBOARD, { type: 'undo' })).toBe(INITIAL_WHITEBOARD);
    expect(whiteboardReducer(INITIAL_WHITEBOARD, { type: 'redo' })).toBe(INITIAL_WHITEBOARD);
  });
});

describe('strokeHitTest / erasedIdsAt', () => {
  const horizontal = stroke('h', 1, [
    [0.2, 0.5, 0.5],
    [0.4, 0.5, 0.5],
  ]);

  it('hits a point on the stroke', () => {
    expect(strokeHitTest(horizontal, 0.3, 0.5, 0.02)).toBe(true);
  });

  it('misses a point far from the stroke', () => {
    expect(strokeHitTest(horizontal, 0.3, 0.9, 0.02)).toBe(false);
  });

  it('accounts for the field aspect: x-distance is wider than it looks in [0,1]', () => {
    // 0.02 in x-units is ~0.05 of field height (aspect ≈ 2.46) — outside a 0.03
    // radius once the stroke half-width is small.
    const thin = { ...horizontal, size: 0.001 };
    expect(strokeHitTest(thin, 0.44, 0.5, 0.03)).toBe(false);
    // The same offset in y IS within radius+halfwidth of the endpoint.
    expect(strokeHitTest(thin, 0.4, 0.52, 0.03)).toBe(true);
  });

  it('erasedIdsAt returns every stroke under the touch', () => {
    const other = stroke('v', 2, [
      [0.3, 0.4, 0.5],
      [0.3, 0.6, 0.5],
    ]);
    const ids = erasedIdsAt([horizontal, other], 0.3, 0.5, 0.03);
    expect(new Set(ids)).toEqual(new Set(['h', 'v']));
  });
});

describe('wire parsing', () => {
  it('parses a valid row and drops malformed strokes', () => {
    const doc = parseCanvasDoc(
      [
        { id: 'ok', seq: 2, color: '#f00', size: 0.02, points: [[0.1, 0.2, 0.5], [0.3, 0.4, 0.5]] },
        { id: 'bad-points', seq: 1, color: '#f00', size: 0.02, points: [['x', 0.2]] },
        { seq: 1, color: '#f00', size: 0.02, points: [[0.1, 0.2, 0.5]] }, // no id
        null,
      ],
      ['dead', 42],
    );
    expect(doc.strokes.map((s) => s.id)).toEqual(['ok']);
    expect(doc.deletedIds).toEqual(['dead']); // non-strings dropped
  });

  it('defaults missing pressure to 0.5 and tolerates junk jsonb', () => {
    const s = parseStroke({ id: 'p', points: [[0.1, 0.2]] });
    expect(s?.points[0][2]).toBe(0.5);
    expect(parseCanvasDoc('junk', null)).toEqual(EMPTY_DOC);
  });
});

describe('doc helpers', () => {
  it('canvasDocsEqual compares visible strokes + tombstones', () => {
    const a = { strokes: [stroke('a', 1)], deletedIds: ['x'] };
    expect(canvasDocsEqual(a, { strokes: [stroke('a', 1)], deletedIds: ['x'] })).toBe(true);
    expect(canvasDocsEqual(a, { strokes: [], deletedIds: ['x'] })).toBe(false);
    expect(canvasDocsEqual(a, { strokes: [stroke('a', 1)], deletedIds: [] })).toBe(false);
  });

  it('newStrokeId is unique across rapid calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newStrokeId()));
    expect(ids.size).toBe(200);
  });

  it('docOf projects reducer state to the persisted doc shape', () => {
    const st = whiteboardReducer(INITIAL_WHITEBOARD, { type: 'add', stroke: stroke('a', 1) });
    expect(docOf(st)).toEqual({ strokes: st.strokes, deletedIds: [] });
  });
});
