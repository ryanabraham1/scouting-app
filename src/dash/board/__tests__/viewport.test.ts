import { describe, expect, it } from 'vitest';
import { BoardEditor } from '../editor';
import { visibleShapesSnapshot } from '../viewport';

function setup() {
  const editor = new BoardEditor({ clientId: 'viewport' });
  editor.setViewport(1000, 800);
  editor.insertWidget('team', { team: 254 }, { w: 320, h: 290 }, { x: 300, y: 300 });
  editor.insertWidget('team', { team: 3256 }, { w: 320, h: 290 }, { x: 10000, y: 300 });
  return editor;
}
describe('buffered viewport rendering', () => {
  it('keeps the same mounted snapshot throughout small pans and zooms', () => {
    const editor = setup();
    const snapshot = visibleShapesSnapshot(editor);
    const initial = snapshot();
    expect(initial).toHaveLength(1);
    for (let i = 0; i < 120; i += 1) {
      editor.setCamera({ x: Math.sin(i / 10) * 100, y: Math.cos(i / 10) * 100, z: 1 + Math.sin(i / 20) * 0.05 });
      expect(snapshot()).toBe(initial);
    }
  });
  it('mounts newly visible content after a long pan, and refreshes edited records', () => {
    const editor = setup();
    const snapshot = visibleShapesSnapshot(editor);
    snapshot();
    editor.setCamera({ x: -9500, y: 0, z: 1 });
    const moved = snapshot();
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ config: { team: 3256 } });
    editor.updateShape(moved[0].id, { config: { team: 971 } });
    expect(snapshot()[0]).toMatchObject({ config: { team: 971 } });
  });
  it('export bypasses viewport culling', () => {
    const editor = setup();
    expect(visibleShapesSnapshot(editor, true)()).toBe(editor.order);
  });
  it('leaves ink to the canvas layer, except for export', () => {
    const editor = setup();
    editor.setTool('pen');
    const p = (sx: number, sy: number) => ({ sx, sy, pointerId: 1, pointerType: 'mouse', pressure: 0.5, button: 0, shift: false, alt: false, meta: false });
    editor.pointerDown(p(100, 100));
    editor.pointerMove(p(160, 140));
    editor.pointerUp(p(160, 140));
    expect(editor.order.some((s) => s.type === 'ink')).toBe(true);
    expect(visibleShapesSnapshot(editor)().some((s) => s.type === 'ink')).toBe(false);
    expect(visibleShapesSnapshot(editor, true)().some((s) => s.type === 'ink')).toBe(true);
  });
  it('mounts a smaller buffer on touch devices', () => {
    const editor = new BoardEditor({ clientId: 'viewport' });
    editor.setViewport(1000, 800);
    // 1.35 view widths right of the origin: inside the desktop buffer (1.5), outside touch (1.25).
    editor.insertWidget('team', { team: 254 }, { w: 100, h: 100 }, { x: 1000 * 1.35 + 50, y: 400 });
    editor.setCamera({ x: 0, y: 0, z: 1 });
    expect(visibleShapesSnapshot(editor)()).toHaveLength(1);
    expect(visibleShapesSnapshot(editor, false, true)()).toHaveLength(0);
  });
});
