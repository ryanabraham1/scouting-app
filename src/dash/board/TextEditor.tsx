// src/dash/board/TextEditor.tsx
// The in-place text editing overlay: a borderless textarea positioned over the
// shape in screen space, matching its font at the current zoom. Commits on blur
// or Escape (Escape commits, as most whiteboards do); empty text deletes.
import { useLayoutEffect, useRef, useState } from 'react';
import { useBoard } from '@/dash/board/useBoard';
import type { BoardEditor } from '@/dash/board/editor';
import { COLORS, FONT_SIZE, TEXT_LINE_HEIGHT, type TextShape } from '@/dash/board/model';
import { TEXT_FONT_FAMILY } from '@/dash/board/measureText';

export function TextEditor({ editor }: { editor: BoardEditor }): JSX.Element | null {
  const editingId = useBoard(editor, (e) => e.editingId);
  const shape = useBoard(editor, (e) => (e.editingId ? e.shapes.get(e.editingId) : undefined));
  if (!editingId || !shape || shape.type !== 'text') return null;
  return <Editor key={editingId} editor={editor} shape={shape} />;
}

function Editor({ editor, shape }: { editor: BoardEditor; shape: TextShape }): JSX.Element {
  const camera = useBoard(editor, (e) => e.camera);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(shape.text);
  const committed = useRef(false);

  const commit = (): void => {
    if (committed.current) return;
    committed.current = true;
    editor.commitText(shape.id, value);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const focus = (): void => {
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    };
    focus();
    // The press that opened the editor may still move focus once; reclaim it.
    const t = setTimeout(() => {
      if (document.activeElement !== el && !committed.current) focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, camera.z]);

  const { x: cx, y: cy, z } = camera;
  return (
    <textarea
      ref={ref}
      value={value}
      aria-label="Text"
      spellCheck
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
          e.preventDefault();
          ref.current?.blur();
        }
      }}
      style={{
        position: 'absolute',
        left: shape.x * z + cx,
        top: shape.y * z + cy,
        width: shape.w * z,
        fontSize: FONT_SIZE[shape.size] * z,
        lineHeight: TEXT_LINE_HEIGHT,
        fontFamily: TEXT_FONT_FAMILY,
        fontWeight: 500,
        color: COLORS[shape.color],
        textAlign: shape.align === 'middle' ? 'center' : shape.align === 'end' ? 'right' : 'left',
        background: 'transparent',
        border: 'none',
        outline: 'none',
        padding: 0,
        margin: 0,
        resize: 'none',
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        caretColor: 'hsl(199 89% 48%)',
        zIndex: 20,
      }}
    />
  );
}
