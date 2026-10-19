// src/dash/board/useBoard.ts
// React binding for BoardEditor. The editor swaps objects immutably on change
// (shapes Map, order array, camera, selection Set), so a selector returning one
// of those is referentially stable between changes and re-renders only when
// its slice actually changes.
import { useSyncExternalStore } from 'react';
import type { BoardEditor } from '@/dash/board/editor';

export function useBoard<T>(editor: BoardEditor, selector: (e: BoardEditor) => T): T {
  return useSyncExternalStore(editor.subscribe, () => selector(editor));
}
