import { useSyncExternalStore } from 'react';
import type { BoardEditor } from '../editor';

export const LITE_ZOOM = 0.42;

/** One timer/subscription per board, shared by every card. Expensive card
 * bodies stay stable during a pinch; hysteresis prevents threshold churn. */
function createDetailStore(editor: BoardEditor) {
  let lite = editor.camera.z < LITE_ZOOM;
  let camera = editor.camera;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const settle = (): void => {
    const next = editor.camera.z < (lite ? 0.48 : 0.38);
    if (next === lite) return;
    lite = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => lite,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!unsubscribe) {
        camera = editor.camera;
        settle();
        unsubscribe = editor.subscribe(() => {
          if (camera === editor.camera) return;
          camera = editor.camera;
          clearTimeout(timer);
          timer = setTimeout(settle, 160);
        });
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          unsubscribe?.();
          unsubscribe = undefined;
          clearTimeout(timer);
        }
      };
    },
  };
}
const stores = new WeakMap<BoardEditor, ReturnType<typeof createDetailStore>>();
const fullDetail = { subscribe: () => () => {}, getSnapshot: () => false };

export function useWidgetDetail(editor?: BoardEditor): boolean {
  let store = editor ? stores.get(editor) : fullDetail;
  if (!store && editor) {
    store = createDetailStore(editor);
    stores.set(editor, store);
  }
  return useSyncExternalStore(store!.subscribe, store!.getSnapshot);
}
