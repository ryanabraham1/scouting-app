// src/dash/board/SelectionOverlay.tsx
// Screen-space SVG over the world layer: selection outline + 8 resize handles
// (constant size at any zoom), per-shape outlines for multi-select, and the
// marquee rectangle.
import { useBoard } from '@/dash/board/useBoard';
import type { BoardEditor } from '@/dash/board/editor';
import { unionRects, shapeRect } from '@/dash/board/model';

const BRAND = 'hsl(199 89% 48%)';

export function SelectionOverlay({
  editor,
  width,
  height,
  handleSize,
}: {
  editor: BoardEditor;
  width: number;
  height: number;
  handleSize: number;
}): JSX.Element | null {
  const camera = useBoard(editor, (e) => e.camera);
  const selection = useBoard(editor, (e) => e.selection);
  const shapes = useBoard(editor, (e) => e.shapes);
  const marquee = useBoard(editor, (e) => e.marquee);
  const editingId = useBoard(editor, (e) => e.editingId);
  const tool = useBoard(editor, (e) => e.tool);

  const sel = [...selection].map((id) => shapes.get(id)).filter((s) => s != null);
  const bounds = unionRects(sel.map(shapeRect));
  const { x: cx, y: cy, z } = camera;
  const toScreen = (r: { x: number; y: number; w: number; h: number }) => ({
    x: r.x * z + cx,
    y: r.y * z + cy,
    w: r.w * z,
    h: r.h * z,
  });

  if (!bounds && !marquee) return null;
  const locked = sel.length > 0 && sel.every((s) => s.locked);
  const showHandles = bounds && tool === 'select' && !editingId && !locked;
  const b = bounds ? toScreen(bounds) : null;
  const pad = 4;
  const hs = handleSize;
  const handles = b
    ? [
        [b.x - pad, b.y - pad],
        [b.x + b.w / 2, b.y - pad],
        [b.x + b.w + pad, b.y - pad],
        [b.x + b.w + pad, b.y + b.h / 2],
        [b.x + b.w + pad, b.y + b.h + pad],
        [b.x + b.w / 2, b.y + b.h + pad],
        [b.x - pad, b.y + b.h + pad],
        [b.x - pad, b.y + b.h / 2],
      ]
    : [];

  return (
    <svg
      width={width}
      height={height}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
      aria-hidden
    >
      {sel.length > 1 &&
        sel.map((s) => {
          const r = toScreen(shapeRect(s));
          return (
            <rect key={s.id} x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke={BRAND} strokeOpacity={0.45} strokeWidth={1} />
          );
        })}
      {b && (
        <rect
          x={b.x - pad}
          y={b.y - pad}
          width={b.w + pad * 2}
          height={b.h + pad * 2}
          rx={4}
          fill="none"
          stroke={BRAND}
          strokeWidth={1.5}
          strokeDasharray={locked ? '4 3' : undefined}
        />
      )}
      {showHandles &&
        handles.map(([x, y], i) => (
          <rect
            key={i}
            x={x - hs / 2}
            y={y - hs / 2}
            width={hs}
            height={hs}
            rx={2}
            fill="#fafafa"
            stroke={BRAND}
            strokeWidth={1.5}
          />
        ))}
      {marquee &&
        (() => {
          const m = toScreen(marquee);
          return <rect x={m.x} y={m.y} width={m.w} height={m.h} fill={BRAND} fillOpacity={0.08} stroke={BRAND} strokeWidth={1} />;
        })()}
    </svg>
  );
}
