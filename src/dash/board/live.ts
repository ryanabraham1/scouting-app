// src/dash/board/live.ts
// Live multiplayer for Ryan's Board over one Supabase Realtime channel:
//   - postgres_changes on board_record -> editor.applyRemote (durable records)
//   - broadcast: cursors, in-progress ink, laser, drag previews (ephemeral,
//     never stored) so collaborators see each other draw in real time
//   - presence: who is on the board (name + color)
// Plan: docs/plans/ryans-board/README.md §9.
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import {
  COLORS,
  HIGHLIGHTER_SCALE,
  INK_SIZE,
  parseRecord,
  translateShape,
  type ColorName,
  type Point,
  type Shape,
  type SizeName,
} from '@/dash/board/model';
import type { BoardEditor, LaserPoint } from '@/dash/board/editor';
import type { RemoteStroke } from '@/dash/board/LiveCanvas';

const SEND_MS = 50;
const CURSOR_IDLE_MS = 4000;
const STROKE_TTL_MS = 8000;
const LASER_TTL_MS = 1200;
const NAME_KEY = 'ryans-board-name';

export const PEER_COLORS: readonly ColorName[] = ['blue', 'green', 'violet', 'pink', 'orange', 'teal'];

export function peerColor(clientId: string): ColorName {
  let h = 0;
  for (let i = 0; i < clientId.length; i += 1) h = (h * 31 + clientId.charCodeAt(i)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length];
}

export function loadDisplayName(): string {
  try {
    return localStorage.getItem(NAME_KEY)?.trim() || 'Guest';
  } catch {
    return 'Guest';
  }
}

export function saveDisplayName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.trim().slice(0, 32));
  } catch {
    // per-device convenience only
  }
}

export interface Peer {
  clientId: string;
  name: string;
  color: ColorName;
  cursor: Point | null;
  cursorAt: number;
  selection: string[];
}

interface LiveStrokeMsg {
  c: string;
  id: string;
  color: ColorName;
  size: SizeName;
  hl: boolean;
  /** Index of pts[0] in the full stroke (lets a late joiner/dropped packet resync). */
  from: number;
  pts: [number, number, number][];
  done?: boolean;
}

export class BoardLive {
  peers = new Map<string, Peer>();
  version = 0;
  private channel: RealtimeChannel | null = null;
  private listeners = new Set<() => void>();
  private strokes = new Map<string, { s: RemoteStroke; at: number; c: string; done: boolean }>();
  private lasers = new Map<string, { pts: LaserPoint[]; color: string }>();
  private previewBase = new Map<string, Shape>();
  private disposers: (() => void)[] = [];
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: Point | null | undefined;
  private sentStrokeId: string | null = null;
  private sentStrokeLen = 0;
  private sentLaserT = 0;
  private lastDragKey = '';
  private connected = false;
  name: string;
  readonly color: ColorName;

  constructor(
    private readonly editor: BoardEditor,
    private readonly boardKey: string,
  ) {
    this.name = loadDisplayName();
    this.color = peerColor(editor.clientId);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    const me = this.editor.clientId;
    const ch = supabase.channel(`board:${this.boardKey}`, {
      config: { broadcast: { self: false, ack: false }, presence: { key: me } },
    });
    this.channel = ch;

    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'board_record', filter: `board_key=eq.${this.boardKey}` },
      (payload) => {
        const row = (payload.new ?? null) as { data?: unknown } | null;
        const rec = row ? parseRecord(row.data) : null;
        if (!rec) return;
        this.previewBase.delete(rec.id);
        this.strokes.delete(rec.id);
        this.editor.applyRemote([rec]);
      },
    );

    ch.on('broadcast', { event: 'cursor' }, ({ payload }) => {
      const p = payload as { c: string; x: number | null; y: number | null; sel?: string[] };
      const peer = this.peers.get(p.c);
      if (!peer) return;
      peer.cursor = p.x == null || p.y == null ? null : { x: p.x, y: p.y };
      peer.cursorAt = Date.now();
      if (p.sel) peer.selection = p.sel;
      this.emit();
    });

    ch.on('broadcast', { event: 'ink' }, ({ payload }) => {
      const m = payload as LiveStrokeMsg;
      if (this.editor.shapes.has(m.id)) return; // already landed
      let entry = this.strokes.get(m.id);
      if (!entry) {
        entry = {
          s: {
            points: [],
            color: COLORS[m.color] ?? COLORS.white,
            diameter: INK_SIZE[m.size] * (m.hl ? HIGHLIGHTER_SCALE : 1),
            highlighter: m.hl,
          },
          at: Date.now(),
          c: m.c,
          done: false,
        };
        this.strokes.set(m.id, entry);
      }
      // Append in order; a gap (dropped packet) just draws a straight join.
      const pts = entry.s.points;
      if (m.from >= pts.length) pts.push(...m.pts);
      else pts.splice(m.from, pts.length - m.from, ...m.pts);
      entry.at = Date.now();
      entry.done = !!m.done;
      this.editor.repaintLive();
    });

    ch.on('broadcast', { event: 'laser' }, ({ payload }) => {
      const m = payload as { c: string; pts: LaserPoint[] };
      const now = performance.now();
      const entry = this.lasers.get(m.c) ?? { pts: [], color: COLORS[this.peers.get(m.c)?.color ?? 'pink'] };
      // Re-time to the local clock so fading is consistent.
      for (const p of m.pts) entry.pts.push({ x: p.x, y: p.y, t: now });
      this.lasers.set(m.c, entry);
      this.editor.repaintLive();
    });

    ch.on('broadcast', { event: 'drag' }, ({ payload }) => {
      const m = payload as { c: string; ids: string[]; dx: number; dy: number; end?: boolean };
      if (m.end) {
        // The records follow through postgres_changes; keep the preview until then.
        return;
      }
      const moved: Shape[] = [];
      for (const id of m.ids.slice(0, 300)) {
        const base = this.previewBase.get(id) ?? this.editor.shapes.get(id);
        if (!base) continue;
        if (!this.previewBase.has(id)) this.previewBase.set(id, base);
        moved.push(translateShape(base, m.dx, m.dy));
      }
      this.editor.applyPreview(moved);
    });

    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState<{ name?: string; color?: ColorName }>();
      const next = new Map<string, Peer>();
      for (const [key, metas] of Object.entries(state)) {
        if (key === me) continue;
        const meta = metas[metas.length - 1];
        const prev = this.peers.get(key);
        next.set(key, {
          clientId: key,
          name: meta?.name || 'Guest',
          color: meta?.color ?? peerColor(key),
          cursor: prev?.cursor ?? null,
          cursorAt: prev?.cursorAt ?? 0,
          selection: prev?.selection ?? [],
        });
      }
      this.peers = next;
      this.emit();
    });

    ch.subscribe((status) => {
      this.connected = status === 'SUBSCRIBED';
      if (this.connected) void ch.track({ name: this.name, color: this.color });
      this.emit();
    });

    // Outgoing: ink, laser and drags ride the editor's live channel.
    this.disposers.push(this.editor.subscribeLive(() => this.scheduleSend()));
    // Expire stale remote strokes/cursors.
    const sweep = setInterval(() => this.sweep(), 1000);
    this.disposers.push(() => clearInterval(sweep));
  }

  setName(name: string): void {
    this.name = name.trim().slice(0, 32) || 'Guest';
    saveDisplayName(this.name);
    if (this.connected) void this.channel?.track({ name: this.name, color: this.color });
    this.emit();
  }

  /** Our pointer in page coords (null when it leaves the board). */
  setCursor(p: Point | null): void {
    this.pendingCursor = p;
    this.scheduleSend();
  }

  private scheduleSend(): void {
    if (this.sendTimer) return;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.flushSend();
    }, SEND_MS);
  }

  private send(event: string, payload: Record<string, unknown>): void {
    if (!this.connected || !this.channel) return;
    void this.channel.send({ type: 'broadcast', event, payload });
  }

  private flushSend(): void {
    const me = this.editor.clientId;
    if (this.pendingCursor !== undefined) {
      const p = this.pendingCursor;
      this.pendingCursor = undefined;
      this.send('cursor', { c: me, x: p?.x ?? null, y: p?.y ?? null, sel: [...this.editor.selection].slice(0, 100) });
    }
    const stroke = this.editor.live.stroke;
    if (stroke) {
      if (stroke.id !== this.sentStrokeId) {
        this.sentStrokeId = stroke.id;
        this.sentStrokeLen = 0;
      }
      if (stroke.points.length > this.sentStrokeLen) {
        this.send('ink', {
          c: me,
          id: stroke.id,
          color: stroke.color,
          size: stroke.size,
          hl: stroke.highlighter,
          from: this.sentStrokeLen,
          pts: stroke.points.slice(this.sentStrokeLen).map(([x, y, p]) => [round1(x), round1(y), round2(p)]),
        });
        this.sentStrokeLen = stroke.points.length;
      }
    } else if (this.sentStrokeId) {
      this.send('ink', { c: me, id: this.sentStrokeId, color: 'white', size: 'm', hl: false, from: this.sentStrokeLen, pts: [], done: true });
      this.sentStrokeId = null;
      this.sentStrokeLen = 0;
    }
    // Laser points are pruned from the front as they fade, so track by time.
    const fresh = this.editor.live.laser.filter((p) => p.t > this.sentLaserT);
    if (fresh.length) {
      this.sentLaserT = fresh[fresh.length - 1].t;
      this.send('laser', { c: me, pts: fresh.map((p) => ({ x: round1(p.x), y: round1(p.y), t: 0 })) });
    }
    const drag = this.editor.live.drag;
    if (drag) {
      const key = `${drag.dx.toFixed(1)},${drag.dy.toFixed(1)}`;
      if (key !== this.lastDragKey) {
        this.lastDragKey = key;
        this.send('drag', { c: me, ids: drag.ids.slice(0, 300), dx: drag.dx, dy: drag.dy });
      }
    } else if (this.lastDragKey) {
      this.lastDragKey = '';
      this.send('drag', { c: me, ids: [], dx: 0, dy: 0, end: true });
    }
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, e] of this.strokes) {
      if (this.editor.shapes.has(id) || now - e.at > (e.done ? 3000 : STROKE_TTL_MS)) {
        this.strokes.delete(id);
        changed = true;
      }
    }
    for (const p of this.peers.values()) {
      if (p.cursor && now - p.cursorAt > CURSOR_IDLE_MS) {
        p.cursor = null;
        changed = true;
      }
    }
    const t = performance.now();
    for (const [c, l] of this.lasers) {
      l.pts = l.pts.filter((p) => t - p.t < LASER_TTL_MS);
      if (!l.pts.length) this.lasers.delete(c);
    }
    if (changed) {
      this.emit();
      this.editor.repaintLive();
    }
  }

  /** Painters for LiveCanvas. */
  readonly remote = {
    strokes: (): Iterable<RemoteStroke> => {
      for (const [id] of this.strokes) if (this.editor.shapes.has(id)) this.strokes.delete(id);
      return [...this.strokes.values()].map((e) => e.s);
    },
    laser: (): Iterable<{ color: string; pts: LaserPoint[] }> => {
      const t = performance.now();
      for (const l of this.lasers.values()) l.pts = l.pts.filter((p) => t - p.t < LASER_TTL_MS);
      return this.lasers.values();
    },
  };

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
    this.connected = false;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
