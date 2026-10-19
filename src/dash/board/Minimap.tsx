// src/dash/board/Minimap.tsx
// Overview of the whole board: shapes as blocks plus the viewport rectangle.
// Click or drag to move the view there. Repaints at most once per frame.
import { useEffect, useRef } from 'react';
import type { BoardEditor } from '@/dash/board/editor';
import { COLORS, unionRects, type Rect } from '@/dash/board/model';
import { cn } from '@/lib/utils';
import { PANEL } from '@/dash/board/BoardChrome';

const W = 180;
const H = 112;
const PAD = 8;

function worldRect(editor: BoardEditor, bounds: Rect | null): Rect {
  const view = editor.viewPageRect();
  const all = unionRects(bounds ? [view, bounds] : [view])!;
  const m = Math.max(all.w, all.h) * 0.06;
  return { x: all.x - m, y: all.y - m, w: all.w + m * 2, h: all.h + m * 2 };
}

export function Minimap({ editor }: { editor: BoardEditor }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<{ world: Rect; scale: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    let raf: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastDraw = 0;
    let order = editor.order;
    let bounds = unionRects(order);
    const draw = (): void => {
      raf = null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      lastDraw = performance.now();
      if (order !== editor.order) { order = editor.order; bounds = unionRects(order); }
      const world = worldRect(editor, bounds);
      const scale = Math.min((W - PAD * 2) / world.w, (H - PAD * 2) / world.h);
      const ox = (W - world.w * scale) / 2;
      const oy = (H - world.h * scale) / 2;
      mapRef.current = { world, scale, ox, oy };
      const tx = (x: number): number => ox + (x - world.x) * scale;
      const ty = (y: number): number => oy + (y - world.y) * scale;
      for (const s of editor.order) {
        ctx.fillStyle =
          s.type === 'ink' || s.type === 'text' ? COLORS[s.color] + '66' : 'hsl(0 0% 22%)';
        ctx.fillRect(tx(s.x), ty(s.y), Math.max(1.5, s.w * scale), Math.max(1.5, s.h * scale));
      }
      const v = editor.viewPageRect();
      ctx.strokeStyle = 'hsl(199 89% 48%)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tx(v.x), ty(v.y), v.w * scale, v.h * scale);
    };
    const schedule = (): void => {
      if (raf != null || timer != null) return;
      const remaining = order === editor.order ? 80 - (performance.now() - lastDraw) : 0;
      if (remaining > 0) timer = setTimeout(() => { timer = null; raf = requestAnimationFrame(draw); }, remaining);
      else raf = requestAnimationFrame(draw);
    };
    const unsub = editor.subscribe(schedule);
    schedule();
    return () => {
      unsub();
      if (raf != null) cancelAnimationFrame(raf);
      if (timer != null) clearTimeout(timer);
    };
  }, [editor]);

  const jump = (clientX: number, clientY: number): void => {
    const c = ref.current;
    const m = mapRef.current;
    if (!c || !m) return;
    const r = c.getBoundingClientRect();
    editor.centerOn({
      x: m.world.x + (clientX - r.left - m.ox) / m.scale,
      y: m.world.y + (clientY - r.top - m.oy) / m.scale,
    });
  };

  return (
    <div className={cn(PANEL, 'overflow-hidden p-0')}>
      <canvas
        ref={ref}
        style={{ width: W, height: H, display: 'block', cursor: 'pointer', touchAction: 'none' }}
        aria-label="Board overview"
        role="img"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          jump(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.buttons) jump(e.clientX, e.clientY);
        }}
      />
    </div>
  );
}
