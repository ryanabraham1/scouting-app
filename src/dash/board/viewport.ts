import type { BoardEditor } from './editor';
import { rectContains, rectsIntersect, type Rect, type Shape } from './model';

/** Keep mounted cards stable while navigating inside a buffered area. A camera
 * tick is O(1); rescan shapes only when the view exits that area or data changes. */
export function visibleShapesSnapshot(editor: BoardEditor, all = false): () => readonly Shape[] {
  let order: readonly Shape[] | null = null;
  let viewport = editor.viewport;
  let covered: Rect | null = null;
  let visible: readonly Shape[] = [];
  return () => {
    if (all || !editor.viewport.w) return editor.order;
    const view = editor.viewPageRect();
    if (order === editor.order && viewport === editor.viewport && covered && rectContains(covered, view)) return visible;
    order = editor.order;
    viewport = editor.viewport;
    // An inner safe area plus an outer render buffer prevents mount/unmount
    // thrashing at the viewport's edge while keeping offscreen widgets asleep.
    covered = { x: view.x - view.w * 0.25, y: view.y - view.h * 0.25, w: view.w * 1.5, h: view.h * 1.5 };
    const render = { x: view.x - view.w * 0.5, y: view.y - view.h * 0.5, w: view.w * 2, h: view.h * 2 };
    const next = order.filter((s) => rectsIntersect(render, s));
    if (next.length !== visible.length || next.some((s, i) => s !== visible[i])) visible = next;
    return visible;
  };
}
