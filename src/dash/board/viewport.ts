import type { BoardEditor } from './editor';
import { rectContains, rectsIntersect, type Rect, type Shape } from './model';

/** Touch-first device (iPad): smaller DOM buffers, lighter cards in motion. */
export function prefersTouchRendering(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/** Keep mounted cards stable while navigating inside a buffered area. A camera
 * tick is O(1); rescan shapes only when the view exits that area or data changes.
 * Ink is painted by InkLayer, so it is left out of the DOM set (except export). */
export function visibleShapesSnapshot(editor: BoardEditor, all = false, touch = false): () => readonly Shape[] {
  let order: readonly Shape[] | null = null;
  let viewport = editor.viewport;
  let covered: Rect | null = null;
  let visible: readonly Shape[] = [];
  // Fractions of the view added on each side. A tablet's compositor pays for
  // every mounted pixel on each pinch frame, so it buffers far less.
  const inner = touch ? 0.1 : 0.25;
  const outer = touch ? 0.25 : 0.5;
  return () => {
    if (all || !editor.viewport.w) return editor.order;
    const view = editor.viewPageRect();
    if (order === editor.order && viewport === editor.viewport && covered && rectContains(covered, view)) return visible;
    order = editor.order;
    viewport = editor.viewport;
    // An inner safe area plus an outer render buffer prevents mount/unmount
    // thrashing at the viewport's edge while keeping offscreen widgets asleep.
    covered = { x: view.x - view.w * inner, y: view.y - view.h * inner, w: view.w * (1 + inner * 2), h: view.h * (1 + inner * 2) };
    const render = { x: view.x - view.w * outer, y: view.y - view.h * outer, w: view.w * (1 + outer * 2), h: view.h * (1 + outer * 2) };
    const next = order.filter((s) => s.type !== 'ink' && rectsIntersect(render, s));
    if (next.length !== visible.length || next.some((s, i) => s !== visible[i])) visible = next;
    return visible;
  };
}
