// src/dash/board/InkLayer.tsx
// Committed ink, painted onto ONE screen-space canvas instead of one SVG per
// stroke inside the camera-transformed world layer. WebKit re-rasterizes a
// scaled DOM layer on every pinch frame, so hundreds of SVG paths made iPad
// zooming crawl; refilling cached Path2Ds is cheap at any zoom and stays crisp.
// Ink therefore sits above cards, images and text (annotation layer) rather
// than interleaved by z. Export still renders ink as SVG through ShapeView.
import { useEffect, useRef } from 'react';
import { COLORS, HIGHLIGHTER_OPACITY, rectsIntersect, type InkShape, type Shape } from '@/dash/board/model';
import type { BoardEditor } from '@/dash/board/editor';
import { inkToPathD } from '@/dash/board/inkPath';

/** Keyed by the points array: a translate keeps it, so a drag never re-tessellates. */
const paths = new WeakMap<InkShape['points'], { key: string; path: Path2D }>();

function inkPath(s: InkShape): Path2D {
  const key = `${s.size}${s.highlighter ? 'h' : ''}`;
  const hit = paths.get(s.points);
  if (hit && hit.key === key) return hit.path;
  const path = new Path2D(inkToPathD(s));
  paths.set(s.points, { key, path });
  return path;
}

export function InkLayer({ editor, width, height }: { editor: BoardEditor; width: number; height: number }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width <= 0 || height <= 0 || typeof Path2D !== 'function') return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let painted: { camera: BoardEditor['camera']; order: BoardEditor['order']; erase: BoardEditor['pendingErase'] } | null = null;
    let raf: number | null = null;
    let deferred = false;

    const draw = (s: Shape, view: ReturnType<BoardEditor['viewPageRect']>): void => {
      if (s.type !== 'ink' || !rectsIntersect(view, s)) return;
      const { x: cx, y: cy, z } = editor.camera;
      ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (cx + s.x * z), dpr * (cy + s.y * z));
      ctx.globalAlpha = (s.highlighter ? HIGHLIGHTER_OPACITY : 1) * (editor.pendingErase.has(s.id) ? 0.3 : 1);
      ctx.fillStyle = COLORS[s.color];
      ctx.fill(inkPath(s));
    };
    /** The common commit: same camera, one shape appended on top. */
    const appendedOne = (prev: BoardEditor['order'], next: BoardEditor['order']): boolean => {
      if (next.length !== prev.length + 1) return false;
      for (let i = 0; i < prev.length; i += 1) if (prev[i] !== next[i]) return false;
      return true;
    };

    const paint = (): void => {
      raf = null;
      // Never repaint the whole layer under a live stroke: it would compete
      // with the Pencil for the frame. Catch up once the stroke ends.
      if (painted && editor.live.stroke) {
        deferred = true;
        return;
      }
      deferred = false;
      const { camera, order, pendingErase } = editor;
      if (painted && painted.camera === camera && painted.order === order && painted.erase === pendingErase) return;
      const view = editor.viewPageRect();
      if (painted && painted.camera === camera && painted.erase === pendingErase && appendedOne(painted.order, order)) {
        draw(order[order.length - 1], view);
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const s of order) draw(s, view);
      }
      ctx.globalAlpha = 1;
      painted = { camera, order, erase: pendingErase };
    };
    const schedule = (): void => {
      if (raf == null) raf = requestAnimationFrame(paint);
    };
    paint();
    const unsub = editor.subscribe(schedule);
    const unsubLive = editor.subscribeLive(() => {
      if (deferred && !editor.live.stroke) schedule();
    });
    return () => {
      unsub();
      unsubLive();
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [editor, width, height]);

  return <canvas ref={ref} aria-hidden style={{ position: 'absolute', inset: 0, width, height, pointerEvents: 'none' }} />;
}
