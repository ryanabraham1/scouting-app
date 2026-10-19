import { describe, expect, it } from 'vitest';
import { BoardEditor } from '../editor';
import { parseRecord } from '../model';
import { exportBounds } from '../exportPng';
import { dropTeamsOnCompare } from '../widgets/actions';

function editor(): BoardEditor {
  const e = new BoardEditor({ clientId: 'completion' });
  e.setViewport(1000, 800);
  return e;
}

describe('board completion', () => {
  it('comments round-trip, resolve, undo and remotely merge like other records', () => {
    const e = editor();
    const id = e.insertComment({ x: 20, y: 30 });
    e.updateShape(id, { thread: [{ id: 'm1', author: 'Ryan', text: 'Feed lane', at: 10 }], resolved: true });
    const record = parseRecord(JSON.parse(JSON.stringify(e.shapes.get(id))));
    expect(record).toMatchObject({ type: 'comment' });
    const peer = editor();
    if (record) peer.applyRemote([record]);
    expect(peer.shapes.get(id)).toEqual(e.shapes.get(id));
    e.undo();
    expect(e.shapes.get(id)).toMatchObject({ resolved: false, thread: [] });
    e.redo();
    expect(e.shapes.get(id)).toMatchObject({ resolved: true });
    expect(parseRecord({ ...record, thread: [null] })).toBeNull();
  });

  it('retains tombstone revisions across reload and blocks stale resurrection', () => {
    const e = editor();
    const id = e.insertComment({ x: 10, y: 10 });
    const original = e.shapes.get(id)!;
    const deleted = { id, deleted: true as const, rev: original.rev + 10000, by: 'remote' };
    e.applyRemote([deleted]);
    e.applyRemote([original]);
    expect(e.shapes.has(id)).toBe(false);
    const reloaded = editor();
    reloaded.load([deleted]);
    reloaded.applyRemote([original]);
    expect(reloaded.shapes.has(id)).toBe(false);
    reloaded.commit([original]);
    expect(reloaded.shapes.get(id)!.rev).toBeGreaterThan(deleted.rev);
  });

  it('PNG bounds include all offscreen items, or only the selection', () => {
    const e = editor();
    const a = e.insertComment({ x: -200, y: -100 });
    e.insertComment({ x: 3000, y: 2000 });
    e.setSelection([]);
    expect(exportBounds(e)).toEqual({ x: -224, y: -124, w: 3280, h: 2180 });
    e.setSelection([a]);
    expect(exportBounds(e)).toEqual({ x: -224, y: -124, w: 80, h: 80 });
  });

  it('a team dropped onto a comparison is added once and can be undone', () => {
    const e = editor();
    const comparison = e.insertWidget('compare', { teams: [254] }, { w: 380, h: 200 }, { x: 500, y: 300 });
    const team = e.insertWidget('team', { team: 'base' }, { w: 200, h: 200 });
    dropTeamsOnCompare(e, [team], { x: 500, y: 300 }, 3256);
    expect(e.shapes.get(comparison)).toMatchObject({ config: { teams: [254, 3256] } });
    dropTeamsOnCompare(e, [team], { x: 500, y: 300 }, 3256);
    e.undo();
    expect(e.shapes.get(comparison)).toMatchObject({ config: { teams: [254] } });
  });
});
