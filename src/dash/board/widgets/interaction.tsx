import { createContext, useContext, type ReactNode } from 'react';
import type { BoardEditor } from '../editor';
import type { WidgetShape } from '../model';
import { insertWidget, updateWidgetConfig } from './actions';
import { WIDGETS, type WidgetConfig, type WidgetKind } from './registry';
import { WIDGET_DRAG_TYPE } from './drag';

const Actions = createContext<BoardEditor | null>(null);
const Instance = createContext<WidgetShape | null>(null);
export function WidgetActionsProvider({ editor, children }: { editor: BoardEditor; children: ReactNode }): JSX.Element {
  return <Actions.Provider value={editor}>{children}</Actions.Provider>;
}
export const WidgetInstanceProvider = Instance.Provider;
export function useWidgetConfig(): (patch: WidgetConfig) => void {
  const editor = useContext(Actions);
  const shape = useContext(Instance);
  return (patch) => {
    if (!editor || !shape) return;
    const current = editor.shapes.get(shape.id);
    if (current?.type === 'widget') updateWidgetConfig(editor, current, { ...current.config, ...patch });
  };
}

/** Every linked row works with a click, a mouse drag or a touch long-press. */
export function WidgetLink({ kind, config, children, label, className = '' }: {
  kind: WidgetKind; config: WidgetConfig; children: ReactNode; label: string; className?: string;
}): JSX.Element {
  const editor = useContext(Actions);
  const source = useContext(Instance);
  return <button type="button" draggable={!!editor} aria-label={label} title={`${label} · drag to place`} className={`min-h-7 cursor-pointer rounded text-left hover:bg-white/10 focus-visible:outline focus-visible:outline-brand ${className}`}
    onPointerDown={(e) => e.stopPropagation()}
    onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(WIDGET_DRAG_TYPE, JSON.stringify({ kind, config })); e.dataTransfer.effectAllowed = 'copy'; }}
    onClick={(e) => {
      e.stopPropagation();
      if (!editor) return;
      const size = WIDGETS[kind].size(config);
      // The card memoizes on content, so read its LIVE position from the editor.
      const from = source ? editor.shapes.get(source.id) ?? source : null;
      const at = from ? { x: from.x + from.w + 24 + size.w / 2, y: from.y + size.h / 2 } : undefined;
      insertWidget(editor, kind, config, at);
      const selected = editor.shapes.get([...editor.selection][0]);
      if (selected) editor.zoomToRect(selected, Math.min(1, editor.camera.z));
    }}>{children}</button>;
}
