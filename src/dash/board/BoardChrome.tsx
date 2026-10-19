// src/dash/board/BoardChrome.tsx
// Floating board chrome (mockup 01): the vertical tool panel, the style panel
// (colors, sizes, text alignment) and the undo/zoom strip. Flat panels with a
// hairline border, brand-tinted active state.
import type { ReactNode } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Eraser,
  Hand,
  Highlighter,
  ImagePlus,
  LayoutGrid,
  Minus,
  MousePointer2,
  Pen,
  Plus,
  Pointer,
  Redo2,
  Scan,
  Type,
  Undo2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBoard } from '@/dash/board/useBoard';
import type { BoardEditor, Tool } from '@/dash/board/editor';
import { COLORS, COLOR_NAMES, SIZE_NAMES, type ColorName } from '@/dash/board/model';

export const PANEL =
  'rounded-xl border border-[hsl(0_0%_20%)] bg-[hsl(0_0%_8%)] text-[hsl(0_0%_70%)] shadow-[0_8px_24px_rgba(0,0,0,0.35)]';

function ToolButton({
  active,
  label,
  onClick,
  children,
  large,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
  large: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center rounded-lg transition-colors',
        large ? 'size-11' : 'size-[34px]',
        active ? 'bg-brand/15 text-brand' : 'hover:bg-white/5 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

const TOOLS: { tool: Tool; label: string; key: string; icon: typeof Pen }[] = [
  { tool: 'select', label: 'Select', key: 'V', icon: MousePointer2 },
  { tool: 'hand', label: 'Hand', key: 'H', icon: Hand },
  { tool: 'pen', label: 'Pen', key: 'P', icon: Pen },
  { tool: 'highlighter', label: 'Highlighter', key: 'M', icon: Highlighter },
  { tool: 'eraser', label: 'Eraser', key: 'E', icon: Eraser },
  { tool: 'text', label: 'Text', key: 'T', icon: Type },
  { tool: 'laser', label: 'Laser pointer', key: 'K', icon: Pointer },
];

export function Toolbar({
  editor,
  large,
  onPickImage,
  onOpenWidgets,
}: {
  editor: BoardEditor;
  large: boolean;
  onPickImage: () => void;
  onOpenWidgets?: () => void;
}): JSX.Element {
  const tool = useBoard(editor, (e) => e.tool);
  const icon = large ? 'size-5' : 'size-4';
  return (
    <div className={cn(PANEL, 'flex flex-col gap-0.5 p-[5px]')} role="toolbar" aria-orientation="vertical" aria-label="Board tools">
      {TOOLS.map(({ tool: t, label, key, icon: Icon }, i) => (
        <div key={t} className="contents">
          {i === 2 && <div className="mx-1.5 my-0.5 h-px bg-[hsl(0_0%_18%)]" />}
          <ToolButton active={tool === t} label={`${label} (${key})`} onClick={() => editor.setTool(t)} large={large}>
            <Icon className={icon} aria-hidden />
          </ToolButton>
        </div>
      ))}
      <div className="mx-1.5 my-0.5 h-px bg-[hsl(0_0%_18%)]" />
      <ToolButton label="Insert image" onClick={onPickImage} large={large}>
        <ImagePlus className={icon} aria-hidden />
      </ToolButton>
      {onOpenWidgets && (
        <ToolButton label="Add widget" onClick={onOpenWidgets} large={large}>
          <LayoutGrid className={icon} aria-hidden />
        </ToolButton>
      )}
    </div>
  );
}

export function StylePanel({ editor }: { editor: BoardEditor }): JSX.Element | null {
  const tool = useBoard(editor, (e) => e.tool);
  const style = useBoard(editor, (e) => e.style);
  const selection = useBoard(editor, (e) => e.selection);
  const shapes = useBoard(editor, (e) => e.shapes);
  const sel = [...selection].map((id) => shapes.get(id)).filter((s) => s != null);
  const styleable = sel.filter((s) => s.type === 'ink' || s.type === 'text');
  const drawingTool = tool === 'pen' || tool === 'highlighter' || tool === 'text';
  if (!drawingTool && styleable.length === 0) return null;

  // What the panel shows: the selection's style when one is selected, else the tool's.
  const first = styleable[0];
  const isHighlighter =
    tool === 'highlighter' || (first?.type === 'ink' && !!first.highlighter && !drawingTool);
  const color: ColorName =
    first && !drawingTool ? first.color : isHighlighter ? style.highlighterColor : style.color;
  const size = first && !drawingTool ? first.size : style.size;
  const showAlign = tool === 'text' || styleable.some((s) => s.type === 'text');
  const align = first?.type === 'text' && !drawingTool ? first.align : style.align;

  return (
    <div className={cn(PANEL, 'w-[172px] p-2.5')} aria-label="Style">
      <div className="grid grid-cols-5 gap-1.5">
        {COLOR_NAMES.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Color ${c}`}
            aria-pressed={color === c}
            onClick={() => editor.setStyle(isHighlighter ? { highlighterColor: c } : { color: c })}
            className={cn(
              'size-6 rounded-full transition-transform hover:scale-110',
              color === c && 'outline outline-2 outline-offset-2 outline-brand',
            )}
            style={{ background: COLORS[c] }}
          />
        ))}
      </div>
      <div className="my-2.5 h-px bg-[hsl(0_0%_18%)]" />
      <div className="grid grid-cols-4 gap-1 text-center text-xs font-semibold">
        {SIZE_NAMES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={size === s}
            onClick={() => editor.setStyle({ size: s })}
            className={cn('rounded-md py-1.5', size === s ? 'bg-white/10 text-foreground' : 'hover:bg-white/5')}
          >
            {s.toUpperCase()}
          </button>
        ))}
      </div>
      {showAlign && (
        <>
          <div className="my-2.5 h-px bg-[hsl(0_0%_18%)]" />
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                ['start', AlignLeft, 'Align left'],
                ['middle', AlignCenter, 'Align center'],
                ['end', AlignRight, 'Align right'],
              ] as const
            ).map(([a, Icon, label]) => (
              <button
                key={a}
                type="button"
                aria-label={label}
                aria-pressed={align === a}
                onClick={() => editor.setStyle({ align: a })}
                className={cn(
                  'inline-flex items-center justify-center rounded-md py-1.5',
                  align === a ? 'bg-white/10 text-foreground' : 'hover:bg-white/5',
                )}
              >
                <Icon className="size-4" aria-hidden />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ZoomControls({ editor, large }: { editor: BoardEditor; large: boolean }): JSX.Element {
  const z = useBoard(editor, (e) => e.camera.z);
  useBoard(editor, (e) => e.version); // canUndo/canRedo are getters
  const btn = cn(
    'inline-flex items-center justify-center rounded-lg hover:bg-white/5 hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent',
    large ? 'size-10' : 'size-8',
  );
  const icon = large ? 'size-5' : 'size-4';
  return (
    <div className={cn(PANEL, 'flex items-center gap-0.5 p-[3px]')}>
      <button type="button" className={btn} aria-label="Undo" title="Undo (Cmd+Z)" disabled={!editor.canUndo} onClick={() => editor.undo()}>
        <Undo2 className={icon} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Redo" title="Redo (Cmd+Shift+Z)" disabled={!editor.canRedo} onClick={() => editor.redo()}>
        <Redo2 className={icon} aria-hidden />
      </button>
      <span className="mx-1 h-[18px] w-px bg-[hsl(0_0%_18%)]" />
      <button type="button" className={btn} aria-label="Zoom out" title="Zoom out (-)" onClick={() => editor.zoomStep(-1)}>
        <Minus className={icon} aria-hidden />
      </button>
      <button
        type="button"
        className="tnum w-12 rounded-lg py-1 text-center text-xs hover:bg-white/5 hover:text-foreground"
        title="Reset to 100% (Shift+0)"
        onClick={() => editor.resetZoom()}
      >
        {Math.round(z * 100)}%
      </button>
      <button type="button" className={btn} aria-label="Zoom in" title="Zoom in (+)" onClick={() => editor.zoomStep(1)}>
        <Plus className={icon} aria-hidden />
      </button>
      <button type="button" className={btn} aria-label="Zoom to fit" title="Zoom to fit (Shift+1)" onClick={() => editor.zoomToFit()}>
        <Scan className={icon} aria-hidden />
      </button>
    </div>
  );
}
