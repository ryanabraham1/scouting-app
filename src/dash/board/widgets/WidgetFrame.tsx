// src/dash/board/widgets/WidgetFrame.tsx
// The card every widget renders in (mockup 03): mono eyebrow header with the
// kind icon, a status aside, and the live body. Purely presentational; the
// whole card is the drag handle in select mode (input goes to the editor).
import { memo } from 'react';
import { widgetDef } from '@/dash/board/widgets/registry';
import { useBoardData } from '@/dash/board/widgets/data';
import { useNow } from '@/dash/board/BoardTopBar';
import type { WidgetShape } from '@/dash/board/model';

export const WidgetFrame = memo(function WidgetFrame({ shape }: { shape: WidgetShape }): JSX.Element {
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
    <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-[hsl(0_0%_22%)] bg-[hsl(0_0%_8%)] text-[13px] leading-snug text-foreground">
      <div className="flex min-h-[30px] shrink-0 items-center gap-1.5 border-b border-[hsl(0_0%_15%)] px-2.5 text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="eyebrow min-w-0 truncate !tracking-[0.12em]">{def.title(shape.config, data)}</span>
        <span className="ml-auto flex shrink-0 items-center">{def.aside?.(shape.config, data, now)}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Body config={shape.config} />
      </div>
    </div>
  );
});
