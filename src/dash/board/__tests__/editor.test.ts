import { describe, it, expect, beforeEach } from 'vitest';
import { BoardEditor, type PointerInfo } from '../editor';
import { parseRecord, recordWins, type Shape } from '../model';

function ptr(sx: number, sy: number, over: Partial<PointerInfo> = {}): PointerInfo {
  return {
    sx,
    sy,
    pointerId: 1,
    pointerType: 'mouse',
    pressure: 0.5,
    button: 0,
    shift: false,
    alt: false,
    meta: false,
    ...over,
  };
}

function drag(ed: BoardEditor, from: [number, number], to: [number, number], over: Partial<PointerInfo> = {}): void {
  ed.pointerDown(ptr(from[0], from[1], over));
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    ed.pointerMove(ptr(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, over));
  }
  ed.pointerUp(ptr(to[0], to[1], over));
}

let ed: BoardEditor;

beforeEach(() => {
  ed = new BoardEditor({ clientId: 'test-client' });
  ed.setViewport(1000, 800);
});

describe('BoardEditor drawing', () => {
  it('a pen drag creates one ink shape with box-relative points', () => {
    ed.setTool('pen');
    drag(ed, [100, 100], [300, 200]);
    const shapes = [...ed.shapes.values()];
    expect(shapes).toHaveLength(1);
    const ink = shapes[0];
    expect(ink.type).toBe('ink');
    if (ink.type !== 'ink') return;
    expect(ink.points.length).toBeGreaterThan(2);
    // Every point sits inside the shape box.
    for (const [x, y] of ink.points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(ink.w);
      expect(y).toBeLessThanOrEqual(ink.h);
    }
    expect(ink.rev).toBeGreaterThan(0);
    expect(ink.by).toBe('test-client');
  });

  it('respects the camera when converting pointer to page coords', () => {
    ed.setCamera({ x: 100, y: 50, z: 2 });
    ed.setTool('pen');
    drag(ed, [100, 50], [140, 50]);
    const ink = [...ed.shapes.values()][0];
    expect(ink.x).toBeLessThan(1);
    expect(ink.x + ink.w).toBeGreaterThan(19);
  });

  it('highlighter strokes are flagged and use the highlighter color', () => {
    ed.setTool('highlighter');
    drag(ed, [0, 0], [100, 0]);
    const ink = [...ed.shapes.values()][0];
    expect(ink.type === 'ink' && ink.highlighter).toBe(true);
    expect(ink.type === 'ink' && ink.color).toBe('yellow');
  });

  it('the eraser removes crossed ink in one undo step', () => {
    ed.setTool('pen');
    drag(ed, [100, 100], [300, 100]);
    drag(ed, [100, 400], [300, 400]);
    expect(ed.shapes.size).toBe(2);
    ed.setTool('eraser');
    drag(ed, [200, 50], [200, 150]);
    expect(ed.shapes.size).toBe(1);
    ed.undo();
    expect(ed.shapes.size).toBe(2);
  });
});

describe('BoardEditor select, move, resize', () => {
  function addInk(): Shape {
    ed.setTool('pen');
    drag(ed, [100, 100], [200, 200]);
    ed.setTool('select');
    return [...ed.shapes.values()][0];
  }

  it('dragging a shape moves it and undo restores the original position', () => {
    const ink = addInk();
    drag(ed, [150, 150], [250, 180]);
    const moved = ed.shapes.get(ink.id)!;
    expect(moved.x).toBeCloseTo(ink.x + 100, 5);
    expect(moved.y).toBeCloseTo(ink.y + 30, 5);
    ed.undo();
    expect(ed.shapes.get(ink.id)!.x).toBeCloseTo(ink.x, 5);
    ed.redo();
    expect(ed.shapes.get(ink.id)!.x).toBeCloseTo(ink.x + 100, 5);
  });

  it('alt-drag duplicates instead of moving', () => {
    const ink = addInk();
    drag(ed, [150, 150], [400, 150], { alt: true });
    expect(ed.shapes.size).toBe(2);
    expect(ed.shapes.get(ink.id)!.x).toBeCloseTo(ink.x, 5);
    ed.undo();
    expect(ed.shapes.size).toBe(1);
  });

  it('marquee selects touched shapes', () => {
    const ink = addInk();
    drag(ed, [50, 50], [160, 160]);
    expect([...ed.selection]).toEqual([ink.id]);
  });

  it('resizing from the se handle scales the shape', () => {
    const ink = addInk();
    ed.setSelection([ink.id]);
    const b = ed.selectionBounds()!;
    const se = ed.pageToScreen(b.x + b.w, b.y + b.h);
    drag(ed, [se.x, se.y], [se.x + b.w, se.y + b.h]);
    const s = ed.shapes.get(ink.id)!;
    expect(s.w).toBeCloseTo(b.w * 2, 1);
    expect(s.h).toBeCloseTo(b.h * 2, 1);
  });

  it('locked shapes are not moved or deleted', () => {
    const ink = addInk();
    ed.setSelection([ink.id]);
    ed.toggleLock();
    drag(ed, [150, 150], [300, 300]);
    expect(ed.shapes.get(ink.id)!.x).toBeCloseTo(ink.x, 5);
    ed.setSelection([ink.id]);
    ed.deleteSelection();
    expect(ed.shapes.has(ink.id)).toBe(true);
  });
});

describe('BoardEditor text', () => {
  it('a text click creates a draft that only enters history once it has text', () => {
    ed.setTool('text');
    ed.pointerDown(ptr(100, 100));
    const id = ed.editingId!;
    expect(id).toBeTruthy();
    ed.commitText(id, 'Watch 1678 climb');
    expect(ed.shapes.get(id)?.type).toBe('text');
    ed.undo();
    expect(ed.shapes.has(id)).toBe(false);
  });

  it('an empty draft disappears without an undo step or change event', () => {
    const changes: number[] = [];
    ed.onChange((c) => changes.push(c.puts.length + c.tombstones.length));
    ed.setTool('text');
    ed.pointerDown(ptr(100, 100));
    ed.commitText(ed.editingId!, '   ');
    expect(ed.shapes.size).toBe(0);
    expect(ed.canUndo).toBe(false);
    expect(changes).toHaveLength(0);
  });
});

describe('BoardEditor sync hooks', () => {
  it('emits local changes with stamped revs and tombstones on delete', () => {
    const events: { puts: number; tombs: number; source: string }[] = [];
    ed.onChange((c) => events.push({ puts: c.puts.length, tombs: c.tombstones.length, source: c.source }));
    ed.setTool('pen');
    drag(ed, [0, 0], [50, 50]);
    ed.selectAll();
    ed.deleteSelection();
    expect(events).toEqual([
      { puts: 1, tombs: 0, source: 'local' },
      { puts: 0, tombs: 1, source: 'local' },
    ]);
  });

  it('applyRemote keeps the newer record and ignores stale ones', () => {
    ed.setTool('pen');
    drag(ed, [0, 0], [50, 50]);
    const local = [...ed.shapes.values()][0];
    ed.applyRemote([{ ...local, x: 999, rev: local.rev - 1, by: 'zzz' }]);
    expect(ed.shapes.get(local.id)!.x).toBe(local.x);
    ed.applyRemote([{ ...local, x: 999, rev: local.rev + 1, by: 'other' }]);
    expect(ed.shapes.get(local.id)!.x).toBe(999);
    ed.applyRemote([{ id: local.id, deleted: true, rev: local.rev + 2, by: 'other' }]);
    expect(ed.shapes.has(local.id)).toBe(false);
  });

  it('copy then paste creates new ids centered at the target', () => {
    ed.setTool('pen');
    drag(ed, [0, 0], [50, 50]);
    ed.selectAll();
    const json = ed.copySelection();
    expect(ed.pasteShapes(json, { x: 500, y: 500 })).toBe(true);
    expect(ed.shapes.size).toBe(2);
    const pasted = ed.selectedShapes()[0];
    expect(pasted.x + pasted.w / 2).toBeCloseTo(500, 5);
  });
});

describe('model merge helpers', () => {
  it('recordWins orders by rev then client id', () => {
    expect(recordWins({ rev: 2, by: 'a' }, { rev: 1, by: 'z' })).toBe(true);
    expect(recordWins({ rev: 1, by: 'b' }, { rev: 1, by: 'a' })).toBe(true);
    expect(recordWins({ rev: 1, by: 'a' }, { rev: 1, by: 'b' })).toBe(false);
  });

  it('parseRecord drops removed legacy shape types', () => {
    expect(parseRecord({ id: 'x', rev: 1, by: 'a', type: 'sticky', x: 0, y: 0, w: 1, h: 1, z: 0 })).toBeNull();
    expect(parseRecord({ id: 'x', rev: 1, by: 'a', deleted: true })).toEqual({ id: 'x', rev: 1, by: 'a', deleted: true });
  });
});
