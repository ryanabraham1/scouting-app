// src/dash/board/widgets/WidgetTray.tsx
// "Add widget" popover (mockup 03, bottom right): every widget kind; click
// inserts at the view center with its default config, then the inspector
// opens on the new (selected) widget.
import { cn } from '@/lib/utils';
import type { BoardEditor } from '@/dash/board/editor';
import { PANEL } from '@/dash/board/BoardChrome';
import { WIDGETS, WIDGET_KINDS } from '@/dash/board/widgets/registry';
import { insertWidget } from '@/dash/board/widgets/actions';

export function WidgetTray({ editor, onClose, onOpenSearch }: { editor: BoardEditor; onClose: () => void; onOpenSearch?: () => void }): JSX.Element {
  return (
    <div className={cn(PANEL, 'max-h-[min(75dvh,560px)] w-[300px] overflow-y-auto p-2.5')} role="dialog" aria-label="Add widget">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="eyebrow">Add widget</span>
        {onOpenSearch && (
          <button type="button" onClick={onOpenSearch} className="tnum rounded border border-[hsl(0_0%_22%)] px-1 text-[10.5px] text-muted-foreground hover:text-foreground">
            ⌘K to search
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {WIDGET_KINDS.map((k) => {
          const def = WIDGETS[k];
          const Icon = def.icon;
          return (
            <button
              key={k}
              type="button"
              onClick={() => {
                insertWidget(editor, k);
                onClose();
              }}
              className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2 py-2 text-left text-xs text-foreground hover:bg-white/10"
            >
              <Icon className="size-4 text-muted-foreground" aria-hidden />
              {def.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
