// src/dash/board/widgets/WidgetFrame.tsx
// The card every widget renders in (mockup 03): mono eyebrow header with the
// kind icon, a status aside, and the live body. Purely presentational; the
// header moves the card; its body scrolls and supports linked data, native
// drag-out rows and controls directly in select mode.
import type { BoardEditor } from '@/dash/board/editor';
import { useBoard } from '@/dash/board/useBoard';
import { toggleWatch, watchedTeams } from '@/dash/board/widgets/actions';
import { WidgetInstanceProvider } from './interaction';
import { Settings2, Star } from 'lucide-react';
import { memo } from 'react';
import { widgetDef } from '@/dash/board/widgets/registry';
import { useBoardData } from '@/dash/board/widgets/data';
import { useNow } from '@/dash/board/BoardTopBar';
import type { WidgetShape } from '@/dash/board/model';

export const WidgetFrame = memo(function WidgetFrame({ shape, editor }: { shape: WidgetShape; editor?: BoardEditor }): JSX.Element {
  const def = widgetDef(shape.kind);
  const data = useBoardData();
  const now = useNow();
  if (!def) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-xl border border-border bg-card text-xs text-muted-foreground">
        Unknown widget
      </div>
    );
  }
  const Icon = def.icon;
  const Body = def.Body;
  return (
    <div data-widget-kind={shape.kind} className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-[hsl(0_0%_22%)] bg-[hsl(0_0%_8%)] text-[13px] leading-snug text-foreground">
      <div data-board-handle title="Drag this header to move the card" className="flex min-h-[30px] cursor-grab shrink-0 items-center gap-1.5 border-b border-[hsl(0_0%_15%)] px-2.5 text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="eyebrow min-w-0 truncate !tracking-[0.12em]">{def.title(shape.config, data)}</span>
        <span className="ml-auto flex shrink-0 items-center">{def.aside?.(shape.config, data, now)}</span>
        {editor && <button data-board-interactive type="button" aria-label={`Settings for ${def.label}`} className="rounded p-1 hover:bg-white/10" onClick={() => editor.setSelection([shape.id])}><Settings2 className="size-3.5" /></button>}
      </div>
      {shape.kind === 'team' && editor && <TeamStar editor={editor} team={shape.config.team === 'base' ? data.baseTeam : Number(shape.config.team)} />}
      <div data-board-interactive data-board-scroll className="min-h-0 flex-1 select-text overflow-auto">
        <WidgetInstanceProvider value={shape}><Body config={shape.config} /></WidgetInstanceProvider>
      </div>
    </div>
  );
});

function TeamStar({ editor, team }: { editor: BoardEditor; team: number }): JSX.Element | null {
  useBoard(editor, (e) => e.order);
  if (!Number.isInteger(team) || team <= 0) return null;
  const watched = watchedTeams(editor).includes(team);
  return <button type="button" aria-label={watched ? `Unwatch ${team}` : `Watch ${team}`} aria-pressed={watched} title="Toggle watchlist" onClick={() => toggleWatch(editor, team)} data-board-interactive className="absolute right-2 top-9 z-10 rounded p-1 text-warning"><Star className="size-3.5" fill={watched ? 'currentColor' : 'none'} /></button>;
}
