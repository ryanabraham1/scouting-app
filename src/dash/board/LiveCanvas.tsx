// src/dash/board/LiveCanvas.tsx
// Screen-space canvases for everything that changes every frame and must never
// go through React: the in-progress stroke (painted INCREMENTALLY, only the new
// tail each frame, the same quadratic-midpoint trick as FieldWhiteboard so ink
// never trails the Pencil), laser trails, the eraser ring, and remote
// collaborators' in-progress strokes (P3).
import { useEffect, useRef } from 'react';
import { COLORS, HIGHLIGHTER_OPACITY, HIGHLIGHTER_SCALE, INK_SIZE } from '@/dash/board/model';
import { LASER_FADE_MS, type BoardEditor } from '@/dash/board/editor';

export interface RemoteStroke {
  points: [number, number, number][];
  color: string;
  diameter: number;
  highlighter: boolean;
}

export interface LiveCanvasProps {
  editor: BoardEditor;
  width: number;
  height: number;
  /** Extra per-frame painters (remote strokes/laser in P3). */
  remote?: { strokes: () => Iterable<RemoteStroke>; laser: () => Iterable<{ color: string; pts: { x: number; y: number; t: number }[] }> };
}

function setupCanvas(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d', { desynchronized: true });
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function LiveCanvas({ editor, width, height, remote }: LiveCanvasProps): JSX.Element {
  const inkRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const inkCanvas = inkRef.current;
    const fxCanvas = fxRef.current;
    if (!inkCanvas || !fxCanvas || width <= 0 || height <= 0) return;
    const ink = setupCanvas(inkCanvas, width, height);
    const fx = setupCanvas(fxCanvas, width, height);
    if (!ink || !fx) return;
    let rendered = 0;
    let inkCamera = editor.camera;
    let fxPainted = false;
    let strokeRef: unknown = null;
    let raf: number | null = null;

    const drawInk = (): void => {
      const s = editor.live.stroke;
      if (s !== strokeRef || (s && inkCamera !== editor.camera)) {
        inkCamera = editor.camera;
        ink.clearRect(0, 0, width, height);
        rendered = 0;
        strokeRef = s;
        inkCanvas.style.opacity = s?.highlighter ? String(HIGHLIGHTER_OPACITY) : '1';
      }
      if (!s) return;
      const { x: cx, y: cy, z } = editor.camera;
      const pts = s.points;
      const base = INK_SIZE[s.size] * (s.highlighter ? HIGHLIGHTER_SCALE : 1) * z;
      ink.strokeStyle = COLORS[s.color];
      ink.fillStyle = COLORS[s.color];
      ink.lineCap = 'round';
      ink.lineJoin = 'round';
      const X = (i: number): number => pts[i][0] * z + cx;
      const Y = (i: number): number => pts[i][1] * z + cy;
      const width_ = (p: number): number => (s.highlighter ? base : base * (0.6 + 0.8 * p));
      let start = rendered;
      if (start === 0 && pts.length > 0) {
        ink.beginPath();
        ink.arc(X(0), Y(0), width_(pts[0][2]) / 2, 0, Math.PI * 2);
        ink.fill();
        start = 1;
      }
      for (let i = start; i < pts.length; i += 1) {
        const mx = (X(i - 1) + X(i)) / 2;
        const my = (Y(i - 1) + Y(i)) / 2;
        ink.lineWidth = width_((pts[i - 1][2] + pts[i][2]) / 2);
        ink.beginPath();
        if (i === 1) {
          ink.moveTo(X(0), Y(0));
          ink.lineTo(mx, my);
        } else {
          ink.moveTo((X(i - 2) + X(i - 1)) / 2, (Y(i - 2) + Y(i - 1)) / 2);
          ink.quadraticCurveTo(X(i - 1), Y(i - 1), mx, my);
        }
        ink.stroke();
      }
      rendered = pts.length;
    };

    const drawFx = (now: number): boolean => {
      const remoteLasers = remote ? [...remote.laser()] : [];
      const remoteStrokes = remote ? [...remote.strokes()] : [];
      const active = !!editor.live.stroke || editor.live.laser.length > 0 || !!editor.live.eraser || remoteLasers.some((l) => l.pts.length > 0) || remoteStrokes.length > 0;
      if (!active && !fxPainted) return false;
      fx.clearRect(0, 0, width, height);
      fxPainted = active;
      const { x: cx, y: cy, z } = editor.camera;
      let animating = false;
      // The permanent incremental ink ends at the final midpoint. Paint its
      // short, replaceable tail separately so it reaches the latest input,
      // without clearing/replaying the whole stroke on every frame.
      const stroke = editor.live.stroke;
      if (stroke && stroke.points.length > 1) {
        const pts = stroke.points;
        const a = pts[pts.length - 2];
        const b = pts[pts.length - 1];
        const base = INK_SIZE[stroke.size] * (stroke.highlighter ? HIGHLIGHTER_SCALE : 1) * z;
        fx.strokeStyle = COLORS[stroke.color];
        fx.globalAlpha = stroke.highlighter ? HIGHLIGHTER_OPACITY : 1;
        fx.lineCap = 'round';
        fx.lineWidth = stroke.highlighter ? base : base * (0.6 + 0.8 * b[2]);
        fx.beginPath();
        fx.moveTo((a[0] + b[0]) / 2 * z + cx, (a[1] + b[1]) / 2 * z + cy);
        fx.lineTo(b[0] * z + cx, b[1] * z + cy);
        fx.stroke();
        fx.globalAlpha = 1;
      }

      const drawTrail = (trail: { x: number; y: number; t: number }[], color: string): void => {
        if (trail.length < 2) return;
        fx.lineCap = 'round';
        fx.lineJoin = 'round';
        for (let i = 1; i < trail.length; i += 1) {
          const age = (now - trail[i].t) / LASER_FADE_MS;
          if (age >= 1) continue;
          fx.globalAlpha = 1 - age;
          fx.strokeStyle = color;
          fx.lineWidth = 5;
          fx.shadowColor = color;
          fx.shadowBlur = 10;
          fx.beginPath();
          fx.moveTo(trail[i - 1].x * z + cx, trail[i - 1].y * z + cy);
          fx.lineTo(trail[i].x * z + cx, trail[i].y * z + cy);
          fx.stroke();
        }
        fx.globalAlpha = 1;
        fx.shadowBlur = 0;
      };
      if (editor.pruneLaser(now)) {
        drawTrail(editor.live.laser, '#f43f5e');
        animating = true;
      }
      if (remote) {
        for (const l of remoteLasers) {
          if (l.pts.length) {
            drawTrail(l.pts, l.color);
            animating = true;
          }
        }
        for (const s of remoteStrokes) {
          if (s.points.length === 0) continue;
          fx.globalAlpha = s.highlighter ? HIGHLIGHTER_OPACITY : 1;
          fx.strokeStyle = s.color;
          fx.lineCap = 'round';
          fx.lineJoin = 'round';
          fx.lineWidth = s.diameter * z;
          fx.beginPath();
          fx.moveTo(s.points[0][0] * z + cx, s.points[0][1] * z + cy);
          for (let i = 1; i < s.points.length; i += 1) {
            fx.lineTo(s.points[i][0] * z + cx, s.points[i][1] * z + cy);
          }
          fx.stroke();
          fx.globalAlpha = 1;
        }
      }
      const e = editor.live.eraser;
      if (e) {
        fx.strokeStyle = 'rgba(250,250,250,0.85)';
        fx.fillStyle = 'rgba(250,250,250,0.08)';
        fx.lineWidth = 1.5;
        fx.beginPath();
        fx.arc(e.x * z + cx, e.y * z + cy, 10, 0, Math.PI * 2);
        fx.fill();
        fx.stroke();
      }
      return animating;
    };

    const frame = (): void => {
      raf = null;
      drawInk();
      if (drawFx(performance.now())) schedule();
    };
    const schedule = (): void => {
      if (raf == null) raf = requestAnimationFrame(frame);
    };
    const unsubLive = editor.subscribeLive(schedule);
    // Camera moves (pinch mid-laser, remote updates) also need a repaint.
    let camera = editor.camera;
    const unsub = editor.subscribe(() => {
      if (camera === editor.camera) return;
      camera = editor.camera;
      if (editor.live.stroke || editor.live.eraser || editor.live.laser.length || fxPainted) {
        drawInk();
        if (drawFx(performance.now())) schedule();
      }
    });
    schedule();
    return () => {
      unsubLive();
      unsub();
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [editor, width, height, remote]);

  const style = { position: 'absolute' as const, inset: 0, width, height, pointerEvents: 'none' as const };
  return (
    <>
      <canvas ref={inkRef} style={style} aria-hidden />
      <canvas ref={fxRef} style={style} aria-hidden />
    </>
  );
}
