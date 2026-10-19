// src/dash/board/widgets/actions.ts
// Board-level widget commands shared by the inspector, spotlight and paste.
import type { BoardEditor } from '@/dash/board/editor';
import type { Point, WidgetShape } from '@/dash/board/model';
import { WIDGETS, type WidgetConfig, type WidgetKind } from '@/dash/board/widgets/registry';

export function insertWidget(editor: BoardEditor, kind: WidgetKind, config?: WidgetConfig, at?: Point): string {
  const def = WIDGETS[kind];
  const cfg = config ?? def.defaultConfig();
  return editor.insertWidget(kind, cfg, def.size(cfg), at);
}

/** Update a widget's config and grow/shrink it to fit when its kind sizes by content. */
export function updateWidgetConfig(editor: BoardEditor, shape: WidgetShape, config: WidgetConfig, resize = false): void {
  const def = WIDGETS[shape.kind as WidgetKind];
  const size = def && resize ? def.size(config) : null;
  editor.updateShape(shape.id, { config, ...(size ? { w: Math.max(shape.w, size.w), h: size.h } : {}) });
}

/** The canonical watchlist: the first watchlist widget on the board. */
export function findWatchlist(editor: BoardEditor): WidgetShape | null {
  for (const s of editor.order) if (s.type === 'widget' && s.kind === 'watchlist') return s;
  return null;
}

export function watchedTeams(editor: BoardEditor): number[] {
  const w = findWatchlist(editor);
  return Array.isArray(w?.config.teams) ? (w!.config.teams as number[]) : [];
}

/** Add or remove a team on the watchlist (creating the widget if needed). */
export function toggleWatch(editor: BoardEditor, team: number, on?: boolean): boolean {
  const w = findWatchlist(editor);
  const current = w && Array.isArray(w.config.teams) ? (w.config.teams as number[]) : [];
  const has = current.includes(team);
  const want = on ?? !has;
  if (want === has) return has;
  const teams = want ? [...current, team] : current.filter((t) => t !== team);
  if (w) {
    updateWidgetConfig(editor, w, { ...w.config, teams }, true);
  } else {
    const view = editor.viewPageRect();
    const def = WIDGETS.watchlist;
    const cfg = { teams };
    const size = def.size(cfg);
    editor.insertWidget('watchlist', cfg, size, { x: view.x + 80 + size.w / 2, y: view.y + 24 + size.h / 2 });
  }
  return want;
}
