// src/dash/board/widgets/WidgetFrame.tsx
// The card every widget renders in (mockup 03): mono eyebrow header with the
// kind icon, a status aside, and the live body. The header moves the card; an
// unselected card's body also grabs it, a selected card's body scrolls and
// takes clicks (see BoardCanvas onPointerDown).
//
// Perf contract:
// - Memoized on the card's CONTENT (kind + config), not its geometry, so
//   dragging or resizing a card never re-renders its body. Bodies size with
//   CSS and never read x/y/w/h.
// - Zoomed far out the text is unreadable anyway, so cards render a light
//   summary instead of their live body (no hooks, no charts, cheap to mount).
import type { BoardEditor } from '@/dash/board/editor';
import { useBoard } from '@/dash/board/useBoard';
import { toggleWatch, watchedTeams } from '@/dash/board/widgets/actions';
import { WidgetInstanceProvider } from './interaction';
import { Settings2, Star } from 'lucide-react';
import { memo } from 'react';
import { useWidgetDetail } from './useWidgetDetail';
import { widgetDef } from '@/dash/board/widgets/registry';
import { useBoardData } from '@/dash/board/widgets/data';
import { useNow } from '@/dash/board/BoardTopBar';
import type { WidgetShape } from '@/dash/board/model';

/** Below this zoom, cards render their lightweight summary. */
export { LITE_ZOOM } from './useWidgetDetail';

function sameContent(a: { shape: WidgetShape; editor?: BoardEditor }, b: { shape: WidgetShape; editor?: BoardEditor }): boolean {
  return (
    a.editor === b.editor &&
    a.shape.id === b.shape.id &&
    a.shape.kind === b.shape.kind &&
    a.shape.config === b.shape.config &&
    a.shape.locked === b.shape.locked
  );
}

export const WidgetFrame = memo(function WidgetFrame({ shape, editor }: { shape: WidgetShape; editor?: BoardEditor }): JSX.Element {
  const def = widgetDef(shape.kind);
  const data = useBoardData();
  const now = useNow();
  const lite = useWidgetDetail(editor);
  if (!def) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-xl border border-border bg-card text-xs text-muted-foreground">
        Unknown widget
      </div>
    );
  }
  const Icon = def.icon;
  const Body = def.Body;
  const title = def.title(shape.config, data);
  const team = shape.kind === 'team' ? (shape.config.team === 'base' ? data.baseTeam : Number(shape.config.team)) : null;
  const face = (moving: boolean): JSX.Element => (
    <div
      data-widget-kind={moving ? undefined : shape.kind}
      data-widget-moving-face={moving ? '' : undefined}
      aria-hidden={moving || undefined}
      className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-[hsl(0_0%_22%)] bg-[hsl(0_0%_8%)] p-4 text-center text-foreground"
    >
      <Icon className="size-10 text-muted-foreground" aria-hidden />
      <span className="line-clamp-2 text-[28px] font-semibold leading-tight">{title}</span>
    </div>
  );
  if (lite) return face(false);
  return (
    <>
    {/* Shown instead of the live body while the camera moves (index.css). */}
    {face(true)}
    <div data-widget-kind={shape.kind} data-widget-full className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-[hsl(0_0%_22%)] bg-[hsl(0_0%_8%)] text-[13px] leading-snug text-foreground">
      <div data-board-handle title="Drag to move" className="flex min-h-[32px] shrink-0 cursor-grab items-center gap-1.5 border-b border-[hsl(0_0%_15%)] pl-2.5 pr-1 text-muted-foreground active:cursor-grabbing">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="eyebrow min-w-0 truncate !tracking-[0.12em]">{title}</span>
        <span className="ml-auto flex shrink-0 items-center">{def.aside?.(shape.config, data, now)}</span>
        {editor && team != null && Number.isInteger(team) && team > 0 && <TeamStar editor={editor} team={team} />}
        {editor && (
          <button
            data-board-interactive
            type="button"
            aria-label={`Settings for ${def.label}`}
            title="Settings"
            className="rounded-md p-1 hover:bg-white/10 hover:text-foreground"
            onClick={() => editor.setSelection([shape.id])}
          >
            <Settings2 className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <div data-board-interactive data-board-scroll className="min-h-0 flex-1 select-text overflow-auto overscroll-contain">
        <WidgetInstanceProvider value={shape}>
          <Body config={shape.config} />
        </WidgetInstanceProvider>
      </div>
    </div>
    </>
  );
}, sameContent);

function TeamStar({ editor, team }: { editor: BoardEditor; team: number }): JSX.Element {
  const watched = useBoard(editor, () => watchedTeams(editor).includes(team));
  return (
    <button
      type="button"
      data-board-interactive
      aria-label={watched ? `Unwatch ${team}` : `Watch ${team}`}
      aria-pressed={watched}
      title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
      onClick={() => toggleWatch(editor, team)}
      className="rounded-md p-1 text-warning hover:bg-white/10"
    >
      <Star className="size-3.5" fill={watched ? 'currentColor' : 'none'} aria-hidden />
    </button>
  );
}
